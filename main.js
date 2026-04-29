#!/usr/bin/env node
import fs from 'fs/promises';
import readline from 'readline';

const LM_STUDIO_URL = 'http://10.13.37.110:1234';

const TOOLS = [
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
          content: { type: 'string', description: 'New code content' }
        },
        required: ['path', 'operation', 'content']
      }
    }
  }
];

const SYSTEM_PROMPT = `You are a coding assistant operating in a terminal harness. You have access to file tools.
IMPORTANT RULES:
1. Line numbers are 1-indexed.
2. Line numbers remain stable across edits until you explicitly call read_file on the file.
3. When using edit_file, specify operation: "insert" or "replace".
4. For "insert": provide 'line' (1-indexed position to insert before) and 'content'.
5. For "replace": provide 'start_line', 'end_line' (1-indexed, inclusive range) and 'content'.
6. Always return concise, useful feedback on changes made.
7. If you need to know the current state of a file, call read_file.`;

// Cache to maintain stable line numbers across edits
const fileCache = new Map();

async function getOrCreateFileState(filePath) {
  if (!fileCache.has(filePath)) {
    const content = await fs.readFile(filePath, 'utf-8');
    fileCache.set(filePath, { content, lineCount: content.split(/\r?\n/).length });
  }
  return fileCache.get(filePath);
}

async function list_files({ dir }) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.map(e => `${e.isDirectory() ? '📁 ' : '📄 '}${e.name}`).join('\n');
}

async function read_file({ path: filePath }) {
  const content = await fs.readFile(filePath, 'utf-8');
  fileCache.set(filePath, { content, lineCount: content.split(/\r?\n/).length });
  return content;
}

async function create_file({ path: filePath, content }) {
  await fs.writeFile(filePath, content, 'utf-8');
  fileCache.set(filePath, { content, lineCount: content.split(/\r?\n/).length });
  return `Created file ${filePath} with ${content.split(/\r?\n/).length} line(s).`;
}

async function edit_file({ path: filePath, operation, line, start_line, end_line, content }) {
  const state = await getOrCreateFileState(filePath);
  let lines = state.content.split(/\r?\n/);
  let feedback = '';

  if (operation === 'insert') {
    const insertIdx = Math.max(0, Math.min(line - 1, lines.length));
    const newLines = content.split(/\r?\n/);
    lines.splice(insertIdx, 0, ...newLines);
    feedback = `Inserted ${newLines.length} line(s) at line ${line}.`;
  } else if (operation === 'replace') {
    const startIdx = Math.max(0, Math.min(start_line - 1, lines.length));
    const endIdx = Math.max(startIdx, Math.min(end_line, lines.length));
    const count = endIdx - startIdx;
    const newLines = content.split(/\r?\n/);
    lines.splice(startIdx, count, ...newLines);
    feedback = `Replaced ${count} line(s) (${start_line}-${end_line}) with ${newLines.length} line(s).`;
  } else {
    throw new Error(`Unknown operation: ${operation}`);
  }

  const newContent = lines.join('\n');
  await fs.writeFile(filePath, newContent, 'utf-8');
  fileCache.set(filePath, { content: newContent, lineCount: lines.length });
  return feedback;
}

async function executeTool(name, args) {
  try {
    switch (name) {
      case 'list_files': return await list_files(args);
      case 'read_file': return await read_file(args);
      case 'create_file': return await create_file(args);
      case 'edit_file': return await edit_file(args);
      default: return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

async function fetchCompletion(messages) {
  const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local-model',
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.1,
      stream: false
    })
  });
  if (!res.ok) throw new Error(`LM Studio API error: ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('🚀 LLM Coding Harness started. Type "exit" to quit.\n');

  while (true) {
    const userPrompt = await new Promise(resolve => rl.question('> ', resolve));
    if (userPrompt.trim().toLowerCase() === 'exit') break;

    messages.push({ role: 'user', content: userPrompt });

    let hasToolCalls = true;
    while (hasToolCalls) {
      try {
        const response = await fetchCompletion(messages);
        const msg = response.choices[0].message;

        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const args = JSON.parse(tc.function.arguments);
            const result = await executeTool(tc.function.name, args);
            messages.push({ role: 'assistant', content: null, tool_calls: [tc] });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }
        } else {
          messages.push(msg);
          console.log(msg.content);
          hasToolCalls = false;
        }
      } catch (err) {
        console.error(`\n❌ API Error: ${err.message}\n`);
        hasToolCalls = false;
      }
    }
  }

  rl.close();
}

main().catch(console.error);
