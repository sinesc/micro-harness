import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export class UserConfig {
    static CONFIG_DIR = path.join(os.homedir(), '.config', 'micro-harness');
    static CONFIG_FILE = path.join(UserConfig.CONFIG_DIR, 'config.json');

    // Default values
    static DEFAULT_ENDPOINT = 'http://10.13.37.110:1234';
    static DEFAULT_CONTEXT_WINDOW = 131072;
    static DEFAULT_LIVEPRUNE = true;
    static DEFAULT_TEMPERATURE = 0.6;

    constructor() {
        this.selectedPrompt = null;
        this.endpoint = UserConfig.DEFAULT_ENDPOINT;
        this.contextWindow = UserConfig.DEFAULT_CONTEXT_WINDOW;
        this.liveprune = UserConfig.DEFAULT_LIVEPRUNE;
        this.temperature = UserConfig.DEFAULT_TEMPERATURE;
    }

    /**
     * Load configuration from disk, creating the directory if needed.
     */
    async load() {
        try {
            await fs.mkdir(UserConfig.CONFIG_DIR, { recursive: true });
            const data = await fs.readFile(UserConfig.CONFIG_FILE, 'utf-8');
            const parsed = JSON.parse(data);
            if (parsed.selectedPrompt) {
                this.selectedPrompt = parsed.selectedPrompt;
            }
            if (typeof parsed.endpoint === 'string' && parsed.endpoint.trim() !== '') {
                this.endpoint = parsed.endpoint.trim();
            }
            if (typeof parsed.contextWindow === 'number' && parsed.contextWindow > 0) {
                this.contextWindow = parsed.contextWindow;
            }
            if (typeof parsed.liveprune === 'boolean') {
                this.liveprune = parsed.liveprune;
            }
            if (typeof parsed.temperature === 'number' && parsed.temperature >= 0 && parsed.temperature <= 2) {
                this.temperature = parsed.temperature;
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.log(`⚠️  Warning: Could not load config: ${err.message}`);
            }
        }
    }

    /**
     * Save the current configuration to disk.
     */
    async save() {
        try {
            await fs.mkdir(UserConfig.CONFIG_DIR, { recursive: true });
            await fs.writeFile(UserConfig.CONFIG_FILE, JSON.stringify({
                selectedPrompt: this.selectedPrompt,
                endpoint: this.endpoint,
                contextWindow: this.contextWindow,
                liveprune: this.liveprune,
                temperature: this.temperature
            }, null, 2), 'utf-8');
        } catch (err) {
            console.log(`⚠️  Warning: Could not save config: ${err.message}`);
        }
    }

    /**
     * Get the currently selected system prompt name.
     */
    getSelectedPrompt() {
        return this.selectedPrompt;
    }

    /**
     * Set the currently selected system prompt name.
     */
    setSelectedPrompt(name) {
        this.selectedPrompt = name;
    }

    /**
     * Get the LM Studio endpoint URL.
     */
    getEndpoint() {
        return this.endpoint;
    }

    /**
     * Set the LM Studio endpoint URL.
     */
    setEndpoint(value) {
        if (typeof value !== 'string' || value.trim() === '') {
            throw new Error('Endpoint must be a non-empty string');
        }
        this.endpoint = value.trim();
    }

    /**
     * Get the context window size in tokens.
     */
    getContextWindow() {
        return this.contextWindow;
    }

    /**
     * Set the context window size. Must be a positive integer.
     */
    setContextWindow(value) {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) {
            throw new Error('Context window must be a positive integer');
        }
        this.contextWindow = num;
    }

    /**
     * Get the liveprune setting.
     */
    getLiveprune() {
        return this.liveprune;
    }

    /**
     * Set the liveprune setting. Must be 'true' or 'false' (case-insensitive).
     */
    setLiveprune(value) {
        if (typeof value === 'boolean') {
            this.liveprune = value;
        } else if (typeof value === 'string') {
            const lower = value.trim().toLowerCase();
            if (lower === 'true') {
                this.liveprune = true;
            } else if (lower === 'false') {
                this.liveprune = false;
            } else {
                throw new Error('Liveprune must be "true" or "false"');
            }
        } else {
            throw new Error('Liveprune must be "true" or "false"');
        }
    }

    /**
     * Get the temperature setting.
     */
    getTemperature() {
        return this.temperature;
    }

    /**
     * Set the temperature. Must be a number between 0 and 2.
     */
    setTemperature(value) {
        const num = parseFloat(value);
        if (isNaN(num) || num < 0 || num > 2) {
            throw new Error('Temperature must be a number between 0 and 2');
        }
        this.temperature = num;
    }
}
