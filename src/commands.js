export class CommandError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CommandError';
    }
}

export class Command {
    constructor({ tool, saveContext, pruneContext, livepruneRef }) {
        this.tool = tool;
        this._saveContext = saveContext;
        this._pruneContext = pruneContext;
        this._livepruneRef = livepruneRef || { value: false };
    }

    get livepruneEnabled() {
        return this._livepruneRef.value;
    }

    async help() {
        return `Available commands:\n/exit - Exit the harness\n/models - List available models\n/model <index or name> - Switch to a model\n/tool <name> <json args> - Execute a tool\n/context - Show context statistics\n/liveprune - Toggle live pruning of stale context (currently ${this.livepruneEnabled ? 'ON' : 'OFF'})`;
    }

    toggleLiveprune() {
        this._livepruneRef.value = !this._livepruneRef.value;
        return `Live pruning is now ${this._livepruneRef.value ? 'ON' : 'OFF'}.`;
    }
    
    async exit(messages) {
        await this._saveContext(messages);
    }

    async models(LM_STUDIO_URL) {
        try {
            const res = await fetch(`${LM_STUDIO_URL}/v1/models`);
            if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
            const data = await res.json();
            const apiModels = (data.data?.map(m => m.id) || []).sort();
            return `📋 Available Models:\n${apiModels.map((m, i) => `  ${i}. ${m}`).join('\n')}`;
        } catch (err) {
            throw new CommandError(`Failed to fetch models: ${err.message}`);
        }
    }

    async model(currentModel, LM_STUDIO_URL, args) {
        if (!args) {
            return `Current model: ${currentModel}`;
        }
        try {
            const res = await fetch(`${LM_STUDIO_URL}/v1/models`);
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
                return `✅ Switched to model: ${selectedModel}`;
            } else {
                throw new CommandError(`Invalid model or index. Use /models to see available options.`);
            }
        } catch (err) {
            if (err instanceof CommandError) throw err;
            throw new CommandError(`Failed to fetch models: ${err.message}`);
        }
    }

    async executeTool(toolName, args) {
        const result = await this.tool.executeTool(toolName, args);
        return `🔧 ${toolName} output:\n${result}`;
    }

    async context(messages) {
        const fullCount = messages.length;
        const prunedMessages = this._pruneContext(messages);
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

    async execute(cmd, args, messages, LM_STUDIO_URL, currentModel) {
        switch (cmd) {
            case 'exit':
                await this.exit(messages);
                return 'exit';
            case 'help':
                return await this.help();
            case 'models':
                return await this.models(LM_STUDIO_URL);
            case 'model':
                return await this.model(currentModel, LM_STUDIO_URL, args);
            case 'tool':
                if (!args) {
                    throw new CommandError('Tool name is required. Usage: /tool <name> <json args>');
                }
                const [name, ...rest] = args.split(' ');
                const jsonStr = rest.join(' ');
                try {
                    const parsedArgs = JSON.parse(jsonStr);
                    return await this.executeTool(name, parsedArgs);
                } catch (err) {
                    throw new CommandError(`Failed to parse tool arguments: ${err.message}`);
                }
            case 'liveprune':
                return this.toggleLiveprune();
            case 'context':
                return await this.context(messages);
            default:
                throw new CommandError(`Unrecognized command: /${cmd}`);
        }
    }
}