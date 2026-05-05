import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export class ToolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ToolError';
    }
}

export class Tool {
    lastErrorCall = null;

    constructor(application) {
        this.application = application;
        // Track cumulative offsets per file: Map<filePath, Map<lineNum, offset>>
        this.fileOffsetMaps = new Map();
        // File edit history for undo
        this.editHistory = [];
        // Track file checksums to detect external changes
        this.fileChecksums = new Map();
        // Files that have been successfully edited since the last read_file call
        this.filesDirtyAfterRead = new Set();
        // Pending previews awaiting apply_preview: Map<id, pendingEdit>
        this.pendingPreviews = new Map();
    }

    static TOOLS = [
        {
            type: 'function',
            function: {
                name: 'list_files',
                description: 'List files and directories in a given path.',
                parameters: {
                    type: 'object',
                    properties: { dir: { type: 'string', description: 'Directory path to list' } },
                    required: ['dir']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'read_file',
                description: 'Read file contents. The output includes authoritative line numbers followed by a tab character followed by the line content.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                        start_line: { type: 'integer', description: 'Starting line number (1-indexed). If omitted, reads from the beginning.' },
                        end_line: { type: 'integer', description: 'Ending line number (1-indexed). If omitted, reads to the end.' }
                    },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'create_file',
                description: 'Create a new file or overwrite an existing one.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                        content: { type: 'string', description: 'File content' }
                    },
                    required: ['path', 'content']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'edit_file',
                description: 'Replace an inclusive range of lines (start_line through end_line) with new content. To prevent accidental line removal, the replacement MUST include anchor lines above and/or below your changes that match the file exactly.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                        start_line: {
                            description: 'Start of the replacement range (1-indexed). Unless this is line 1 of the file, the first line of replacement must exactly match its current content.',
                            type: 'integer',
                        },
                        end_line: {
                            description: 'End of the replacement range (1-indexed). Unless this is the last line of the file, the last line of replacement must exactly match its current content.',
                            type: 'integer',
                        },
                        replacement: { type: 'string', description: 'New content for the range. Must begin with the exact text of start_line (leading anchor) and end with the exact text of end_line (trailing anchor), unless those lines are at the file boundary.' },
                        preview: { type: 'boolean', description: 'If true, return a preview of the edit without applying it. Returns a preview ID that can be passed to apply_preview to apply the edit.' }
                    },
                    required: ['path', 'start_line', 'end_line', 'replacement']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'apply_preview',
                description: 'Apply a pending edit that was previously previewed by edit_file. Use the 8-character ID returned in the preview.',
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: '8-character preview ID returned by edit_file' }
                    },
                    required: ['id']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'forget_file',
                description: 'Forget a file from the context. Read_file results for this file will be pruned from the prepared context.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path to forget' }
                    },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'undo',
                description: 'Undo the last edit_file operation, restoring the file to its previous state.',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'search_files',
                description: 'Search for files matching a pattern and optionally search their contents. Returns file paths and matching line numbers.',
                parameters: {
                    type: 'object',
                    properties: {
                        pattern: { type: 'string', description: 'Regex pattern to search for in file contents' },
                        dir: { type: 'string', description: 'Directory to search in (defaults to current directory)' },
                        file_pattern: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.js", "*.md")' },
                        max_results: { type: 'integer', description: 'Maximum number of results to return (default: 50)' }
                    },
                    required: ['pattern']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'syntax_check',
                description: 'Check JavaScript syntax using acorn. Returns success or error message. Only works for .js files.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path to check (must be a .js file)' }
                    },
                    required: ['path']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'calc',
                description: 'Calculate the result of a mathematical expression. Supports operations + - * / %',
                parameters: {
                    type: 'object',
                    properties: {
                        expression: { type: 'string', description: 'The mathematical expression to evaluate' }
                    },
                    required: ['expression']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'todo',
                description: 'Use this to provide a brief overview or todo list before planning/implementing details.',
                parameters: {
                    type: 'object',
                    properties: {
                        text: { type: 'string', description: 'The text to output' }
                    },
                    required: ['text']
                }
            }
        }
    ];

    async list_files({ dir }) {
        const resolvedDir = this._resolvePath(dir);
        try {
            const entries = await fs.readdir(resolvedDir, { withFileTypes: true });
            return entries.filter(e => e.name.slice(0, 1) !== '_' && e.name.slice(0, 8) !== 'context.').map(e => `${e.isDirectory() ? '📁 ' : '📄 '}${e.name}`).join('\n');
        } catch (err) {
            throw new ToolError(`Cannot list directory '${dir}': ${err.message}`);
        }
    }

    async read_file({ path: filePath, start_line, end_line }) {
        const resolvedPath = this._resolvePath(filePath);
        try {
            const content = await fs.readFile(resolvedPath, 'utf-8');
            // Reset offsets for this file since we re-read it
            if (this.fileOffsetMaps.has(resolvedPath)) {
                this.fileOffsetMaps.delete(resolvedPath);
            }
            this.fileChecksums.set(resolvedPath, this.#computeChecksum(content));
            this.filesDirtyAfterRead.delete(resolvedPath);

            // Invalidate any pending previews for this file
            for (const [id, preview] of this.pendingPreviews) {
                if (preview.filePath === resolvedPath) {
                    this.pendingPreviews.delete(id);
                }
            }

            // Remove file from forgotten list so it can be read again
            const relativePath = path.relative(process.cwd(), resolvedPath);
            this.application.context.forgottenFiles.delete(relativePath);

            const lines = content.split(/\r?\n/);
            const totalLines = lines.length;

            // Parse and validate line range
            let startIdx = 0; // 0-indexed
            let endIdx = totalLines - 1; // 0-indexed

            if (start_line !== undefined && start_line !== null) {
                const startLineNum = parseInt(start_line, 10);
                if (isNaN(startLineNum)) {
                    throw new ToolError(`'start_line' must be an integer.`);
                }
                if (startLineNum < 1) {
                    throw new ToolError(`'start_line' must be >= 1.`);
                }
                if (startLineNum > totalLines) {
                    throw new ToolError(`'start_line' ${startLineNum} exceeds total lines ${totalLines}.`);
                }
                startIdx = startLineNum - 1; // Convert to 0-indexed
            }

            if (end_line !== undefined && end_line !== null) {
                const endLineNum = parseInt(end_line, 10);
                if (isNaN(endLineNum)) {
                    throw new ToolError(`'end_line' must be an integer.`);
                }
                if (endLineNum < 1) {
                    throw new ToolError(`'end_line' must be >= 1.`);
                }
                if (endLineNum > totalLines) {
                    throw new ToolError(`'end_line' ${endLineNum} exceeds total lines ${totalLines}.`);
                }
                endIdx = endLineNum - 1; // Convert to 0-indexed
            }

            if (startIdx > endIdx) {
                throw new ToolError(`'end_line' must be greater than or equal to 'start_line'.`);
            }

            // Extract the requested range
            const selectedLines = lines.slice(startIdx, endIdx + 1);
            return selectedLines.map((text, index) => `${startIdx + index + 1}\t${text}`).join("\n");
        } catch (err) {
            if (err instanceof ToolError) {
                throw err;
            }
            throw new ToolError(`Cannot read file '${filePath}': ${err.message}`);
        }
    }

    async create_file({ path: filePath, content }) {
        const resolvedPath = this._resolvePath(filePath);
        try {
            await fs.writeFile(resolvedPath, content, 'utf-8');
            this.fileChecksums.set(resolvedPath, this.#computeChecksum(content));  // Set initial checksum
            return `Created file ${filePath} with ${content.split(/\r?\n/).length} line(s).`;
        } catch (err) {
            throw new ToolError(`Cannot create file '${filePath}': ${err.message}`);
        }
    }

    async undo() {
        if (this.editHistory.length === 0) {
            throw new ToolError('No edits to undo. Trying to undo a preview? Previews are not written to file until applied. There is nothing to undo yet.');
        }

        const lastEdit = this.editHistory.pop();
        const filePath = lastEdit.path;
        const content = lastEdit.content;
        const offsetMap = lastEdit.offsetMap;

        // Write the file back to its previous state
        await fs.writeFile(filePath, content, 'utf-8');

        // Restore the offset map for this file
        this.fileOffsetMaps.set(filePath, new Map(offsetMap));

        // Restore the checksum
        this.fileChecksums.set(filePath, this.#computeChecksum(content));

        // Convert absolute path to relative path for the return message
        const relativePath = path.relative(process.cwd(), filePath);
        return `Undid the last edit on ${relativePath}.`;
    }

    async search_files({ pattern, dir = '.', file_pattern = null, max_results = 50 }) {
        const resolvedDir = this._resolvePath(dir);
        const results = [];
        const regex = new RegExp(pattern, 'i'); // case-insensitive by default

        async function searchDir(currentDir) {
            const entries = await fs.readdir(currentDir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = `${currentDir}/${entry.name}`;

                // Skip hidden directories and node_modules
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

                // Apply file pattern filter if specified
                if (file_pattern) {
                    const globRegex = Tool.#globToRegex(file_pattern);
                    if (!globRegex.test(entry.name)) continue;
                }

                if (entry.isDirectory()) {
                    await searchDir(fullPath);
                } else {
                    try {
                        const content = await fs.readFile(fullPath, 'utf-8');
                        const lines = content.split(/\r?\n/);

                        for (let i = 0; i < lines.length; i++) {
                            if (regex.test(lines[i])) {
                                results.push({
                                    file: fullPath,
                                    line: i + 1,
                                    content: lines[i].trim()
                                });

                                if (results.length >= max_results) return;
                            }
                        }
                    } catch (err) {
                        // Skip files we can't read (binary, permissions, etc.)
                    }
                }
            }
        }

        await searchDir.call(this, dir);

        if (results.length === 0) {
            return `No matches found for pattern "${pattern}"${file_pattern ? ` in files matching "${file_pattern}"` : ''}.`;
        }

        const output = results.map(r => `${r.file}:${r.line}: ${r.content}`).join('\n');
        const total = results.length;
        return `${output}\n\n---\nTotal: ${total} match(es) found.`;
    }

    async edit_file({ path: filePath, start_line, end_line, replacement, preview = false }) {
        // --- Parameter validation ---
        if (start_line === undefined || start_line === null)
            throw new ToolError(`Specify 'start_line' for the edit.`);
        if (end_line === undefined || end_line === null)
            throw new ToolError(`Specify 'end_line' for the edit.`);
        if (filePath === undefined || filePath === null)
            throw new ToolError(`Specify 'path' of the file to edit.`);
        if (typeof filePath !== 'string')
            throw new ToolError(`'path' must be a string.`);
        if (replacement === undefined || replacement === null)
            throw new ToolError(`Specify 'replacement' to perform.`);
        if (typeof replacement !== 'string')
            throw new ToolError(`'replacement' must be a string.`);

        const startLine = parseInt(start_line, 10);
        const endLine = parseInt(end_line, 10);

        if (isNaN(startLine))
            throw new ToolError(`'start_line' must be an integer.`);
        if (isNaN(endLine))
            throw new ToolError(`'end_line' must be an integer.`);
        if (startLine < 1)
            throw new ToolError(`'start_line' must be >= 1.`);
        if (endLine < 1)
            throw new ToolError(`'end_line' must be >= 1.`);
        if (startLine > endLine)
            throw new ToolError(`'end_line' must be greater than 'start_line'.`);

        // --- File read and checksum ---
        const resolvedPath = this._resolvePath(filePath);
        const fileContent = await fs.readFile(resolvedPath, 'utf-8');

        const previousChecksum = this.fileChecksums.get(resolvedPath);
        const currentChecksum = this.#computeChecksum(fileContent);
        if (previousChecksum && previousChecksum !== currentChecksum)
            throw new ToolError(`File '${filePath}' modified externally. Call read_file first, then retry the edit.`);

        const dirty = this.filesDirtyAfterRead.has(resolvedPath);
        const offsetMap = this.#getFileOffsetMap(resolvedPath);
        const lines = fileContent.split(/\r?\n/);

        const actualStart = startLine + this.#getOffset(offsetMap, startLine);
        if (actualStart < 1 || actualStart > lines.length)
            throw new ToolError(`start_line out of bounds after previous edits. Re-read the file.`);
        let startIdx = actualStart - 1;

        const actualEnd = endLine + this.#getOffset(offsetMap, endLine);
        if (actualEnd < 1 || actualEnd > lines.length)
            throw new ToolError(`end_line out of bounds after previous edits. Re-read the file.`);
        let endIdx = actualEnd - 1;

        if (endIdx < startIdx)
            throw new ToolError(`Range invalid after previous edits. Re-read the file.`);

        // Strip one trailing newline before splitting so that a line-terminated
        // replacement ("foo\n") is treated as one line, not two.
        const newLines = replacement === '' ? [] : replacement.replace(/\r?\n$/, '').split(/\r?\n/); // TODO needs model response testing

        const atBoundary = actualStart === 1 || actualEnd === lines.length;

        if (newLines.length < 2 && !atBoundary) {
            throw new ToolError(`Replacement MUST contain at least two lines: the top anchor line, optionally a replacement (omit to delete), the bottom anchor line.`);
        }

        if (actualEnd - actualStart < 1 && !atBoundary) {
            throw new ToolError(`'end_line' must be greater than 'start_line' since the first and last line of your edit are REQUIRED to be unmodified anchor lines. If editing a single line, include the line above and below it in your edit.`);
        }

        // Anchor validation: the first/last lines of replacement must match the
        // file at start_line/end_line to prevent silently dropping content.
        // Anchors are waived at file boundaries.  Resolution priority per anchor:
        //   1. exact at expected position  2. trim at expected position
        //   3. exact fuzzy ±x lines        4. trim fuzzy ±x lines
        const FUZZY_RADIUS = 10;
        let endDelta = 0;
        let startTrimFixed = false;
        let endTrimFixed = false;
        let startError = null;
        let endError = null;

        if (startIdx !== 0) {
            if (newLines.length === 0)
                throw new ToolError(
                    `'replacement' is empty but 'start_line' ${startLine} is not the first line of the file.\n` +
                    `The first line of 'replacement' must exactly match line ${actualStart} as a leading anchor:\n` +
                    `  "${lines[startIdx]}"`
                );
            try {
                ({ idx: startIdx, trimFixed: startTrimFixed } =
                    this.#resolveAnchor(lines, newLines[0], startIdx, FUZZY_RADIUS, 'Leading', dirty));
            } catch (e) {
                startError = e;
            }
        }

        if (endIdx !== lines.length - 1) {
            if (newLines.length === 0)
                throw new ToolError(
                    `'replacement' is empty but 'end_line' ${endLine} is not the last line of the file.\n` +
                    `The last line of 'replacement' must exactly match line ${actualEnd} as a trailing anchor:\n` +
                    `  "${lines[endIdx]}"`
                );
            try {
                ({ idx: endIdx, delta: endDelta, trimFixed: endTrimFixed } =
                    this.#resolveAnchor(lines, newLines[newLines.length - 1], endIdx, FUZZY_RADIUS, 'Trailing', dirty));
            } catch (e) {
                endError = e;
            }
        }

        // Both anchors failed — nothing to go on
        if (startError && endError) throw startError;

        // One anchor failed or preview requested — generate a preview rather than applying
        if (startError || endError || preview) {
            const newLinesForApply = [...newLines];
            if (startTrimFixed) newLinesForApply[0] = lines[startIdx];
            if (endTrimFixed) newLinesForApply[newLinesForApply.length - 1] = lines[endIdx];
            let reason = (startError || endError)
                ? 'One anchor matched but the other did not — check this preview for unintentionally duplicated/removed lines.'
                : null;
            const fullContentLines = [...lines.slice(0, startIdx), ...newLinesForApply, ...lines.slice(endIdx + 1)];
            const fullContent = fullContentLines.join('\n');
            const syntaxError = await this.#check_file(fullContent, resolvedPath);
            if (syntaxError) {
                reason = reason ? reason + '\n\n' : '';
                reason += `Syntax error in the requested edit: ${syntaxError}`;
            }

            return this.#generatePreviewResponse(
                filePath, fileContent, currentChecksum, lines, offsetMap,
                startIdx, endIdx, newLinesForApply, startLine, endLine + endDelta, reason
            );
        }

        // Restore correct whitespace in any trim-matched anchor lines so the file
        // is not written back with the model's incorrect indentation.
        if (startTrimFixed) newLines[0] = lines[startIdx];
        if (endTrimFixed) newLines[newLines.length - 1] = lines[endIdx];

        // Re-validate range after fuzzy corrections
        if (endIdx < startIdx)
            throw new ToolError(`Range invalid after previous edits. Re-read the file.`);

        this.editHistory.push({ path: resolvedPath, content: fileContent, offsetMap: new Map(offsetMap) });

        this.#editSplice(offsetMap, lines, startIdx, endIdx - startIdx + 1, newLines, startLine, endLine + endDelta);

        const newContent = lines.join('\n');
        const syntaxError = await this.#check_file(newContent, resolvedPath);
        if (syntaxError) {
            const reason = `Syntax error in the requested edit: ${syntaxError}`;
            return this.#generatePreviewResponse(
                filePath, fileContent, currentChecksum, lines, offsetMap,
                startIdx, endIdx, newLines, startLine, endLine + endDelta, reason
            );
        }
        await fs.writeFile(resolvedPath, newContent, 'utf-8');
        this.fileChecksums.set(resolvedPath, this.#computeChecksum(newContent));
        this.filesDirtyAfterRead.add(resolvedPath);
        return 'Edit successful.';
    }

    async apply_preview({ id }) {
        const pending = this.pendingPreviews.get(id);
        if (!pending)
            throw new ToolError(`No pending preview with id '${id}'. It may have already been applied or the id is incorrect.`);

        const { filePath, fileContent, checksum, offsetMapSnapshot, startIdx, endIdx, newLines, startLine, logicalEndLine } = pending;

        const currentContent = await fs.readFile(filePath, 'utf-8');
        if (this.#computeChecksum(currentContent) !== checksum)
            throw new ToolError(`File '${filePath}' changed since this preview was generated. Re-read the file and retry the edit.`);

        const lines = currentContent.split(/\r?\n/);

        this.fileOffsetMaps.set(filePath, new Map(offsetMapSnapshot));
        const liveOffsetMap = this.fileOffsetMaps.get(filePath);

        this.editHistory.push({ path: filePath, content: fileContent, offsetMap: new Map(offsetMapSnapshot) });
        this.#editSplice(liveOffsetMap, lines, startIdx, endIdx - startIdx + 1, newLines, startLine, logicalEndLine);

        const newContent = lines.join('\n');
        await fs.writeFile(filePath, newContent, 'utf-8');
        this.fileChecksums.set(filePath, this.#computeChecksum(newContent));
        this.filesDirtyAfterRead.add(filePath);
        this.pendingPreviews.delete(id);
        return 'Edit successful.';
    }

    async syntax_check({ path: filePath }) {
        const resolvedPath = this._resolvePath(filePath);
        const content = await fs.readFile(resolvedPath, 'utf-8');
        const error = await this.#check_file(content, resolvedPath);
        if (error) {
            throw new ToolError(error);
        }
        return `Syntax check passed for ${filePath}.`;
    }

    calc({ expression }) {
        const filtered = expression.replace(/[^0-9+\.\-*/%]/g, '');
        try {
            const result = new Function('return ' + filtered)();
            return `Result: ${result}`;
        } catch (err) {
            throw new ToolError(`Could not evaluate expression "${filtered}": ${err.message}`);
        }
    }

    todo({ text }) {
        console.log(`\n${text}\n`);
        return text;
    }

    forget_file({ path: filePath }) {
        const resolvedPath = this._resolvePath(filePath);
        const relativePath = path.relative(process.cwd(), resolvedPath);
        this.application.context.forgottenFiles.add(relativePath);
        return `You have removed '${filePath}' from context because you have completed your work with the file and do not need it anymore.`;
    }

    // --- Helper functions ---

    /**
     * Resolves a relative path against the current working directory.
     * Validates that the path is relative and resolves within the working directory.
     * @param {string} relativePath - A relative path to resolve
     * @returns {string} The fully resolved absolute path
     * @throws {ToolError} If path is absolute or resolves outside the working directory
     */
    _resolvePath(relativePath) {
        if (path.isAbsolute(relativePath)) {
            throw new ToolError(`Absolute paths not allowed. Provide a relative path.`);
        }

        const resolved = path.resolve(process.cwd(), relativePath);
        const cwd = process.cwd();

        // Ensure the resolved path starts with the working directory
        // Use path.sep to handle both Unix and Windows paths correctly
        if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
            throw new ToolError(
                `Path '${relativePath}' resolves outside the working directory. ` +
                `Resolved path: '${resolved}'. ` +
                `Provide a path within the current working directory.`
            );
        }

        const protectedFiles = [ '.git' ];

        for (const protectedFile of protectedFiles) {
            const protectedPath = cwd + path.sep + protectedFile;
            if (resolved.startsWith(protectedPath + path.sep) || resolved === protectedPath) {
                throw new ToolError(`Direct access to ${protectedFile} is not allowed.`);
            }
        }

        return resolved;
    }

    #getFileOffsetMap(filePath) {
        if (!this.fileOffsetMaps.has(filePath)) {
            this.fileOffsetMaps.set(filePath, new Map());
        }
        return this.fileOffsetMaps.get(filePath);
    }

    #computeChecksum(content) {
        return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    }

    #getOffset(offsetMap, lineNum) {
        // Sort by key so we always pick the largest breakpoint <= lineNum,
        // regardless of insertion order.
        let offset = 0;
        for (const [line, off] of [...offsetMap].sort((a, b) => a[0] - b[0])) {
            if (line <= lineNum) offset = off;
            else break;
        }
        return offset;
    }

    #generatePreviewResponse(filePath, fileContent, checksum, lines, offsetMap, startIdx, endIdx, newLines, startLine, logicalEndLine, reason) {
        const id = crypto.randomUUID().split('-')[0];

        this.pendingPreviews.set(id, {
            filePath, fileContent, checksum,
            offsetMapSnapshot: new Map(offsetMap),
            startIdx, endIdx, newLines, startLine, logicalEndLine,
        });

        const CONTEXT = 3;
        const MAX_CHANGED = 10;
        const half = Math.floor(MAX_CHANGED / 2);

        const output = [];
        if (reason) output.push(reason + '\n');
        output.push(`Preview [${id}]:\n`);

        // Context before
        for (let i = Math.max(0, startIdx - CONTEXT); i < startIdx; i++)
            output.push(`${i + 1}\t${lines[i]}`);

        // Removed lines (old content)
        /*const removedCount = endIdx - startIdx + 1;
        if (removedCount <= MAX_CHANGED) {
            for (let i = startIdx; i <= endIdx; i++)
                output.push(`- ${i + 1} │ ${lines[i]}`);
        } else {
            for (let i = startIdx; i < startIdx + half; i++)
                output.push(`- ${i + 1} │ ${lines[i]}`);
            output.push(`- ... (${removedCount - MAX_CHANGED} more lines)`);
            for (let i = endIdx - half + 1; i <= endIdx; i++)
                output.push(`- ${i + 1} │ ${lines[i]}`);
        }*/

        // Added lines (new content)
        if (newLines.length <= MAX_CHANGED) {
            for (const l of newLines)
                output.push(`+\t${l}`);
        } else {
            for (let i = 0; i < half; i++)
                output.push(`+\t${newLines[i]}`);
            output.push(`+ ... (${newLines.length - MAX_CHANGED} more lines)`);
            for (let i = newLines.length - half; i < newLines.length; i++)
                output.push(`+\t${newLines[i]}`);
        }

        // Context after
        for (let i = endIdx + 1; i <= Math.min(lines.length - 1, endIdx + CONTEXT); i++)
            output.push(`${i + 1}\t${lines[i]}`);

        output.push(`\nRetry your edit if this is not correct, otherwise call apply_preview {"id":"${id}"} to apply. This is a preview, file not yet modified!`);
        return output.join('\n');
    }

    // Resolves one anchor (leading or trailing) against the file's lines.
    // Priority: exact at position → trim at position → exact fuzzy → trim fuzzy.
    // Returns { idx, delta, trimFixed } or throws ToolError.
    #resolveAnchor(lines, anchorText, idealIdx, radius, label, dirty) {
        if (lines[idealIdx] === anchorText)
            return { idx: idealIdx, delta: 0, trimFixed: false };

        if (lines[idealIdx].trim() === anchorText.trim())
            return { idx: idealIdx, delta: 0, trimFixed: true };

        const lo = Math.max(0, idealIdx - radius);
        const hi = Math.min(lines.length - 1, idealIdx + radius);

        const exactMatches = [];
        for (let i = lo; i <= hi; i++) {
            if (lines[i] === anchorText) exactMatches.push(i);
        }
        if (exactMatches.length === 1)
            return { idx: exactMatches[0], delta: exactMatches[0] - idealIdx, trimFixed: false };
        if (exactMatches.length > 1)
            throw new ToolError(
                `${label} anchor ambiguous — the provided line has exact matches at lines ${exactMatches.map(i => i + 1).join(', ')} within ±${radius}.\n` +
                `  Provided: "${anchorText}"\n` +
                `Use a more specific line number.`
            );

        const trimMatches = [];
        for (let i = lo; i <= hi; i++) {
            if (lines[i].trim() === anchorText.trim()) trimMatches.push(i);
        }
        if (trimMatches.length === 1)
            return { idx: trimMatches[0], delta: trimMatches[0] - idealIdx, trimFixed: true };
        if (trimMatches.length > 1)
            throw new ToolError(
                `${label} anchor ambiguous — the provided line (ignoring whitespace) has matches at lines ${trimMatches.map(i => i + 1).join(', ')} within ±${radius}.\n` +
                `  Provided: "${anchorText}"\n` +
                `Use a more specific line number.`
            );

        const rereadOrFix = dirty
            ? 'Re-read the file for the current content and line numbers.'
            : 'Fix the anchor to match the file line shown above, or re-read the file.';
        throw new ToolError(
            `${label} anchor mismatch — the provided line does not match line ${idealIdx + 1} of the file and was not found within ±${radius} lines.\n` +
            `  Provided:  "${anchorText}"\n` +
            `  File line: "${lines[idealIdx]}"\n` +
            rereadOrFix
        );
    }

    #editSplice(offsetMap, currentLines, startIdx, numDelete, insertLines, logicalStartLine, logicalEndLine) {
        currentLines.splice(startIdx, numDelete, ...insertLines);

        const netChange = insertLines.length - numDelete;
        if (netChange === 0) return;

        // Capture the cumulative offset at logicalEndLine BEFORE mutating the map,
        // so the new breakpoint value is based on the pre-edit state.
        const prevOffset = this.#getOffset(offsetMap, logicalEndLine);

        // Shift every existing breakpoint that sits beyond the edit range.
        for (const [line, off] of offsetMap) {
            if (line > logicalEndLine) {
                offsetMap.set(line, off + netChange);
            }
        }

        // Add a breakpoint at the first logical line after the edit range so
        // future numeric-line lookups get the correct cumulative offset.
        // If a breakpoint already exists there the loop above updated it correctly.
        const breakpointLine = logicalEndLine + 1;
        if (!offsetMap.has(breakpointLine)) {
            offsetMap.set(breakpointLine, prevOffset + netChange);
        }
    }

    async #check_file(content, filePath) {
        const isJSFile = filePath.endsWith('.js');
        if (!isJSFile) return null;

        const tmpFile = path.join(path.dirname(filePath), `.tmp_syntax_check_${Date.now()}.js`);
        try {
            await fs.writeFile(tmpFile, content, 'utf-8');
            let stderr;
            try {
                let result = await execAsync(`acorn --module --ecma2024 --silent "${tmpFile}"`);
                stderr = result.stderr;
            } catch (e) {
                if (e.stderr === undefined) {
                    throw new Error('Failed to run external syntax check command');
                }
                stderr = e.stderr;
            }
            if (stderr) return stderr.replace(tmpFile, 'temp_file').trim();
            return null;
        } finally {
            try {
                await fs.unlink(tmpFile);
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    }

    static #globToRegex(glob) {
        return new RegExp(
            '^' + glob
                .replace(/\./g, '\\.')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.') + '$'
        );
    }

    // --- router ---

    async exec(name, args) {
        const dump = (v) => { console.log(v); return v; };
        try {
            switch (name) {
                case 'list_files': return { result: await this.list_files(args), error: false, toolName: name };
                case 'read_file': return { result: await this.read_file(args), error: false, toolName: name };
                case 'create_file': return { result: await this.create_file(args), error: false, toolName: name };
                case 'edit_file': return { result: await this.edit_file(args), error: false, toolName: name };
                case 'apply_preview': return { result: await this.apply_preview(args), error: false, toolName: name };
                case 'undo': return { result: await this.undo(), error: false, toolName: name };
                case 'forget_file': return { result: await this.forget_file(args), error: false, toolName: name };
                case 'search_files': return { result: await this.search_files(args), error: false, toolName: name };
                case 'syntax_check': return { result: await this.syntax_check(args), error: false, toolName: name };
                case 'calc': return { result: this.calc(args), error: false, toolName: name };
                case 'todo': return { result: this.todo(args), error: false, toolName: name };
                default: return { result: `Unknown tool: ${name}`, error: true, toolName: name };
            }
        } catch (err) {
            if (err instanceof ToolError) {
                const call = JSON.stringify({ name, args });
                if (call === this.lastErrorCall) {
                    return { result: "Identical tool call detected. Read the previous error message carefully, analyse the problem and make a correct tool call.", error: true, toolName: name };
                }
                this.lastErrorCall = call;
                return { result: err.message, error: true, toolName: name };
            }
            throw err;
        }
    }
}
