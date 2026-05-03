import fs from 'fs/promises';

export class MessageContext {
    static CONTEXT_WINDOW = 131072;
    static CONTEXT_FILE = 'context.json';

    constructor(contextFile = MessageContext.CONTEXT_FILE, contextWindow = MessageContext.CONTEXT_WINDOW) {
        this.contextFile = contextFile;
        this.contextWindow = contextWindow;
        this.messages = [];
    }

    push(message) {
        this.messages.push(message);
    }

    pop() {
        return this.messages.pop();
    }

    /*
     * Returns context prepared for API request (strips local meta-data, optionally prunes redundant messages).
     */
    prepared(livepruneEnabled) {
        const messages = this.messages;

        if (!livepruneEnabled) {
            return messages;
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

    async load() {
        try {
            const data = await fs.readFile(this.contextFile, 'utf-8');
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
                console.log(`📂 Loaded context (${parsed.length} messages)`);
                this.messages = parsed;
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

    async save() {
        try {
            // Save only user/assistant/tool messages (skip system prompt)
            const toSave = this.messages.filter(m => m.role !== 'system');
            await fs.writeFile(this.contextFile, JSON.stringify(toSave, null, 2), 'utf-8');
            console.log(`💾 Saved context (${toSave.length} messages)`);
        } catch (err) {
            console.log(`⚠️  Warning: Could not save context: ${err.message}`);
        }
    }

    /**
     * Get statistics about the current context.
     */
    getStatistics(livepruneEnabled) {
        const messages = this.messages;
        const fullCount = messages.length;
        const prunedMessages = this.prepared(livepruneEnabled);
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

        return {
            fullCount,
            prunedCount,
            removedCount,
            fullTokens,
            prunedTokens,
            roleCounts,
            toolCallCounts,
            readFiles: [...readFiles]
        };
    }
}
