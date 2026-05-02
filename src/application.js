import readline from 'readline';
import fs from 'fs/promises';
import { Tool } from './tools.js';
import { Command } from './commands.js';

export class Application {
    static LM_STUDIO_URL = 'http://10.13.37.110:1234';
    static CONTEXT_WINDOW = 131072;
    static CONTEXT_FILE = 'context.json';

    static SYSTEM_PROMPT = `You are a coding assistant operating in a terminal harness. You have access to file tools.
IMPORTANT RULES:
1. If you want to edit a file, call read_file first. The output includes line numbers for use with edit_file.
2. When using the edit_file tool you MUST include unmodified leading/trailing anchor lines in your edit so that the tool can match them against the contents of the file and correct for minor line offsets.
3. Do not compensate for line-drift of consecutive edits, the edit_file tool already accounts for it: line numbers remain stable across edits until you explicitly call read_file again.
4. You may perform multiple edits on a file without calling read_file inbetween. Unless the edit_file tool informs you of possible issues with your edit, assume the edit worked and avoid re-reading the file.
5. Always provide a short concise sentence explaining the intent of your next set of tool calls, e.g. "Creating project file structure.", "Reading files required to understand the issue.", ...
6. You must use the todo tool before implementing non-trivial changes. Provide an overview or a brief list of required steps to complete the implementation. Don't reason too much about this being perfectly complete/correct. You can always deviate from your original plan as the need arises.
7. Once you are done with the changes, run a syntax check (if available for the file-type) and verify your logic is sound.
8. Always return concise, useful feedback on changes made.

edit_file examples, file:
\`\`\`
first
second
third
fourth
\`\`\`

To remove line "second": {"path":"<file>","start_line":1,"end_line":3,"replacement":"first\nthird"}
To add lines between "second" and "third": {"path":"<file>","start_line":2,"end_line":3,"replacement":"second\na new line\nanother new line\nthird"}
To replace line "fourth" (last line): {"path":"<file>","start_line":3,"end_line":4,"replacement":"third\nreplaced fourth line"}
`;

    constructor() {
        this.lmStudioUrl = Application.LM_STUDIO_URL;
        this.contextWindow = Application.CONTEXT_WINDOW;
        this.currentModel = 'local-model';
        this.contextFile = Application.CONTEXT_FILE;
        this.systemPrompt = Application.SYSTEM_PROMPT;

        // Token usage tracking
        this.totalPromptTokens = 0;
        this.totalCompletionTokens = 0;
        this.totalTokens = 0;

        // Message display state
        this.lastMessageType = null;

        // Messages array
        this.messages = [];

        // readline interface
        this.rl = null;

        // Instantiate Tool
        this.tool = new Tool(this);
        this.livepruneRef = { value: false };

        // Instantiate Command
        this.command = new Command(this);
    }

