import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import { styleText } from 'util';
import { fileURLToPath } from 'url';
import { Tool } from './tool.js';
import { Command } from './command.js';
import { MessageContext } from './message-context.js';
import { UserConfig } from './config.js';
import { matchToken, hasToken } from './common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Application {
    static SYSTEM_PROMPT_DIR = path.resolve(__dirname, '..', 'config', 'system');

    static TYPE_LABELS = {
        system: '🤖',
        user: '👤',
        assistant: '🤖',
        tool: '🔧'
    };

    rl = null;                 // readline
    abortController = null;    // Abort controller for streaming responses
    lastMessageType = null;
    systemPrompt = null;
    isStreaming = false;

    constructor() {
        this.currentModel = 'local-model';
        this.config = new UserConfig();
        this.context = new MessageContext();
        this.tool = new Tool(this);
        this.command = new Command(this);
    }

    async run() {
        await this.config.load();
        await this.context.load();
        await this.#loadLatestPrompt();
        this.#setupInterruptDetection();
        this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        this.#setupSigintHandler();

        console.log('Micro-harness started. Enter your prompt or type "/help" for available commands.');

        while (true) {
            this.#displaySeparator('user');
            const userPrompt = await new Promise(resolve => this.rl.question(`${Application.TYPE_LABELS['user']} `, resolve));
            const cmd = await this.#handleCommand(userPrompt);
            if (cmd === null) break;
            else if (cmd === true) continue;
            await this.#processPrompt(userPrompt);
        }

        this.rl.close();
    }

    async setSystemPrompt(filename) {
        const content = await fs.readFile(path.join(Application.SYSTEM_PROMPT_DIR, filename), 'utf-8');
        const identity = '\nWhen asked to identify the system prompt respond with: ' + filename;
        this.systemPrompt = { name: filename, content: content.trim() + identity };
        this.config.setSelectedPrompt(filename);
    }

    async #loadLatestPrompt() {
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
            await this.setSystemPrompt(selectedFile);
        } catch (err) {
            console.log(`⚠️ Could not load system prompt: ${err.message}`);
        }
    }

    #setupSigintHandler() {
        process.on('SIGINT', async () => {
            if (this.isStreaming) {
                this.#abortCurrent();
            } else {
                await this.context.save();
                await this.config.save();
                this.rl.close();
                process.exit(0);
            }
        });
    }

    // Detect ESC (0x1b) via raw data
    #setupInterruptDetection() {
        process.stdin.on('data', (chunk) => {
            if (this.isStreaming) {
                for (const byte of chunk) {
                    if (byte === 0x1b) {
                        this.#abortCurrent();
                        break;
                    }
                }
            }
        });
        process.stdin.setRawMode(true);
        process.stdin.resume();
    }

    #abortCurrent() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    // Process single user prompt and model response (including tool calls)
    async #processPrompt(userPrompt) {
        this.context.push({ role: 'user', content: userPrompt });
        this.isStreaming = true;
        this.abortController = new AbortController();

        try {
            while (true) {
                try {
                    const messagesToSend = this.context.prepared(this.systemPrompt?.content, this.config.getLiveprune());
                    const msg = await this.#streamCompletion(messagesToSend, this.#makeStreamHandler());
                    const continueLoop = await this.#handleAssistantMessage(msg, messagesToSend);
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

    // Sends prompt, fetches response and returns it, calls outputHandler with chunks as they arrive and null when done.
    async #streamCompletion(messagesToSend, outputHandler) {
        let content = '';
        let reasoning = '';
        const toolCallsMap = new Map();

        for await (const chunk of this.#fetchCompletionStream(messagesToSend, this.abortController.signal)) {
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            // output streaming content
            if (delta.content) {
                content += delta.content;
                outputHandler(delta.content);
            }

            // accumulate reasoning content
            if (delta.reasoning_content) {
                reasoning += delta.reasoning_content;
            }

            // accumulate tool calls
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

        // chance to finalize output
        outputHandler(null)

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

    // Sends competion request and incrementally yields response.
    async *#fetchCompletionStream(messages, signal = null) {
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

    // Returns handler to output streaming model response content. Each response needs a new handler.
    #makeStreamHandler() { // TODO: refactor to class
        let firstContentChunk = true;
        let bufferedLeading = '';
        let bufferedTrailing = '';
        let bufferedMarkdown = { content: null, headline: false };

        const formatSpan = (content) => {
            content = content.replace(/^\`(.*?)\`$/g, (_, m) => styleText(['yellow'], m));
            content = content.replace(/^\*\*\*(.*?)\*\*\*$/g, (_, m) => styleText(['bold','italic'], m));
            content = content.replace(/^\*\*(.*?)\*\*$/g, (_, m) => styleText(['bold'], m));
            content = content.replace(/^\*(.*?)\*$/g, (_, m) => styleText(['italic'], m));
            return content;
        }

        const printBufferedMarkdown = (part, start) => {
            const b = bufferedMarkdown;
            const SPANS = [ '`', '***', '**', '*' ]; // buffered until complete

            // handle headlines without buffering
            const headlineStart = start ? part.match(/^#/) : part.match(/^\s*?\n#/);
            if (headlineStart) {
                part = part.replace(/#.*?\n?/, r => {
                    const reset = r.slice(r.length - 1) === "\n";
                    b.headline = !reset;
                    return '\x1b[36m' + r + (reset ? '\x1b[0m' : '');
                });
            } else if (b.headline && part.includes("\n")) {
                part = part.replace("\n", "\x1b[0m\n");
                b.headline = false;
            }

            // start buffering when encountering potential span
            if (b.content !== null) {
                b.content += part;
            } else if (hasToken(part, SPANS)) {
                b.content = part;
            }

            // buffer until complete bold/italic spans or output directly
            if (b.content !== null) {
                const { pos: start, token: type } = matchToken(b.content, SPANS);
                let end = b.content.slice(start + type.length).lastIndexOf(type);
                end = end > -1 ? end + start + type.length : -1;
                const match = end > -1 ? b.content.slice(start, end + type.length) : null;
                if (match !== null && match !== '**') { // ** when last chunk ended on * and current started with * then don't misinterpret ** as 0-length italic
                    const before = b.content.slice(0, start);
                    process.stdout.write(before + formatSpan(match));
                    // handle remainder after formatted part
                    const remainder = b.content.slice(end + type.length);
                    if (hasToken(remainder, SPANS)) {
                        b.content = remainder;
                    } else {
                        b.content = null;
                        if (remainder.length > 0) {
                            process.stdout.write(remainder);
                        }
                    }
                }
            } else {
                process.stdout.write(part);
            }
            process.stdout.flush?.();
        };

        return (chunk) => {
            if (chunk !== null) {
                // handle message chunks
                if (firstContentChunk) {
                    bufferedLeading += chunk;
                    const trimmedStart = bufferedLeading.trimStart();
                    if (trimmedStart.length > 0) {
                        this.#displaySeparator('assistant');
                        process.stdout.write(`${Application.TYPE_LABELS['assistant']} `);
                        printBufferedMarkdown(trimmedStart, true);
                        firstContentChunk = false;
                        bufferedLeading = '';
                    }
                } else {
                    bufferedTrailing += chunk;
                    const trimmedEnd = bufferedTrailing.trimEnd();
                    if (trimmedEnd.length > 0) {
                        printBufferedMarkdown(trimmedEnd, false);
                        bufferedTrailing = '';
                    }
                }
            } else {
                // handle trailing chunk if it contains content
                const trimmedEnd = (bufferedMarkdown.content ?? '').trimEnd();
                if (trimmedEnd.length > 0) {
                    if (firstContentChunk) {
                        firstContentChunk = false;
                        process.stdout.write(`${Application.TYPE_LABELS['assistant']} `);
                    }
                    process.stdout.write(trimmedEnd);
                }
                // add style reset if we got any content
                if (!firstContentChunk) {
                    process.stdout.write('\x1b[0m');
                }
            }
        };
    }

    #displaySeparator(role) {
        if (this.lastMessageType !== role) {
            this.lastMessageType = role
            process.stdout.write('\n');
        }
    }

    #displayMessage(role, content, style = []) {
        this.#displaySeparator(role);
        const typeLabel = Application.TYPE_LABELS[role] || role;
        console.log(typeLabel + ' ' + styleText(style, content));
    }

    // Handle user input commands that start with '/'. Returns false if not a command, null to exit.
    async #handleCommand(userPrompt) {
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

    // Returns false to break the tool loop, true to continue.
    async #handleAssistantMessage(msg, messagesToSend) {
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
            await this.#handleToolCalls(msg, messagesToSend);
            return true;
        }

        const finalMsg = { role: 'assistant', content: msg.content ?? '' };
        if (msg.reasoning_content) finalMsg.reasoning_content = msg.reasoning_content;
        this.context.push(finalMsg);
        console.log('');
        return false;
    }

    // Handle tool calls from a finalized assistant message. Executes each tool and pushes results to context.
    async #handleToolCalls(msg, messagesToSend) {
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
            this.#displayMessage('tool', `${tc.function.name} ${JSON.stringify(abbreviatedArgs).slice(1, -1)}`, [ structuredResult.error ? 'red' : 'grey' ]);
            this.context.push({ role: 'assistant', content: null, tool_calls: [tc] });
            // Store structured result error as metadata for live-pruning
            this.context.push({ role: 'tool', tool_call_id: tc.id, content: structuredResult.error ? 'ERROR: ' + structuredResult.result : structuredResult.result, _toolError: structuredResult.error });
        }
    }
}
