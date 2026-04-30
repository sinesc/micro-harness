import fs from 'fs/promises';

// File edit history for undo
const editHistory = [];

// Track cumulative offset for each line number
const lineOffsetMap = new Map();

export class Tool {
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
                description: 'Read file contents. Call this to refresh line numbers and current state.',
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
                description: 'Edit a file by inserting or replacing lines. Line numbers are 1-indexed and remain stable until read_file is called.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                        operation: { type: 'string', enum: ['insert', 'replace'], description: 'Operation type' },
                        line: { type: 'integer', description: 'Line number for insert (1-indexed)' },
                        start_line: { type: 'integer', description: 'Start line for replace (1-indexed)' },
                        end_line: { type: 'integer', description: 'End line for replace (1-indexed, inclusive)' },
                        content: { type: 'string', description: 'New text content' }
                    },
                    required: ['path', 'operation', 'content']
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
        }
    ];

    // --- Tool implementations ---

    static async list_files({ dir }) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map(e => `${e.isDirectory() ? '📁 ' : '📄 '}${e.name}`).join('\n');
    }

    static async read_file({ path: filePath }) {
        const content = await fs.readFile(filePath, 'utf-8');
        lineOffsetMap.clear();  // Reset offsets since we re-read the file
        return content;
    }

    static async create_file({ path: filePath, content }) {
        await fs.writeFile(filePath, content, 'utf-8');
        return `Created file ${filePath} with ${content.split(/\r?\n/).length} line(s).`;
    }

    static async edit_file({ path: filePath, operation, line, start_line, end_line, content }) {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        let lines = fileContent.split(/\r?\n/);
        let feedback = '';

        // Before each edit:
        editHistory.push({
            content: fileContent,
            offsetMap: new Map(lineOffsetMap)
        });

        if (operation === 'insert') {
            // Calculate actual line position using offset
            const offset = this.#getOffset(line);
            const actualLine = line + offset;
            if (actualLine > lines.length + 1) {
                throw new Error(`Line ${line} is out of bounds (file has ${lines.length} lines)`);
            }
            const insertIdx = Math.max(0, Math.min(actualLine - 1, lines.length));
            const newLines = content.split(/\r?\n/);
            lines.splice(insertIdx, 0, ...newLines);

            // Update offset map
            this.#updateOffsetsAfterInsert(line, newLines.length);

            feedback = `Inserted ${newLines.length} line(s) at line ${line} (now at line ${actualLine}).`;
        } else if (operation === 'replace') {
            // Calculate actual line positions using offsets
            const startOffset = this.#getOffset(start_line);
            const endOffset = this.#getOffset(end_line);
            const actualStart = start_line + startOffset;
            const actualEnd = end_line + endOffset;

            const startIdx = Math.max(0, Math.min(actualStart - 1, lines.length));
            const endIdx = Math.max(startIdx, Math.min(actualEnd, lines.length));
            const count = endIdx - startIdx;
            const newLines = content.split(/\r?\n/);
            lines.splice(startIdx, count, ...newLines);

            // Update offset map
            this.#updateOffsetsAfterReplace(start_line, end_line, newLines.length);

            feedback = `Replaced ${count} line(s) (${start_line}-${end_line}) with ${newLines.length} line(s).`;
        } else {
            throw new Error(`Unknown operation: ${operation}`);
        }

        const newContent = lines.join('\n');
        await fs.writeFile(filePath, newContent, 'utf-8');
        return feedback;
    }

    static async search_files({ pattern, dir = '.', file_pattern = null, max_results = 50 }) {
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
                    const globRegex = this.#globToRegex(file_pattern);
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

    // --- Private helper functions ---

    #getOffset(lineNum) {
        let offset = 0;
        for (const [line, off] of lineOffsetMap) {
            if (line <= lineNum) {
                offset = off;
            }
        }
        return offset;
    }

    #updateOffsetsAfterInsert(line, numLines) {
        // All lines >= line get offset +numLines
        for (const [originalLine] of lineOffsetMap) {
            if (originalLine >= line) {
                lineOffsetMap.set(originalLine, lineOffsetMap.get(originalLine) + numLines);
            }
        }
        // Also mark new lines as having 0 offset from this point
        for (let i = 0; i < numLines; i++) {
            lineOffsetMap.set(line + i, 0);
        }
    }

    #updateOffsetsAfterReplace(startLine, endLine, newLineCount) {
        const replacedCount = endLine - startLine + 1;
        const netChange = newLineCount - replacedCount;

        // All lines > endLine get offset +netChange
        for (const [originalLine] of lineOffsetMap) {
            if (originalLine > endLine) {
                lineOffsetMap.set(originalLine, lineOffsetMap.get(originalLine) + netChange);
            }
        }
    }

    #globToRegex(glob) {
        return new RegExp(
            '^' + glob
                .replace(/\./g, '\\.')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.') + '$'
        );
    }

    // --- executeTool ---

    static async executeTool(name, args) {
        try {
            switch (name) {
                case 'list_files': return await this.list_files(args);
                case 'read_file': return await this.read_file(args);
                case 'create_file': return await this.create_file(args);
                case 'edit_file': return await this.edit_file(args);
                case 'search_files': return await this.search_files(args);
                default: return `Unknown tool: ${name}`;
            }
        } catch (err) {
            return `Error: ${err.message}`;
        }
    }
}
