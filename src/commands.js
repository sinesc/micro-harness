export class CommandError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CommandError';
    }
}

export class Command {
    constructor({ tool, saveContext }) {
        this.tool = tool;
        this._saveContext = saveContext;
    }

    async help() {
        return `Available commands:\n/exit - Exit the harness\n/models - List available models\n/model <index or name> - Switch to a model\n/tool <name> <json args> - Execute a tool`;
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
            default:
                throw new CommandError(`Unrecognized command: /${cmd}`);
        }
    }
}