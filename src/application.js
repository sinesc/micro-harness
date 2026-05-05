import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Tool } from './tool.js';
import { Command } from './command.js';
import { MessageContext } from './message-context.js';
import { UserConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Application {
    static SYSTEM_PROMPT_DIR = path.resolve(__dirname, '..', 'config', 'system');

    constructor() {
        this.currentModel = 'local-model';

        // Token usage tracking
        this.totalPromptTokens = 0;
        this.totalCompletionTokens = 0;
        this.totalTokens = 0;

        // Message display state
        this.lastMessageType = null;

        // User configuration
        this.config = new UserConfig();

        // Context manager
        this.context = new MessageContext();

        // readline interface
        this.rl = null;

        // Abort controller for streaming responses
        this.abortController = null;

        // Instantiate Tool
        this.tool = new Tool(this);

        // Instantiate Command
        this.command = new Command(this);

        // Load latest system prompt
        this.systemPrompt = null;

        // Streaming state
        this.isStreaming = false;

        // Set up interrupt detection once
        this._setupInterruptDetection();
    }

    _setupInterruptDetection() {
        // Detect ESC (0x1b) via raw data
        this._dataHandler = (chunk) => {
            if (this.isStreaming) {
                for (const byte of chunk) {
                    if (byte === 0x1b) {
                        this.abortCurrent();
                        break;
                    }
                }
            }
        };
        process.stdin.on('data', this._dataHandler);
        process.stdin.setRawMode(true);
        process.stdin.resume();
    }

    abortCurrent() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    async init() {
        await this.config.load();
        await this.context.load();
        await this.loadLatestPrompt();
    }

    async setPrompt(filename) {
        const content = await fs.readFile(path.join(Application.SYSTEM_PROMPT_DIR, filename), 'utf-8');
        const identity = '\nWhen asked to identify the system prompt respond with: ' + filename;
        this.systemPrompt = { name: filename, content: content.trim() + identity };
        this.config.setSelectedPrompt(filename);
    }

    async loadLatestPrompt() {
        try {
            const files = await fs.readdir(Application.SYSTEM_PROMPT_DIR);
            const mdFiles = files.filter(f => f.endsWith('.md')).sort();
            if (mdFiles.length === 0) {
                console.log(`⚠️ No system prompts found in ${Application.SYSTEM_PROMPT_DIR}`);
                return;
            }
            let selectedFile = this.config.getSelectedPrompt();
            if (!selectedFile || !mdFiles.includes(selectedFile)) {
                selectedFile = mdFiles[mdFiles.length - 1];
            }
            await this.setPrompt(selectedFile);
            console.log(`✅ Loaded system prompt: ${selectedFile}`);
        } catch (err) {
            console.log(`⚠️ Could not load system prompt: ${err.message}`);
        }
    }

    async *fetchCompletionStream(messages, signal = null) {
        const res = await fetch(`${this.config.getEndpoint()}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.currentModel,
                messages,
                tools: Tool.TOOLS,
                tool_choice: 'auto',
                temperature: this.config.getTemperature(),
                stream: true
            }),
            signal
        });
        if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Parse SSE lines from buffer
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep incomplete last line in buffer

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed === '' || trimmed === 'data: [DONE]') continue;
                    if (!trimmed.startsWith('data: ')) continue;

                    const data = JSON.parse(trimmed.slice(6));
                    yield data;
                }
            }

            // Process any remaining buffer
            if (buffer.trim() && buffer.trim() !== 'data: [DONE]') {
                const trimmed = buffer.trim();
                if (trimmed.startsWith('data: ')) {
                    const data = JSON.parse(trimmed.slice(6));
                    yield data;
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

    displayMessage(role, content, color = null) {
        content = (content || '').trim();
        if (content === '') return;

        // Basic markdown rendering: **bold** and *italic* // TODO look into util.styleText()
        content = content.replace(/\*\*(.*?)\*\*/g, '\x1b[1m$1\x1b[22m'); // bold
        content = content.replace(/\*(.*?)\*/g, '\x1b[3m$1\x1b[23m'); // italic

        const typeLabel = {
            system: '🤖',
            user: '👤',
            assistant: '🤖',
            tool: '🔧'
        }[role] || role;

        let colorCode = '';
        if (color === 'grey') colorCode = '\x1b[90m';
        else if (color === 'red') colorCode = '\x1b[91m';
        const resetCode = '\x1b[0m';

        if (this.lastMessageType !== null && this.lastMessageType !== role) {
            console.log('');
        }
        console.log(`${typeLabel} ${colorCode}${content}${resetCode}`);
        this.lastMessageType = role;
    }

    /**
     * Display a streaming chunk progressively.
     * Uses \r to update the current line in-place, flushing on newlines.
     * Returns the accumulated content built from all chunks.
     */
    displayMessageChunk(role, chunk, isFirst, isLast, color = null) {
        if (!chunk || chunk.length === 0) return;

        const typeLabel = {
            system: '🤖',
            user: '👤',
            assistant: '🤖',
            tool: '🔧'
        }[role] || role;

        let colorCode = '';
        if (color === 'grey') colorCode = '\x1b[90m';
        else if (color === 'red') colorCode = '\x1b[91m';
        const resetCode = '\x1b[0m';

        // On first chunk, print the type label prefix
        if (isFirst) {
            if (this.lastMessageType !== null && this.lastMessageType !== role) {
                process.stdout.write('\n');
            }
            process.stdout.write(`${typeLabel} ${colorCode}`);
            this.lastMessageType = role;
        }

        // Split chunk by newlines for progressive display
        const parts = chunk.split('\n');
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i < parts.length - 1) {
                // Not the last part: print with newline and reset
                process.stdout.write(`${part}${resetCode}\n${colorCode}`);
            } else if (isLast) {
                // Final part of final chunk: commit with newline and reset
                process.stdout.write(`${part}${resetCode}\n`);
            } else {
                // Last part but not final chunk: use \r for in-place update
                // Clear to end of line first, then rewrite
                process.stdout.write('\x1b[K');
                process.stdout.write(part);
            }
        }
        process.stdout.flush?.();
    }

    _setupSigintHandler() {
        process.on('SIGINT', async () => {
            if (this.isStreaming) {
                this.abortCurrent();
            } else {
                await this.context.save();
                await this.config.save();
                this.rl.close();
                process.exit(0);
            }
        });
    }

    async _streamCompletion(messagesToSend) {
        let content = '';
        let reasoning = '';
        const toolCallsMap = new Map();
        let firstContentChunk = true;
        let bufferedLeading = '';
        let bufferedTrailing = '';

        for await (const chunk of this.fetchCompletionStream(messagesToSend, this.abortController.signal)) {
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
                content += delta.content;
                if (firstContentChunk) {
                    bufferedLeading += delta.content;
                    const trimmedStart = bufferedLeading.trimStart();
                    if (trimmedStart.length > 0) {
                        this.displayMessageChunk('assistant', trimmedStart, true, false);
                        firstContentChunk = false;
                        bufferedLeading = '';
                    }
                } else {
                    bufferedTrailing += delta.content;
                    const trimmedEnd = bufferedTrailing.trimEnd();
                    if (trimmedEnd.length > 0) {
                        this.displayMessageChunk('assistant', trimmedEnd, false, false);
                        bufferedTrailing = '';
                    }
                }
            }

            if (delta.reasoning_content) {
                reasoning += delta.reasoning_content;
            }

            if (delta.tool_calls) {
                for (const tcDelta of delta.tool_calls) {
                    const idx = tcDelta.index;
                    let tc = toolCallsMap.get(idx);
                    if (!tc) {
                        tc = { id: tcDelta.id ?? '', function: { name: '', arguments: '' } };
                        toolCallsMap.set(idx, tc);
                    }
                    if (tcDelta.id) tc.id = tcDelta.id;
                    if (tcDelta.function?.name) tc.function.name = tcDelta.function.name;
                    if (tcDelta.function?.arguments) tc.function.arguments += tcDelta.function.arguments;
                }
            }
        }

        if (!firstContentChunk) {
            process.stdout.write('\x1b[0m');
            if (!content.endsWith('\n')) process.stdout.write('\n');
        }

        const toolCalls = [...toolCallsMap.values()].map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments }
        }));

        return {
            content,
            reasoning_content: reasoning || undefined,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined
        };
    }

    // Returns false to break the tool loop, true to continue.
    async _handleAssistantMessage(msg, messagesToSend) {
        if (!msg.content?.trim() && !msg.tool_calls?.length) {
            if (msg.reasoning_content?.includes('<tool_call>')) {
                this.context.push({ role: 'system', content: 'Please do not include tool call syntax (like <tool_call>) in your reasoning_content. If you need to use a tool, use the proper tool call format.' });
            } else {
                this.context.push({ role: 'system', content: 'You did not call a tool or respond to the user. Please either call a tool or respond to the user.' });
            }
        }

        if (msg.tool_calls?.length) {
            if (msg.content?.trim().length > 0) {
                console.log("");
            }
            await this.handleToolCalls(msg, messagesToSend);
            return true;
        }

        const finalMsg = { role: 'assistant', content: msg.content ?? '' };
        if (msg.reasoning_content) finalMsg.reasoning_content = msg.reasoning_content;
        this.context.push(finalMsg);
        console.log('');
        return false;
    }

    async _processPrompt(userPrompt) {
        this.context.push({ role: 'user', content: userPrompt });
        this.isStreaming = true;
        this.abortController = new AbortController();

        try {
            while (true) {
                try {
                    const messagesToSend = this.context.prepared(this.systemPrompt?.content, this.config.getLiveprune());
                    const msg = await this._streamCompletion(messagesToSend);
                    const continueLoop = await this._handleAssistantMessage(msg, messagesToSend);
                    if (!continueLoop) break;
                } catch (err) {
                    process.stdout.write('\x1b[0m\x1b[K\n');
                    if (err.name === 'AbortError') {
                        console.log('\n⚠️  Response interrupted.\n');
                    } else {
                        console.error(`\n❌ API Error: ${err.message}\n`);
                    }
                    break;
                }
            }
        } finally {
            this.isStreaming = false;
            if (this.abortController) this.abortController = null;
        }
    }

    async run() {
        await this.init();
        this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log('🚀 LLM Coding Harness started. Enter your prompt or type "/help" for available commands.\n');
        this._setupSigintHandler();

        while (true) {
            const userPrompt = await new Promise(resolve => this.rl.question('> ', resolve));
            console.log('');
            const cmd = await this.handleCommand(userPrompt);
            if (cmd === null) break;
            else if (cmd === true) continue;
            await this._processPrompt(userPrompt);
        }

        this.rl.close();
    }

    /**
     * Handle user input commands that start with '/'. Returns false if not a command, null to exit.
     */
    async handleCommand(userPrompt) {
        if (userPrompt.slice(0, 1) !== '/') {
            return false;
        }
        const matches = userPrompt.match(/^\/(?<cmd>[a-zA-Z_]+)(?:\s+(?<args>.*))?$/);
        const cmd = matches?.groups?.cmd ?? null;
        const args = matches?.groups?.args ?? null;
        if (!cmd) {
            console.log(`\nInvalid command syntax\n`);
        } else {
            try {
                const result = await this.command.exec(cmd, args);
                console.log(`${result}\n`);
            } catch (err) {
                if (err.message === 'exit') {
                    return null;
                }
                console.log(`❌ ${err.message}\n`);
            }
        }
        return true;
    }

    /**
     * Handle tool calls from a finalized assistant message. Executes each tool and pushes results to context.
     */
    async handleToolCalls(msg, messagesToSend) {
        // Display any text message the model included with the tool call
        const assistantMsg = { role: 'assistant', content: msg.content };
        if (msg.reasoning_content) assistantMsg.reasoning_content = msg.reasoning_content;
        this.context.push(assistantMsg);

        for (const tc of msg.tool_calls) {
            const args = JSON.parse(tc.function.arguments);
            // Display tool name and abbreviated arguments (limit each property to 16 chars)
            const abbreviatedArgs = Object.fromEntries(
                Object.entries(args).map(([k, v]) => [k, String(v).trim().length > 16 ? String(v).trim().slice(0, 16) + '...' : String(v).trim()])
            );
            const structuredResult = await this.tool.exec(tc.function.name, args);
            this.displayMessage('tool', `${tc.function.name} ${JSON.stringify(abbreviatedArgs).slice(1, -1)}`, structuredResult.error ? 'red' : 'grey');
            this.context.push({ role: 'assistant', content: null, tool_calls: [tc] });
            // Store structured result error as metadata for live-pruning
            this.context.push({ role: 'tool', tool_call_id: tc.id, content: structuredResult.error ? 'ERROR: ' + structuredResult.result : structuredResult.result, _toolError: structuredResult.error });
        }
    }
}