    /*
     * Prune stale/useless context entries before sending to API.
     * Returns a filtered copy of messages (excluding system prompt).
     * Optimized to O(N) time complexity.
     */
    pruneContextForAPI(messages) {
        if (!this.livepruneRef.value) {
            return messages.filter(m => m.role !== 'system');
        }

        // Find the index of the last user message
        let lastUserIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                lastUserIndex = i;
                break;
            }
        }

        const lastReadFileIndexByPath = new Map();
        const filesReReadAfterPreview = new Set();
        let lastAssistantWithTools = null;

        // First pass: gather metadata (O(N))
        for (let i = 0; i <= lastUserIndex; i++) {
            const msg = messages[i];

            if (msg.role === 'assistant' && msg.tool_calls) {
                lastAssistantWithTools = msg;
                for (const tc of msg.tool_calls) {
                    if (tc.function.name === 'read_file') {
                        const pathArg = JSON.parse(tc.function.arguments).path;
                        filesReReadAfterPreview.add(pathArg);
                        lastReadFileIndexByPath.delete(pathArg);
                    }
                }
            }

            if (msg.role === 'tool' && msg.content && !msg.content.includes('Stale result excluded')) {
                const lines = msg.content.split('\n');
                if (lines.length > 0 && /^\d+\t/.test(lines[0]) && lastAssistantWithTools) {
                    for (const tc of lastAssistantWithTools.tool_calls) {
                        if (tc.function.name === 'read_file') {
                            const pathArg = JSON.parse(tc.function.arguments).path;
                            lastReadFileIndexByPath.set(pathArg, i);
                        }
                    }
                }
            }
        }

        // Second pass: filter and build pruned list (O(N))
        const pruned = [];
        lastAssistantWithTools = null;

        for (let i = 0; i <= lastUserIndex; i++) {
            const msg = messages[i];

            if (msg.role === 'assistant' && msg.tool_calls) {
                lastAssistantWithTools = msg;
            }

            if (msg.role === 'tool') {
                if (msg.content && msg.content.includes('Stale result excluded')) {
                    pruned.push(msg);
                    continue;
                }

                const lines = msg.content?.split('\n') || [];
                const isReadFileResult = lines.length > 0 && /^\d+\t/.test(lines[0]);

                if (isReadFileResult && lastAssistantWithTools) {
                    let filePath = null;
                    for (const tc of lastAssistantWithTools.tool_calls) {
                        if (tc.function.name === 'read_file') {
                            filePath = JSON.parse(tc.function.arguments).path;
                        }
                    }

                    if (filePath && lastReadFileIndexByPath.has(filePath)) {
                        const lastIndex = lastReadFileIndexByPath.get(filePath);
                        if (lastIndex !== i) {
                            const placeholder = `Stale result excluded from context, should you need this result use tool read_stale with content_id=${i}`;
                            pruned.push({ ...msg, content: placeholder });
                            continue;
                        }
                    }
                }

                if (msg.content && msg.content.includes('Preview [')) {
                    let filePath = null;
                    for (const tc of lastAssistantWithTools?.tool_calls || []) {
                        if (tc.function.name === 'edit_file') {
                            filePath = JSON.parse(tc.function.arguments).path;
                        }
                    }
                    if (filePath && filesReReadAfterPreview.has(filePath)) {
                        continue;
                    }
                }

                if (msg._toolError) {
                    let toolName = null;
                    for (const tc of lastAssistantWithTools?.tool_calls || []) {
                        toolName = tc.function.name;
                    }
                    if (toolName) {
                        msg._isFailedTool = true;
                        msg._toolName = toolName;
                    }
                }

                pruned.push(msg);
                continue;
            }

            if (msg.role !== 'system') {
                pruned.push(msg);
            }
        }

        // Append current turn messages unchanged
        for (let i = lastUserIndex + 1; i < messages.length; i++) {
            pruned.push(messages[i]);
        }

        // Third pass: remove failed tool results succeeded by later calls (O(N) backwards)
        const finalPruned = [];
        const succeededTools = new Set();

        for (let i = pruned.length - 1; i >= 0; i--) {
            const msg = pruned[i];

            if (msg.role === 'assistant' && msg.tool_calls) {
                finalPruned.push(msg);
            } else if (msg.role === 'tool') {
                if (msg._isFailedTool && succeededTools.has(msg._toolName)) {
                    continue; // Skip failed result, covered by later success
                }
                finalPruned.push(msg);
                if (!msg._isFailedTool) {
                    succeededTools.add(msg._toolName);
                }
            } else {
                // User or system message resets tool success tracking
                succeededTools.clear();
                finalPruned.push(msg);
            }
        }

        finalPruned.reverse();

        return finalPruned;
    }

    async loadContext() {
        try {
            const data = await fs.readFile(this.contextFile, 'utf-8');
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
                console.log(`📂 Loaded context (${parsed.length} messages)`);
                return parsed;
            }
        } catch (err) {
            // File doesn't exist or invalid JSON, start fresh
            if (err.code !== 'ENOENT') {
                console.log(`⚠️  Warning: Could not load context: ${err.message}`);
            }
        }
        return [];
    }

    async saveContext(messages) {
        try {
            // Save only user/assistant/tool messages (skip system prompt)
            const toSave = messages.filter(m => m.role !== 'system');
            await fs.writeFile(this.contextFile, JSON.stringify(toSave, null, 2), 'utf-8');
            console.log(`💾 Saved context (${toSave.length} messages)`);
        } catch (err) {
            console.log(`⚠️  Warning: Could not save context: ${err.message}`);
        }
    }

    async fetchCompletion(messages) {
        const res = await fetch(`${this.lmStudioUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.currentModel,
                messages,
                tools: Tool.TOOLS,
                tool_choice: 'auto',
                temperature: 0.6,
                stream: false
            })
        });
        if (!res.ok) throw new Error(`LM Studio API error: ${res.status} ${res.statusText}`);
        return res.json();
    }

    displayTokenUsage() {
        const remaining = Math.max(0, this.contextWindow - this.totalPromptTokens);
        console.log(`\n📊 Token Usage: ${this.totalTokens} total (${this.totalPromptTokens} prompt + ${this.totalCompletionTokens} completion) | Context: ${this.totalPromptTokens}/${this.contextWindow} (${remaining} remaining)\n`);
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

    async run() {
        // Load previous context if it exists
        const previousMessages = await this.loadContext();
        this.messages = [{ role: 'system', content: this.systemPrompt }, ...previousMessages];
        this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        console.log('🚀 LLM Coding Harness started. Type "/exit" to quit.\n');

        process.on('SIGINT', async () => {
            await this.saveContext(this.messages);
            this.rl.close();
            process.exit(0);
        });

        while (true) {
            const userPrompt = await new Promise(resolve => this.rl.question('> ', resolve));
            console.log("");

            if (userPrompt.slice(0, 1) === '/') {
                const matches = userPrompt.match(/^\/(?<cmd>[a-zA-Z_]+)(?:\s+(?<args>.*))?$/);
                const cmd = matches?.groups?.cmd ?? null;
                const args = matches?.groups?.args ?? null;
                if (!cmd) {
                    console.log(`\nInvalid command syntax\n`);
                } else {
                    try {
                        const result = await this.command.exec(cmd, args);
                        if (result === 'exit') {
                            break;
                        }
                        console.log(`${result}\n`);
                    } catch (err) {
                        console.log(`❌ ${err.message}\n`);
                    }
                }
                continue;
            }

            this.messages.push({ role: 'user', content: userPrompt });

            while (true) {
                try {
                    // Prune context before sending to API if liveprune is enabled
                    const messagesToSend = this.pruneContextForAPI(this.messages);
                    const response = await this.fetchCompletion(messagesToSend);

                    // Track token usage
                    if (response.usage) {
                        this.totalPromptTokens = response.usage.prompt_tokens || 0;
                        this.totalCompletionTokens = response.usage.completion_tokens || 0;
                        this.totalTokens = response.usage.total_tokens || 0;
                    }

                    const msg = response.choices[0].message;

                    // Catch some mistakes.
                    if (!msg.content.trim() && !msg.tool_calls?.length) {
                        if (msg.reasoning_content?.includes('<tool_call>')) {
                            this.messages.push({ role: 'system', content: 'Please do not include tool call syntax (like <tool_call>) in your reasoning_content. If you need to use a tool, use the proper tool call format.' });
                        } else {
                            this.messages.push({ role: 'system', content: 'You did not call a tool or respond to the user. Please either call a tool or respond to the user.' });
                        }
                    }

                    // Handle tool calls
                    if (msg.tool_calls?.length) {
                        // Display any text message the model included with the tool call
                        const assistantMsg = { role: 'assistant', content: msg.content };
                        if (msg.reasoning_content) assistantMsg.reasoning_content = msg.reasoning_content;
                        this.messages.push(assistantMsg);

                        // Display assistant content first if present
                        this.displayMessage('assistant', msg.content);

                        for (const tc of msg.tool_calls) {
                            const args = JSON.parse(tc.function.arguments);
                            // Display tool name and abbreviated arguments (limit each property to 10 chars)
                            const abbreviatedArgs = Object.fromEntries(
                                Object.entries(args).map(([k, v]) => [k, String(v).trim().length > 16 ? String(v).trim().slice(0, 16) + '...' : String(v).trim()])
                            );
                            const structuredResult = await this.tool.exec(tc.function.name, args);
                            const isFailed = structuredResult.error !== undefined && structuredResult.error !== null;
                            this.displayMessage('tool', `${tc.function.name}${JSON.stringify(abbreviatedArgs)}`, isFailed ? 'red' : 'grey');
                            this.messages.push({ role: 'assistant', content: null, tool_calls: [tc] });
                            // Store structured result error as metadata for live-pruning
                            this.messages.push({ role: 'tool', tool_call_id: tc.id, content: structuredResult.result, _toolError: structuredResult.error });
                        }
                    } else {
                        // Final text response
                        const finalContent = msg.content ?? '';
                        const finalMsg = { role: 'assistant', content: finalContent };
                        if (msg.reasoning_content) finalMsg.reasoning_content = msg.reasoning_content;
                        this.messages.push(finalMsg);
                        this.displayMessage('assistant', finalContent);
                        this.displayTokenUsage();
                        break; // Exit tool loop
                    }
                } catch (err) {
                    console.error(`\n❌ API Error: ${err.message}\n`);
                    break;
                }
            }
        }
        this.rl.close();
    }
}
