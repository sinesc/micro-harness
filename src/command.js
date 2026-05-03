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

    async help() {
        return `Available commands:\n/exit - Exit the harness\n/models - List available models\n/model <index or name> - Switch to a model\n/tool <name> <json args> - Execute a tool\n/context - Show context statistics\n/liveprune - Toggle live pruning of stale context (currently ${this.application.liveprune ? 'ON' : 'OFF'})\n/reset - Clear current context (keeping only system prompt)`;
    }

    toggleLiveprune() {
        this.application.liveprune = !this.application.liveprune;
        return `Live pruning is now ${this.application.liveprune ? 'ON' : 'OFF'}.`;
    }

    async exit() {
        await this.application.context.save();
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
        const { result, error } = await this.application.tool.exec(toolName, args);
        return `🔧 ${toolName} ${error?"error: ":"result:\n"}${result}`;
    }

    async context() {
        const stats = this.application.context.getStatistics(this.application.constructor.SYSTEM_PROMPT);

        let output = `📊 Context Statistics:\n\n`;
        output += `  Messages: ${stats.fullCount} (full) → ${stats.prunedCount} (pruned) | Removed: ${stats.removedCount}\n`;
        output += `  Estimated tokens: ${Math.round(stats.fullTokens)} (full) → ${Math.round(stats.prunedTokens)} (pruned)\n\n`;

        output += `  Role breakdown:\n`;
        for (const [role, count] of Object.entries(stats.roleCounts).sort((a, b) => b[1] - a[1])) {
            const icon = { system: '🤖', user: '👤', assistant: '🤖', tool: '🔧' }[role] || role;
            output += `    ${icon} ${role}: ${count}\n`;
        }

        output += `\n  Files read: ${stats.readFiles.length}\n`;
        if (stats.readFiles.length > 0) {
            output += `    ${stats.readFiles.join(', ')}\n`;
        }

        output += `\n  Tool calls by type:\n`;
        for (const [tool, count] of Object.entries(stats.toolCallCounts).sort((a, b) => b[1] - a[1])) {
            output += `    ${tool}: ${count}\n`;
        }

        return output;
    }

    async reset() {
        this.application.context.reset();
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
                const jsonStr = rest.join(' ').trim();
                try {
                    const parsedArgs = JSON.parse(jsonStr.slice(0, 1) === '{' ? jsonStr : `{${jsonStr}}`);
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