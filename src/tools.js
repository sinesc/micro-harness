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
                description: 'Edit a file by inserting or replacing lines. Line numbers are 1-indexed and remain stable until read_file is called.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' },
                        operation: { type: 'string', enum: ['insert', 'replace'], description: 'Operation type' },
                        line: { type: 'integer', description: 'Line number for insert (1-indexed)' },
                        start_line: { type: 'integer', description: 'Start line for replace (1-indexed)' },
                        end_line: { type: 'integer', description: 'End line for replace (1-indexed, inclusive)' },
                        content: { type: 'string', description: 'File content' }
                    },
                    required: ['path', 'operation', 'content']
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
        }
    ];

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

    // --- Tool implementations ---

    async list_files({ dir }) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map(e => `${e.isDirectory() ? '📁 ' : '📄 '}${e.name}`).join('\n');
    }

    async read_file({ path: filePath }) {
        const content = await fs.readFile(filePath, 'utf-8');
        // Reset offsets for this file since we re-read it
        if (this.fileOffsetMaps.has(filePath)) {
            this.fileOffsetMaps.delete(filePath);
        }
        this.fileChecksums.set(filePath, this.#computeChecksum(content));  // Update checksum on read
        let line = 1;
        return content.split(/\r?\n/).map((text, index) => `${index+1}\t${text}`).join("\n");
    }

    async create_file({ path: filePath, content }) {
        await fs.writeFile(filePath, content, 'utf-8');
        this.fileChecksums.set(filePath, this.#computeChecksum(content));  // Set initial checksum
        return `Created file ${filePath} with ${content.split(/\r?\n/).length} line(s).`;
    }

    async edit_file({ path: filePath, operation, line, start_line, end_line, content }) {
        const fileContent = await fs.readFile(filePath, 'utf-8');

        // Check for external changes before editing
        const previousChecksum = this.fileChecksums.get(filePath);
        const currentChecksum = this.#computeChecksum(fileContent);

        if (previousChecksum && previousChecksum !== currentChecksum) {
            return `ERROR: File '${filePath}' has been modified externally since it was last read. Please call read_file first to refresh the file contents, then retry the edit.`;
        }

        const offsetMap = this.#getFileOffsetMap(filePath);
        let lines = fileContent.split(/\r?\n/);
        let feedback = '';

        // Before each edit: save state for undo
        this.editHistory.push({
            path: filePath,
            content: fileContent,
            offsetMap: new Map(offsetMap)
        });

        if (operation === 'insert') {
            // Calculate actual line position using offset
            const offset = this.#getOffset(offsetMap, line);
            const actualLine = line + offset;
            if (actualLine > lines.length + 1) {
                throw new Error(`Line ${line} is out of bounds (file has ${lines.length} lines)`);
            }
            const insertIdx = Math.max(0, Math.min(actualLine - 1, lines.length));
            const newLines = content.split(/\r?\n/);
            lines.splice(insertIdx, 0, ...newLines);

            // Update offset map
            this.#updateOffsetsAfterInsert(offsetMap, line, newLines.length);

            feedback = `Inserted ${newLines.length} line(s) at line ${line} (now at line ${actualLine}).`;
        } else if (operation === 'replace') {
            // Calculate actual line positions using offsets
            const startOffset = this.#getOffset(offsetMap, start_line);
            const endOffset = this.#getOffset(offsetMap, end_line);
            const actualStart = start_line + startOffset;
            const actualEnd = end_line + endOffset;

            const startIdx = Math.max(0, Math.min(actualStart - 1, lines.length));
            const endIdx = Math.max(startIdx, Math.min(actualEnd, lines.length));
            const count = endIdx - startIdx;
            const newLines = content.split(/\r?\n/);
            lines.splice(startIdx, count, ...newLines);

            // Update offset map
            this.#updateOffsetsAfterReplace(offsetMap, start_line, end_line, newLines.length);

            feedback = `Replaced ${count} line(s) (${start_line}-${end_line}) with ${newLines.length} line(s).`;
        } else {
            throw new Error(`Unknown operation: ${operation}`);
        }

        const newContent = lines.join('\n');
        await fs.writeFile(filePath, newContent, 'utf-8');

        // Update checksum after successful edit
        this.fileChecksums.set(filePath, this.#computeChecksum(newContent));

        return feedback;
    }

    async undo() {
        if (this.editHistory.length === 0) {
            return 'No edits to undo.';
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

    #getOffset(offsetMap, lineNum) {
        let offset = 0;
        for (const [line, off] of offsetMap) {
            if (line <= lineNum) {
                offset = off;
            }
        }
        return offset;
    }

    #updateOffsetsAfterInsert(offsetMap, line, numLines) {
        // All lines >= line get offset +numLines
        for (const [originalLine] of offsetMap) {
            if (originalLine >= line) {
                offsetMap.set(originalLine, offsetMap.get(originalLine) + numLines);
            }
        }
        // Also mark new lines as having 0 offset from this point
        for (let i = 0; i < numLines; i++) {
            offsetMap.set(line + i, 0);
        }
    }

    #updateOffsetsAfterReplace(offsetMap, startLine, endLine, newLineCount) {
        const replacedCount = endLine - startLine + 1;
        const netChange = newLineCount - replacedCount;

        // All lines > endLine get offset +netChange
        for (const [originalLine] of offsetMap) {
            if (originalLine > endLine) {
                offsetMap.set(originalLine, offsetMap.get(originalLine) + netChange);
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

    // --- executeTool ---

    async executeTool(name, args) {
        try {
            switch (name) {
                case 'list_files': return await this.list_files(args);
                case 'read_file': return await this.read_file(args);
                case 'create_file': return await this.create_file(args);
                case 'edit_file': return await this.edit_file(args);
                case 'undo': return await this.undo();
                case 'search_files': return await this.search_files(args);
                case 'syntax_check': return await this.syntax_check(args);
                default: return `Unknown tool: ${name}`;
            }
        } catch (err) {
            return `Error: ${err.message}`;
        }
    }
}
