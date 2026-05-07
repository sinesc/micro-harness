import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export class MessageContext {

    messages;
    forgottenFiles;

    static _getConfigDir() {
        return path.join(os.homedir(), '.config', 'micro-harness');
    }

    static _contextFilePath(projectPath) {
        const configDir = MessageContext._getConfigDir();
        const safeProjectPath = projectPath.replace(/[\\/]/g, '-');
        return path.join(configDir, `context.${safeProjectPath}.json`);
    }

    constructor() {
        this.messages = [];
        this.forgottenFiles = new Set();

        const cwd = process.cwd();
        this.contextFile = MessageContext._contextFilePath(cwd);
    }

    push(message) {
        this.messages.push(message);
    }

    pop() {
        return this.messages.pop();
    }

    reset() {
        this.messages = [];
    }

    /*
     * Returns context prepared for API request (strips local meta-data, optionally prunes redundant messages).
     */
    prepared(systemPrompt, livepruneEnabled) {
        let messages = [ { role: 'system', content: systemPrompt }, ...this.messages ];

        if (!livepruneEnabled) {
            return messages.map(m => this._stripMeta(m));
        }

        // Build lookup maps
        const toolCallMap = this._buildToolCallMap(messages);
        const previewMap = this._buildPreviewMap(messages, toolCallMap);

        // Iterate backwards through messages, building pruned result
        const result = [];
        const processedIndices = new Set();
        const fullFilesEncountered = new Set();
        let userMessageEncountered = false;

        for (let i = messages.length - 1; i >= 0; i--) {
            if (processedIndices.has(i)) continue;

            const msg = messages[i];

            switch (msg.role) {
                case 'system':
                    result.push(msg);
                    processedIndices.add(i);
                    break;

                case 'user':
                    userMessageEncountered = true;
                    result.push(this._stripMeta(msg));
                    processedIndices.add(i);
                    break;

                case 'tool':
                    this._handleToolResult(msg, i, messages, toolCallMap, previewMap, fullFilesEncountered, userMessageEncountered, result, processedIndices);
                    break;

                case 'assistant':
                    if (!msg.tool_calls) {
                        result.push(this._stripMeta(msg));
                        processedIndices.add(i);
                    }
                    // Messages with tool_calls are handled when their tool results are processed
                    break;

                default:
                    result.push(this._stripMeta(msg));
                    processedIndices.add(i);
            }
        }

        return result.reverse();
    }

    /* ------------------------------------------------------------------ */
    /*  Map builders                                                       */
    /* ------------------------------------------------------------------ */

    /**
     * Build tool_call_id -> [callIndex, resultIndex] map.
     */
    _buildToolCallMap(messages) {
        const toolCallMap = new Map();
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.role === 'assistant' && msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    for (let j = i + 1; j < messages.length; j++) {
                        if (messages[j].role === 'tool' && messages[j].tool_call_id === tc.id) {
                            toolCallMap.set(tc.id, [i, j]);
                            break;
                        }
                    }
                }
            }
        }
        return toolCallMap;
    }

    /**
     * Build preview_id -> edit_file result index map.
     */
    _buildPreviewMap(messages, toolCallMap) {
        const previewMap = new Map();
        for (const [callIndex, resultIndex] of toolCallMap.values()) {
            const callMsg = messages[callIndex];
            const resultMsg = messages[resultIndex];
            if (callMsg.tool_calls) {
                for (const tc of callMsg.tool_calls) {
                    if (tc.function.name === 'edit_file') {
                        const args = this._parseArgs(tc.function.arguments);
                        if (args.preview === true && resultMsg.content) {
                            const match = resultMsg.content.match(/Preview \[(\w+)\]:/);
                            if (match) {
                                previewMap.set(match[1], resultIndex);
                            }
                        }
                    }
                }
            }
        }
        return previewMap;
    }

    /* ------------------------------------------------------------------ */
    /*  Tool result handler                                                */
    /* ------------------------------------------------------------------ */

    /**
     * Handle a tool result message during pruning.
     */
    _handleToolResult(msg, resultIndex, messages, toolCallMap, previewMap, fullFilesEncountered, userMessageEncountered, result, processedIndices) {
        const tcId = msg.tool_call_id;
        const mapping = toolCallMap.get(tcId);

        if (!mapping) return; // Orphaned tool result, skip

        const [callIndex, callResultIndex] = mapping;
        const callMsg = messages[callIndex];
        const tc = callMsg.tool_calls?.find(tc => tc.id === tcId);
        if (!tc) return;

        const toolName = tc.function.name;

        // Failed tool calls: discard both call and result
        if (msg._toolError) {
            processedIndices.add(callIndex);
            processedIndices.add(callResultIndex);
            return;
        }

        // Dispatch to tool-specific handler
        switch (toolName) {
            case 'read_file':
                this._handleReadFile(msg, callMsg, tc, fullFilesEncountered, userMessageEncountered, result, processedIndices, callIndex, callResultIndex);
                break;
            case 'edit_file':
                this._handleEditFile(msg, callMsg, tc, toolCallMap, previewMap, messages, fullFilesEncountered, userMessageEncountered, result, processedIndices, callIndex, callResultIndex);
                break;
            case 'apply_preview':
                this._handleApplyPreview(msg, callMsg, tc, toolCallMap, previewMap, messages, fullFilesEncountered, userMessageEncountered, result, processedIndices, callIndex, callResultIndex);
                break;
            default:
                this._pushCallAndResult(result, callMsg, msg, processedIndices, callIndex, callResultIndex);
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Tool-specific handlers                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Handle read_file pruning:
     * - Full reads: keep only the last one per file
     * - Partial reads: keep only if before last user msg OR file not fully read since
     */
    _handleReadFile(msg, callMsg, tc, fullFilesEncountered, userMessageEncountered, result, processedIndices, callIndex, resultIndex) {
        const args = this._parseArgs(tc.function.arguments);
        const filePath = args.path;
        const isFullRead = args.start_line === undefined && args.end_line === undefined;

        // Skip read_file results for forgotten files
        if (this.forgottenFiles.has(filePath)) {
            processedIndices.add(callIndex);
            processedIndices.add(resultIndex);
            return;
        }

        if (isFullRead) {
            if (fullFilesEncountered.has(filePath)) {
                processedIndices.add(callIndex);
                processedIndices.add(resultIndex);
                return; // Skip duplicate full read
            }
            fullFilesEncountered.add(filePath);
        } else if (userMessageEncountered && fullFilesEncountered.has(filePath)) {
            // Partial read before last user msg, but file fully read since -> discard
            processedIndices.add(callIndex);
            processedIndices.add(resultIndex);
            return;
        }

        this._pushCallAndResult(result, callMsg, msg, processedIndices, callIndex, resultIndex);
    }

    /**
     * Handle edit_file pruning:
     * - Previews: keep only if before last user msg AND file not fully read since
     *     - Accepted: replace with "Edit successful.", skip apply_preview
     *     - Rejected: replace with "Anchor mismatch"
     * - Non-preview edits: skip if before last user msg AND file fully read since
     */
    _handleEditFile(msg, callMsg, tc, toolCallMap, previewMap, messages, fullFilesEncountered, userMessageEncountered, result, processedIndices, callIndex, resultIndex) {
        const args = this._parseArgs(tc.function.arguments);
        const filePath = args.path;
        const isPreview = args.preview === true;

        if (isPreview) {
            if (userMessageEncountered && fullFilesEncountered.has(filePath)) {
                // Preview pruned - check if it was accepted
                const previewMatch = msg.content?.match(/Preview \[(\w+)\]:/);
                const previewId = previewMatch ? previewMatch[1] : null;

                let wasAccepted = false;
                if (previewId) {
                    for (const [pCallIdx, pResultIdx] of toolCallMap.values()) {
                        const pCallMsg = messages[pCallIdx];
                        if (pCallMsg.tool_calls) {
                            for (const ptc of pCallMsg.tool_calls) {
                                if (ptc.function.name === 'apply_preview') {
                                    const pArgs = this._parseArgs(ptc.function.arguments);
                                    if (pArgs.id === previewId) {
                                        wasAccepted = true;
                                        processedIndices.add(pCallIdx);
                                        processedIndices.add(pResultIdx);
                                        break;
                                    }
                                }
                            }
                        }
                        if (wasAccepted) break;
                    }
                }

                result.push({
                    role: 'tool',
                    content: wasAccepted ? 'Edit successful.' : 'Anchor mismatch',
                    tool_call_id: tc.id
                });
                processedIndices.add(callIndex);
                processedIndices.add(resultIndex);
                return;
            }
            // Keep preview as-is
            this._pushCallAndResult(result, callMsg, msg, processedIndices, callIndex, resultIndex);
            return;
        }

        // Non-preview edit: skip if before last user msg AND file fully read since
        if (userMessageEncountered && fullFilesEncountered.has(filePath)) {
            const isSuccess = msg.content?.includes('Edit successful');
            result.push({
                role: 'tool',
                content: isSuccess ? 'Edit successful.' : 'Edit failed.',
                tool_call_id: tc.id
            });
            processedIndices.add(callIndex);
            processedIndices.add(resultIndex);
            return;
        }

        this._pushCallAndResult(result, callMsg, msg, processedIndices, callIndex, resultIndex);
    }

    /**
     * Handle apply_preview pruning:
     * - Skip if associated edit_file preview was pruned
     * - Skip if before last user msg AND file fully read since
     */
    _handleApplyPreview(msg, callMsg, tc, toolCallMap, previewMap, messages, fullFilesEncountered, userMessageEncountered, result, processedIndices, callIndex, resultIndex) {
        const args = this._parseArgs(tc.function.arguments);
        const previewId = args.id;

        const editResultIndex = previewMap.get(previewId);

        // Skip if associated edit_file preview was already pruned
        if (editResultIndex !== undefined && processedIndices.has(editResultIndex)) {
            processedIndices.add(callIndex);
            processedIndices.add(resultIndex);
            return;
        }

        // Skip if before last user msg AND file fully read since
        if (editResultIndex !== undefined && userMessageEncountered) {
            const editCallMsg = messages[editResultIndex - 1]; // FIXME: assumes the tool result is immediately after the assistant call - may not hold if there are interleaved messages.
            const editTc = editCallMsg.tool_calls?.find(tc => {
                const a = this._parseArgs(tc.function.arguments);
                return a.preview === true;
            });
            if (editTc) {
                const editArgs = this._parseArgs(editTc.function.arguments);
                if (fullFilesEncountered.has(editArgs.path)) {
                    processedIndices.add(callIndex);
                    processedIndices.add(resultIndex);
                    return;
                }
            }
        }

        this._pushCallAndResult(result, callMsg, msg, processedIndices, callIndex, resultIndex);
    }

    /* ------------------------------------------------------------------ */
    /*  Utility helpers                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Push stripped call and result to the result array, marking indices as processed.
     */
    _pushCallAndResult(result, callMsg, toolMsg, processedIndices, callIndex, resultIndex) {
        result.push(this._stripMeta(toolMsg));
        result.push(this._stripMeta(callMsg));
        processedIndices.add(callIndex);
        processedIndices.add(resultIndex);
    }

    /**
     * Parse JSON arguments from a tool call, safely handling invalid JSON.
     */
    _parseArgs(argsStr) {
        try {
            return JSON.parse(argsStr);
        } catch {
            return {};
        }
    }

    /**
     * Strip internal metadata from a message for API transmission.
     */
    _stripMeta(msg) {
        const stripped = { role: msg.role, content: msg.content };
        if (msg.reasoning_content) stripped.reasoning_content = msg.reasoning_content;
        if (msg.tool_calls) stripped.tool_calls = msg.tool_calls;
        if (msg.tool_call_id) stripped.tool_call_id = msg.tool_call_id;
        return stripped;
    }

    async load() {
        try {
            const data = await fs.readFile(this.contextFile, 'utf-8');
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed.messages) && Array.isArray(parsed.forgottenFiles)) {
                this.messages = parsed.messages;
                this.forgottenFiles = new Set(parsed.forgottenFiles);
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
            const messages = this.messages.filter(m => m.role !== 'system');
            const forgottenFiles = Array.from(this.forgottenFiles);
            await fs.writeFile(this.contextFile, JSON.stringify({ messages, forgottenFiles }, null, 2), 'utf-8');
        } catch (err) {
            console.log(`⚠️  Warning: Could not save context: ${err.message}`);
        }
    }

    /**
     * Get statistics about the current context.
     */
    getStatistics(systemPrompt) {
        const messages = this.prepared(systemPrompt, false);
        const fullCount = messages.length;
        const prunedMessages = this.prepared(systemPrompt, true);
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
