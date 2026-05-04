import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export class UserConfig {
    static CONFIG_DIR = path.join(os.homedir(), '.config', 'micro-harness');
    static CONFIG_FILE = path.join(UserConfig.CONFIG_DIR, 'config.json');

    constructor() {
        this.selectedPrompt = null;
        this.liveprune = true;
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
            if (typeof parsed.liveprune === 'boolean') {
                this.liveprune = parsed.liveprune;
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
                liveprune: this.liveprune
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
     * Get the liveprune setting.
     */
    getLiveprune() {
        return this.liveprune;
    }

    /**
     * Set the liveprune setting.
     */
    setLiveprune(value) {
        this.liveprune = value;
    }
}
