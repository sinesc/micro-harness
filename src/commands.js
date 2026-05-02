export class CommandError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CommandError';
    }
}

export class Command {
    constructor(application) {
        this.application = application;
    }

    get livepruneEnabled() {
        return this.application.livepruneRef.value;
    }

    async help() {
        return `Available commands:\n/exit - Exit the harness\n/models - List available models\n/model <index or name> - Switch to a model\n/tool <name> <json args> - Execute a tool\n/context - Show context statistics\n/liveprune - Toggle live pruning of stale context (currently ${this.livepruneEnabled ? 'ON' : 'OFF'})\n/reset - Clear current context (keeping only system prompt)`;
    }

    toggleLiveprune() {
        this.application.livepruneRef.value = !this.application.livepruneRef.value;
        return `Live pruning is now ${this.application.livepruneRef.value ? 'ON' : 'OFF'}.`;
    }

    async exit() {
        await this.application.saveContext(this.application.messages);
    }

    async models() {
        try {
            const res = await fetch(`${this.application.lmStudioUrl}/v1/models`);
            if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
            const data = await res.json();
            const apiModels = (data.data?.map(m => m.id) || []).sort();
            return `📋 Available Models:\n${apiModels.map((m, i) => `  ${i}. ${m}`).join('\n')}`;
        } catch (err) {
            throw new CommandError(`Failed to fetch models: ${err.message}`);
        }
    }

    async model(args) {
        if (!args) {
            return `Current model: ${this.application.currentModel}`;
        }
        try {
            const res = await fetch(`${this.application.lmStudioUrl}/v1/models`);
            if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
            const data = await res.json();
            const apiModels = (data.data?.map(m => m.id) || []).sort();
            const models = ['local-model', ...apiModels];

            // Check if args is a valid index
            const index = parseInt(args, 10);
            let selectedModel = null;
            if (!isNaN(index) && index >= 0 && index < models.length) {
                selectedModel = models[index];
            } else if (models.includes(args)) {
                selectedModel = args;
            }

            if (selectedModel) {
                this.application.currentModel = selectedModel;
                return `✅ Switched to model: ${selectedModel}`;
            } else {
                throw new CommandError(`Invalid model or index. Use /models to see available options.`);
            }
        } catch (err) {
            if (err instanceof CommandError) throw err;
            throw new CommandError(`Failed to fetch models: ${err.message}`);
        }
    }

    async tool(toolName, args) {
        const result = await this.application.tool.exec(toolName, args);
        return `🔧 ${toolName} output:\n${result}`;
    }

    async context() {
        const messages = this.application.messages;
        const fullCount = messages.length;
        const prunedMessages = this.application.pruneContextForAPI(messages);
        const prunedCount = prunedMessages.length;
        const removedCount = fullCount - prunedCount;

        // Count read_file results (unique files)
        const readFiles = new Set();
        for (const msg of messages) {
            if (msg.role === 'tool' && msg.content !== null && msg.content !== undefined) {
                // Find the corresponding tool call
                for (let j = messages.indexOf(msg) - 1; j >= 0; j--) {
                    if (messages[j].role === 'assistant' && messages[j].tool_calls) {
                        for (const tc of messages[j].tool_calls) {
                            if (tc.id === msg.tool_call_id && tc.function.name === 'read_file') {
                                const args = JSON.parse(tc.function.arguments);
                                if (args && args.path) {
                                    readFiles.add(args.path);
                                }
                                break;
                            }
                        }
                        break;
                    }
                }
            }
        }

        // Count tool calls by type
        const toolCallCounts = {};
        for (const msg of messages) {
            if (msg.role === 'assistant' && msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    toolCallCounts[tc.function.name] = (toolCallCounts[tc.function.name] || 0) + 1;
                }
            }
        }

        // Count roles
        const roleCounts = {};
        for (const msg of messages) {
            roleCounts[msg.role] = (roleCounts[msg.role] || 0) + 1;
        }

        // Estimate token counts
        const fullTokens = messages.reduce((sum, msg) => sum + (msg.content || '').length / 4, 0);
        const prunedTokens = prunedMessages.reduce((sum, msg) => sum + (msg.content || '').length / 4, 0);

        let output = `📊 Context Statistics:\n\n`;
        output += `  Messages: ${fullCount} (full) → ${prunedCount} (pruned) | Removed: ${removedCount}\n`;
        output += `  Estimated tokens: ${Math.round(fullTokens)} (full) → ${Math.round(prunedTokens)} (pruned)\n\n`;

        output += `  Role breakdown:\n`;
        for (const [role, count] of Object.entries(roleCounts).sort((a, b) => b[1] - a[1])) {
            const icon = { system: '🤖', user: '👤', assistant: '🤖', tool: '🔧' }[role] || role;
            output += `    ${icon} ${role}: ${count}\n`;
        }

        output += `\n  Files read: ${readFiles.size}\n`;
        if (readFiles.size > 0) {
            output += `    ${[...readFiles].join(', ')}\n`;
        }

        output += `\n  Tool calls by type:\n`;
        for (const [tool, count] of Object.entries(toolCallCounts).sort((a, b) => b[1] - a[1])) {
            output += `    ${tool}: ${count}\n`;
        }

        return output;
    }

    async reset() {
        // Keep only the system prompt (first message)
        while (this.application.messages.length > 1) {
            this.application.messages.pop();
        }
        await this.application.saveContext(this.application.messages);
        return '✅ Context cleared.';
    }

    async exec(cmd, args) {
        switch (cmd) {
            case 'exit':
                await this.exit();
                return 'exit';
            case 'help':
                return await this.help();
            case 'models':
                return await this.models();
            case 'model':
                return await this.model(args);
            case 'tool':
                if (!args) {
                    throw new CommandError('Tool name is required. Usage: /tool <name> <json args>');
                }
                const [name, ...rest] = args.split(' ');
                const jsonStr = rest.join(' ');
                try {
                    const parsedArgs = JSON.parse(jsonStr);
                    return await this.tool(name, parsedArgs);
                } catch (err) {
                    throw new CommandError(`Failed to parse tool arguments: ${err.message}`);
                }
            case 'liveprune':
                return this.toggleLiveprune();
            case 'context':
                return await this.context();
            case 'reset':
                return await this.reset();
            default:
                throw new CommandError(`Unrecognized command: /${cmd}`);
        }
    }
}