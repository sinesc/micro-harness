import fs from 'fs/promises';
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

    constructor() {
        // Track cumulative offsets per file: Map<filePath, Map<lineNum, offset>>
        this.fileOffsetMaps = new Map();
        // File edit history for undo
        this.editHistory = [];
        // Track file checksums to detect external changes
        this.fileChecksums = new Map();
        // Files that have been successfully edited since the last read_file call
        this.filesDirtyAfterRead = new Set();
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
                    properties: { path: { type: 'string', description: 'File path' } },
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
                description: 'Replace an inclusive range of lines (start_line through end_line) with new content. To prevent accidental line removal, the replacement must include anchor lines that match the file exactly: unless start_line is the first line of the file, the first line of replacement must equal the current content of start_line; unless end_line is the last line of the file, the last line of replacement must equal the current content of end_line. Example — to insert "c" between lines 2 ("b") and 3 ("d") use start_line=2, end_line=3, replacement="b\\nc\\nd".',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                        start_line: {
                            description: 'Start of the replacement range (1-indexed). Unless this is line 1 of the file, the first line of replacement must exactly match its current content.',
                            oneOf: [{ type: 'integer' }, { type: 'string' }]
                        },
                        end_line: {
                            description: 'End of the replacement range (1-indexed). Unless this is the last line of the file, the last line of replacement must exactly match its current content.',
                            oneOf: [{ type: 'integer' }, { type: 'string' }]
                        },
                        replacement: { type: 'string', description: 'New content for the range. Must begin with the exact text of start_line (leading anchor) and end with the exact text of end_line (trailing anchor), unless those lines are at the file boundary.' }
                    },
                    required: ['path', 'start_line', 'end_line', 'replacement']
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
                description: 'Check JavaScript syntax for a file using `node -c`. Returns success or error message.',
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
                description: 'Calculate a number using an expression. Supports operations + - * / %',
                parameters: {
                    type: 'object',
                    properties: {
                        expression: { type: 'string', description: 'The input string to filter' }
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
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            return entries.map(e => `${e.isDirectory() ? '📁 ' : '📄 '}${e.name}`).join('\n');
        } catch (err) {
            throw new ToolError(`Cannot list directory '${dir}': ${err.message}`);
        }
    }

    async read_file({ path: filePath }) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            // Reset offsets for this file since we re-read it
            if (this.fileOffsetMaps.has(filePath)) {
                this.fileOffsetMaps.delete(filePath);
            }
            this.fileChecksums.set(filePath, this.#computeChecksum(content));
            this.filesDirtyAfterRead.delete(filePath);
            let line = 1;
            return content.split(/\r?\n/).map((text, index) => `${index+1}\t${text}`).join("\n");
        } catch (err) {
            throw new ToolError(`Cannot read file '${filePath}': ${err.message}`);
        }
    }

    async create_file({ path: filePath, content }) {
        try {
            await fs.writeFile(filePath, content, 'utf-8');
            this.fileChecksums.set(filePath, this.#computeChecksum(content));  // Set initial checksum
            return `Created file ${filePath} with ${content.split(/\r?\n/).length} line(s).`;
        } catch (err) {
            throw new ToolError(`Cannot create file '${filePath}': ${err.message}`);
        }
    }

    async undo() {
        if (this.editHistory.length === 0) {
            throw new ToolError('No edits to undo.');
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

        return `Undid the last edit on ${filePath}.`;
    }

    async search_files({ pattern, dir = '.', file_pattern = null, max_results = 50 }) {
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

    async edit_file({ path: filePath, start_line, end_line, replacement }) {
        // --- Parameter validation ---
        if (start_line === undefined || start_line === null)
            throw new ToolError(`You must specify a 'start_line' for the edit.`);
        if (end_line === undefined || end_line === null)
            throw new ToolError(`You must specify an 'end_line' for the edit.`);
        if (filePath === undefined || filePath === null)
            throw new ToolError(`You must specify the 'path' of the file you want to edit.`);
        if (typeof filePath !== 'string')
            throw new ToolError(`'path' must be an string.`);
        if (replacement === undefined || replacement === null)
            throw new ToolError(`You must specify a 'replacement' to perform.`);
        if (typeof replacement !== 'string')
            throw new ToolError(`'replacement' must be a string.`);

        const startLine = parseInt(start_line, 10);
        const endLine = parseInt(end_line, 10);

        if (isNaN(startLine))
            throw new ToolError(`'start_line' must be an integer, got ${JSON.stringify(start_line)}.`);
        if (isNaN(endLine))
            throw new ToolError(`'end_line' must be an integer, got ${JSON.stringify(end_line)}.`);
        if (startLine < 1)
            throw new ToolError(`'start_line' must be >= 1, got ${startLine}.`);
        if (endLine < 1)
            throw new ToolError(`'end_line' must be >= 1, got ${endLine}.`);
        if (startLine > endLine)
            throw new ToolError(`'start_line' (${startLine}) must not exceed 'end_line' (${endLine}).`);

        // --- File read and checksum ---
        const fileContent = await fs.readFile(filePath, 'utf-8');

        const previousChecksum = this.fileChecksums.get(filePath);
        const currentChecksum = this.#computeChecksum(fileContent);
        if (previousChecksum && previousChecksum !== currentChecksum)
            throw new ToolError(`File '${filePath}' has been modified externally since it was last read. Please call read_file first to refresh the file contents, then retry the edit.`);

        // True when the model has successfully edited this file since the last read_file call,
        // meaning re-reading will give fresher line numbers and content.
        const dirty = this.filesDirtyAfterRead.has(filePath);

        const offsetMap = this.#getFileOffsetMap(filePath);
        const lines = fileContent.split(/\r?\n/);

        const rereadOrFix = dirty ? 'Re-read the file to get current line numbers.' : 'Check that your line numbers are correct.';

        const actualStart = startLine + this.#getOffset(offsetMap, startLine);
        if (actualStart < 1 || actualStart > lines.length)
            throw new ToolError(`'start_line' ${startLine} resolves to line ${actualStart}, which is out of bounds (file has ${lines.length} line${lines.length !== 1 ? 's' : ''}). ${rereadOrFix}`);
        let startIdx = actualStart - 1;

        const actualEnd = endLine + this.#getOffset(offsetMap, endLine);
        if (actualEnd < 1 || actualEnd > lines.length)
            throw new ToolError(`'end_line' ${endLine} resolves to line ${actualEnd}, which is out of bounds (file has ${lines.length} line${lines.length !== 1 ? 's' : ''}). ${rereadOrFix}`);
        let endIdx = actualEnd - 1;

        if (endIdx < startIdx)
            throw new ToolError(`Resolved range is invalid — 'end_line' ${endLine} (actual line ${actualEnd}) is before 'start_line' ${startLine} (actual line ${actualStart}).`);

        // Strip one trailing newline before splitting so that a line-terminated
        // replacement ("foo\n") is treated as one line, not two.
        const newLines = replacement === '' ? [] : replacement.replace(/\r?\n$/, '').split(/\r?\n/);

        // Anchor validation: the first/last lines of replacement must match the
        // file at start_line/end_line to prevent silently dropping content.
        // Anchors are waived at file boundaries.  Resolution priority per anchor:
        //   1. exact at expected position  2. trim at expected position
        //   3. exact fuzzy ±3 lines        4. trim fuzzy ±3 lines
        const FUZZY_RADIUS = 5;
        let startDelta = 0;
        let endDelta = 0;
        let startTrimFixed = false;
        let endTrimFixed = false;

        if (startIdx !== 0) {
            if (newLines.length === 0)
                throw new ToolError(
                    `'replacement' is empty but 'start_line' ${startLine} is not the first line of the file.\n` +
                    `The first line of 'replacement' must exactly match line ${actualStart} as a leading anchor:\n` +
                    `  "${lines[startIdx]}"`
                );
            ({ idx: startIdx, delta: startDelta, trimFixed: startTrimFixed } =
                this.#resolveAnchor(lines, newLines[0], startIdx, FUZZY_RADIUS, 'Leading', dirty));
        }

        if (endIdx !== lines.length - 1) {
            if (newLines.length === 0)
                throw new ToolError(
                    `'replacement' is empty but 'end_line' ${endLine} is not the last line of the file.\n` +
                    `The last line of 'replacement' must exactly match line ${actualEnd} as a trailing anchor:\n` +
                    `  "${lines[endIdx]}"`
                );
            ({ idx: endIdx, delta: endDelta, trimFixed: endTrimFixed } =
                this.#resolveAnchor(lines, newLines[newLines.length - 1], endIdx, FUZZY_RADIUS, 'Trailing', dirty));
        }

        // Restore correct whitespace in any trim-matched anchor lines so the file
        // is not written back with the model's incorrect indentation.
        if (startTrimFixed) newLines[0] = lines[startIdx];
        if (endTrimFixed) newLines[newLines.length - 1] = lines[endIdx];

        // Re-validate range after fuzzy corrections
        if (endIdx < startIdx)
            throw new ToolError(`After anchor correction, the edit range is invalid — corrected start (line ${startIdx + 1}) is after corrected end (line ${endIdx + 1}).`);

        this.editHistory.push({ path: filePath, content: fileContent, offsetMap: new Map(offsetMap) });

        this.#editSplice(offsetMap, lines, startIdx, endIdx - startIdx + 1, newLines, startLine, endLine + endDelta);

        const newContent = lines.join('\n');
        await fs.writeFile(filePath, newContent, 'utf-8');
        this.fileChecksums.set(filePath, this.#computeChecksum(newContent));
        this.filesDirtyAfterRead.add(filePath);

        if (startDelta !== 0 || endDelta !== 0 || startTrimFixed || endTrimFixed) {
            const notes = [];
            if (startDelta !== 0) notes.push(`start_line shifted by ${startDelta > 0 ? '+' : ''}${startDelta}`);
            if (endDelta !== 0) notes.push(`end_line shifted by ${endDelta > 0 ? '+' : ''}${endDelta}`);
            if (startTrimFixed) notes.push('leading anchor matched after ignoring whitespace (corrected in output)');
            if (endTrimFixed) notes.push('trailing anchor matched after ignoring whitespace (corrected in output)');
            const rereadHint = startDelta !== 0 ? ' Re-read the file before making further edits near the start of the corrected range.' : '';
            return `Edit successful.`; // Note: ${notes.join('; ')}.${rereadHint}`;
        }
        return 'Edit successful.';
    }

    async syntax_check({ path: filePath }) {
        const { stdout, stderr } = await execAsync(`node -c "${filePath}"`);
        if (stderr) {
            throw new ToolError(stderr.trim());
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
        console.log(`\n${text}`);
        return text;
    }

    // --- Helper functions ---

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
                `${label} anchor is ambiguous — the provided line has exact matches at lines ${exactMatches.map(i => i + 1).join(', ')} within ±${radius}.\n` +
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
                `${label} anchor is ambiguous — the provided line (ignoring whitespace) has matches at lines ${trimMatches.map(i => i + 1).join(', ')} within ±${radius}.\n` +
                `  Provided: "${anchorText}"\n` +
                `Use a more specific line number.`
            );

        const rereadOrFix = dirty
            ? 'Re-read the file to get the current content and line numbers.'
            : 'Fix the anchor to match the file line shown above. If your intention is to change one of the anchor lines you must decrease start_line and increase end_line so that the line you want to change is no longer an anchor line.';
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

    static #globToRegex(glob) {
        return new RegExp(
            '^' + glob
                .replace(/\./g, '\\.')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.') + '$'
        );
    }

    // --- executeTool ---

    async executeTool(name, args) {
        const dump = (v) => { console.log(v); return v; };
        try {
            switch (name) {
                case 'list_files': return await this.list_files(args);
                case 'read_file': return await this.read_file(args);
                case 'create_file': return await this.create_file(args);
                case 'edit_file': return await this.edit_file(args);
                case 'undo': return await this.undo();
                case 'search_files': return await this.search_files(args);
                case 'syntax_check': return await this.syntax_check(args);
                case 'calc': return this.calc(args);
                case 'todo': return this.todo(args);
                default: return `Unknown tool: ${name}`;
            }
        } catch (err) {
            if (err instanceof ToolError) {
                const call = JSON.stringify({ name, args });
                if (call === this.lastErrorCall) {
                    return "Stop making identical tool calls. Read the previous error message carefully, analyse the problem and make a correct tool call.";
                }
                this.lastErrorCall = call;
                return err.message;
            }
            throw err;
        }
    }
}
