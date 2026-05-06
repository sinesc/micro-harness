import fs from 'fs/promises';
import { Application } from './application.js';

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
        return `Available commands:\n/exit - Exit the harness\n/models - List available models\n/model <index or name> - Switch to a model\n/prompt [index or name] - List or set system prompt\n/tool <name> <json args> - Execute a tool\n/context - Show context statistics\n/config <setting> [ <value> ] - Get or set a config setting\n/reset - Clear current context (keeping only system prompt)`;
    }

    async config(args) {
        const validSettings = ['endpoint', 'context', 'liveprune', 'temperature'];
        if (!args || args.trim() === '') {
            return `Usage: /config <setting> [ <value> ]\n\nAvailable settings:\n  endpoint    - LM Studio endpoint URL\n  context     - Context window size in tokens\n  liveprune   - Enable live pruning of stale context (${this.application.config.getLiveprune() ? 'ON' : 'OFF'})\n  temperature - Sampling temperature (0-2, default: ${this.application.config.getTemperature()})`;
        }

        const parts = args.trim().split(/\s+/);
        const settingName = parts[0].toLowerCase();
        const settingValue = parts.slice(1).join(' ');

        if (!validSettings.includes(settingName)) {
            throw new CommandError(`Unknown setting: ${settingName}. Valid settings: ${validSettings.join(', ')}`);
        }

        // Get current value if no new value provided
        if (settingValue === '' || settingValue === undefined) {
            switch (settingName) {
                case 'endpoint':
                    return `endpoint = ${this.application.config.getEndpoint()}`;
                case 'context':
                    return `context = ${this.application.config.getContextWindow()}`;
                case 'liveprune':
                    return `liveprune = ${this.application.config.getLiveprune()}`;
                case 'temperature':
                    return `temperature = ${this.application.config.getTemperature()}`;
            }
        }

        // Set new value
        try {
            switch (settingName) {
                case 'endpoint':
                    this.application.config.setEndpoint(settingValue);
                    break;
                case 'context':
                    this.application.config.setContextWindow(settingValue);
                    break;
                case 'liveprune':
                    this.application.config.setLiveprune(settingValue);
                    break;
                case 'temperature':
                    this.application.config.setTemperature(settingValue);
                    break;
            }
            await this.application.config.save();

            // Return updated value
            switch (settingName) {
                case 'endpoint':
                    return `endpoint = ${this.application.config.getEndpoint()}`;
                case 'context':
                    return `context = ${this.application.config.getContextWindow()}`;
                case 'liveprune':
                    return `liveprune = ${this.application.config.getLiveprune()}`;
                case 'temperature':
                    return `temperature = ${this.application.config.getTemperature()}`;
            }
        } catch (err) {
            throw new CommandError(err.message);
        }
    }

    async exit() {
        await this.application.context.save();
        await this.application.config.save();
    }

    async models() {
        try {
            const res = await fetch(`${this.application.config.getEndpoint()}/v1/models`);
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
            const res = await fetch(`${this.application.config.getEndpoint()}/v1/models`);
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

    async prompt(args) {
        try {
            const files = await fs.readdir(Application.SYSTEM_PROMPT_DIR);
            const mdFiles = files.filter(f => f.endsWith('.md')).sort();

            if (!args) {
                // List available prompts
                if (mdFiles.length === 0) {
                    return `No system prompts available in ${Application.SYSTEM_PROMPT_DIR}`;
                }
                const currentName = this.application.systemPrompt?.name || '(none)';
                let output = `📋 Available System Prompts:\n\n`;
                mdFiles.forEach((f, i) => {
                    const marker = f === currentName ? ' ← current' : '';
                    output += `  ${i}. ${f}${marker}\n`;
                });
                return output;
            }

            // Set system prompt by index or name
            const index = parseInt(args, 10);
            let selectedFile = null;

            if (!isNaN(index) && index >= 0 && index < mdFiles.length) {
                selectedFile = mdFiles[index];
            } else {
                // Match by name (excluding path and extension)
                selectedFile = mdFiles.find(f => f.replace(/\.md$/, '') === args);
            }

            if (!selectedFile) {
                throw new CommandError(`Invalid prompt index or name. Use /prompt to see available options.`);
            }

            await this.application.setSystemPrompt(selectedFile);
            return `✅ Switched to system prompt: ${selectedFile}`;
        } catch (err) {
            if (err instanceof CommandError) throw err;
            throw new CommandError(`Failed to load system prompt: ${err.message}`);
        }
    }

    async context() {
        const stats = this.application.context.getStatistics(this.application.systemPrompt?.content);

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
                throw new CommandError('exit');
            case 'help':
                return await this.help();
            case 'models':
                return await this.models();
            case 'model':
                return await this.model(args);
            case 'prompt':
                return await this.prompt(args);
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
            case 'config':
                return await this.config(args);
            case 'context':
                return await this.context();
            case 'reset':
                return await this.reset();
            default:
                throw new CommandError(`Unrecognized command: /${cmd}`);
        }
    }
}