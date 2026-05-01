import fs from 'fs/promises';
import crypto from 'crypto';
import { exec } from 'child_process';
import util from 'util';

const execAsync = util.promisify(exec);

export class Tool {
    constructor() {
        // Track cumulative offsets per file: Map<filePath, Map<lineNum, offset>>
        this.fileOffsetMaps = new Map();
        // File edit history for undo
        this.editHistory = [];
        // Track file checksums to detect external changes
        this.fileChecksums = new Map();
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
                description: 'Replace a range of lines in a file with new text. start_line and end_line are 1-indexed line numbers (integer). Use inclusive=false to preserve the start/end lines and only replace the text between them.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                        start_line: {
                            description: 'Start of the replacement range: a 1-indexed line number',
                            oneOf: [{ type: 'integer' }, { type: 'string' }]
                        },
                        end_line: {
                            description: 'End of the replacement range: a 1-indexed line number',
                            oneOf: [{ type: 'integer' }, { type: 'string' }]
                        },
                        replacement: { type: 'string', description: 'Text to replace the specified lines with' },
                        inclusive: { type: 'boolean', description: 'When true (default), start_line and end_line are replaced along with the lines between them. When false, start_line and end_line are kept and only the lines between them are replaced.' }
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
            return `Error: Cannot list directory '${dir}': ${err.message}`;
        }
    }

    async read_file({ path: filePath }) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            // Reset offsets for this file since we re-read it
            if (this.fileOffsetMaps.has(filePath)) {
                this.fileOffsetMaps.delete(filePath);
            }
            this.fileChecksums.set(filePath, this.#computeChecksum(content));  // Update checksum on read
            let line = 1;
            return content.split(/\r?\n/).map((text, index) => `${index+1}\t${text}`).join("\n");
        } catch (err) {
            return `Error: Cannot read file '${filePath}': ${err.message}`;
        }
    }

    async create_file({ path: filePath, content }) {
        try {
            await fs.writeFile(filePath, content, 'utf-8');
            this.fileChecksums.set(filePath, this.#computeChecksum(content));  // Set initial checksum
            return `Created file ${filePath} with ${content.split(/\r?\n/).length} line(s).`;
        } catch (err) {
            return `Error: Cannot create file '${filePath}': ${err.message}`;
        }
    }

    async undo() {
        if (this.editHistory.length === 0) {
            return 'No edits to undo.';
        }

        const lastEdit = this.editHistory.pop();
        const filePath = lastEdit.path;
        const content = lastEdit.content;
        const offsetMap = lastEdit.offsetMap;

        try {
            // Write the file back to its previous state
            await fs.writeFile(filePath, content, 'utf-8');

            // Restore the offset map for this file
            this.fileOffsetMaps.set(filePath, new Map(offsetMap));

            // Restore the checksum
            this.fileChecksums.set(filePath, this.#computeChecksum(content));

            return `Undid the last edit on ${filePath}.`;
        } catch (err) {
            return `Error: Cannot undo edit on '${filePath}': ${err.message}`;
        }
    }

    async search_files({ pattern, dir = '.', file_pattern = null, max_results = 50 }) {
        try {
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
        } catch (err) {
            return `Error: Cannot search directory '${dir}': ${err.message}`;
        }
    }

    async edit_file({ path: filePath, start_line, end_line, replacement, inclusive = true }) {
        try {
            const fileContent = await fs.readFile(filePath, 'utf-8');

            const previousChecksum = this.fileChecksums.get(filePath);
            const currentChecksum = this.#computeChecksum(fileContent);
            if (previousChecksum && previousChecksum !== currentChecksum) {
                return `ERROR: File '${filePath}' has been modified externally since it was last read. Please call read_file first to refresh the file contents, then retry the edit.`;
            }

            const offsetMap = this.#getFileOffsetMap(filePath);
            const lines = fileContent.split(/\r?\n/);

            // debug info
            const dbgSummary = lines.length-2 > 0 ? lines.toSpliced(1, lines.length-2, '...') : lines.toSpliced(1, lines.length-2);
            const dbgActualStart = start_line + this.#getOffset(offsetMap, start_line);
            const dbgActualEndt = end_line + this.#getOffset(offsetMap, end_line);
            console.log(`EDIT: ${start_line}-${end_line}, mapped to ${dbgActualStart}-${dbgActualEndt}, ${inclusive?'inclusive':'exclusive'}. `, dbgSummary);
            // --

            const actualStart = start_line + this.#getOffset(offsetMap, start_line);
            if (actualStart < 1 || actualStart > lines.length)
                return `Error: start_line ${start_line} is out of bounds, please re-read the file.`;
            let startIdx = actualStart - 1;
            let logicalStart = start_line;

            const actualEnd = end_line + this.#getOffset(offsetMap, end_line);
            if (actualEnd < 1 || actualEnd > lines.length)
                return `Error: end_line ${end_line} is out of bounds, please re-read the file.`;
            let endIdx = actualEnd - 1;
            let logicalEnd = end_line;

            if (endIdx < startIdx)
                return `Error: end_line (line ${endIdx + 1}) is before start_line (line ${startIdx + 1})`;//FIXME: need to report original line numbers (-offset) that the model can actually use with this tool!
            if (!inclusive && endIdx === startIdx)
                return `Error: start_line and end_line cannot be the same line when inclusive is false`;

            this.editHistory.push({ path: filePath, content: fileContent, offsetMap: new Map(offsetMap) });

            const spliceStart = inclusive ? startIdx : startIdx + 1;
            const numDeleted = inclusive ? endIdx - startIdx + 1 : endIdx - startIdx - 1;
            const logicalSpliceStart = inclusive ? logicalStart : logicalStart + 1;
            const logicalSpliceEnd = inclusive ? logicalEnd : logicalEnd - 1;
            // Empty string means delete (no replacement lines).
            // Strip one trailing newline before splitting so that a conventional
            // line-terminated replacement ("foo\n") is treated as one line, not two.
            const newLines = replacement === '' ? [] : replacement.replace(/\r?\n$/, '').split(/\r?\n/);
            this.#editSplice(offsetMap, lines, spliceStart, numDeleted, newLines, logicalSpliceStart, logicalSpliceEnd);

            const newContent = lines.join('\n');
            await fs.writeFile(filePath, newContent, 'utf-8');
            this.fileChecksums.set(filePath, this.#computeChecksum(newContent));

            return 'Replacement complete.';
            /*const replacedStart = spliceStart + 1;
            const replacedEnd = spliceStart + numDeleted;
            const rangeStr = numDeleted > 0 ? `lines ${replacedStart}-${replacedEnd}` : `between lines ${startIdx + 1} and ${endIdx + 1}`;
            return `Replaced ${rangeStr} (${numDeleted} line(s)) with ${newLines.length} line(s).`;*/
        } catch (err) {
            return `Error: Cannot replace text in '${filePath}': ${err.message}`;
        }
    }

    async syntax_check({ path: filePath }) {
        try {
            const { stdout, stderr } = await execAsync(`node -c "${filePath}"`);
            if (stderr) {
                return stderr.trim();
            }
            return `Syntax check passed for ${filePath}.`;
        } catch (err) {
            return `Syntax error in ${filePath}: ${err.stderr?.trim() || err.message}`;
        }
    }

    calc({ expression }) {
        const filtered = expression.replace(/[^0-9+\.\-*/%]/g, '');
        try {
            const result = new Function('return ' + filtered)();
            return `Result: ${result}`;
        } catch (err) {
            return `Error: Could not evaluate expression "${filtered}": ${err.message}`;
        }
    }

    todo({ text }) {
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
    }
}
