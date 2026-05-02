#!/usr/bin/env node
import readline from 'readline';
import fs from 'fs/promises';
import { Tool } from './tools.js';
import { Command } from './commands.js';

const LM_STUDIO_URL = 'http://10.13.37.110:1234';
const CONTEXT_WINDOW = 131072; // Default context window size
let currentModel = 'local-model';
const CONTEXT_FILE = 'context.json';
const SYSTEM_PROMPT = `You are a coding assistant operating in a terminal harness. You have access to file tools.
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

// Token usage tracking
let totalPromptTokens = 0;
let totalCompletionTokens = 0;
let totalTokens = 0;

// Message display state
let lastMessageType = null;

// Instantiate Tool
const tool = new Tool();
const livepruneRef = { value: false };

/*
 * Prune stale/useless context entries before sending to API.
 * Returns a filtered copy of messages (excluding system prompt).
 * Optimized to O(N) time complexity.
 */
function pruneContextForAPI(messages) {
    if (!livepruneRef.value) {
        return messages.filter(m => m.role !== 'system');
    }

    const lastReadFileIndexByPath = new Map();
    const filesReReadAfterPreview = new Set();
    let lastAssistantWithTools = null;

    // First pass: gather metadata (O(N))
    for (let i = 0; i < messages.length; i++) {
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
    const staleResults = new Map();
    let staleCounter = 0;
    lastAssistantWithTools = null;

    for (let i = 0; i < messages.length; i++) {
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
                        const placeholder = `Stale result excluded from context, should you need this result use tool read_stale with content_id=${staleCounter}`;
                        staleResults.set(staleCounter, msg.content);
                        tool.staleResults.set(staleCounter, msg.content);
                        staleCounter++;
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

// Instantiate Command
const command = new Command({ tool, saveContext, pruneContext: pruneContextForAPI, livepruneRef });

async function loadContext() {
    try {
        const data = await fs.readFile(CONTEXT_FILE, 'utf-8');
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

async function saveContext(messages) {
    try {
        // Save only user/assistant/tool messages (skip system prompt)
        const toSave = messages.filter(m => m.role !== 'system');
        await fs.writeFile(CONTEXT_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
        console.log(`💾 Saved context (${toSave.length} messages)`);
    } catch (err) {
        console.log(`⚠️  Warning: Could not save context: ${err.message}`);
    }
}

async function fetchCompletion(messages) {
    const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: currentModel,
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

function displayTokenUsage() {
    const remaining = Math.max(0, CONTEXT_WINDOW - totalPromptTokens);
    console.log(`\n📊 Token Usage: ${totalTokens} total (${totalPromptTokens} prompt + ${totalCompletionTokens} completion) | Context: ${totalPromptTokens}/${CONTEXT_WINDOW} (${remaining} remaining)\n`);
}

function displayMessage(role, content, color = null) {
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

    if (lastMessageType !== null && lastMessageType !== role) {
        console.log('');
    }
    console.log(`${typeLabel} ${colorCode}${content}${resetCode}`);
    lastMessageType = role;
}

async function main() {
    // Load previous context if it exists
    const previousMessages = await loadContext();
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...previousMessages];
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('🚀 LLM Coding Harness started. Type "/exit" to quit.\n');

    while (true) {
        const userPrompt = await new Promise(resolve => rl.question('> ', resolve));
        console.log("");

        if (userPrompt.slice(0, 1) === '/') {
            const matches = userPrompt.match(/^\/(?<cmd>[a-zA-Z_]+)(?:\s+(?<args>.*))?$/);
            const cmd = matches?.groups?.cmd ?? null;
            const args = matches?.groups?.args ?? null;
            if (!cmd) {
                console.log(`\nInvalid command syntax\n`);
            } else {
                try {
                    const result = await command.execute(cmd, args, messages, LM_STUDIO_URL, currentModel);
                    if (result === 'exit') {
                        break;
                    }
                    console.log(`\n${result}\n`);
                } catch (err) {
                    console.log(`\n❌ ${err.message}\n`);
                }
            }
            continue;
        }

        messages.push({ role: 'user', content: userPrompt });

        while (true) {
            try {
                // Prune context before sending to API if liveprune is enabled
                const messagesToSend = pruneContextForAPI(messages);
                const response = await fetchCompletion(messagesToSend);

                // Track token usage
                if (response.usage) {
                    totalPromptTokens = response.usage.prompt_tokens || 0;
                    totalCompletionTokens = response.usage.completion_tokens || 0;
                    totalTokens = response.usage.total_tokens || 0;
                }

                const msg = response.choices[0].message;

                // Catch some mistakes.
                if (!msg.content.trim() && !msg.tool_calls?.length) {
                    if (msg.reasoning_content?.includes('<tool_call>')) {
                        messages.push({ role: 'system', content: 'Please do not include tool call syntax (like <tool_call>) in your reasoning_content. If you need to use a tool, use the proper tool call format.' });
                    } else {
                        messages.push({ role: 'system', content: 'You did not call a tool or respond to the user. Please either call a tool or respond to the user.' });
                    }
                }

                // Handle tool calls
                if (msg.tool_calls?.length) {
                    // Display any text message the model included with the tool call
                    const assistantMsg = { role: 'assistant', content: msg.content };
                    if (msg.reasoning_content) assistantMsg.reasoning_content = msg.reasoning_content;
                    messages.push(assistantMsg);

                    // Display assistant content first if present
                    displayMessage('assistant', msg.content);

                    for (const tc of msg.tool_calls) {
                        const args = JSON.parse(tc.function.arguments);
                        // Display tool name and abbreviated arguments (limit each property to 10 chars)
                        const abbreviatedArgs = Object.fromEntries(
                            Object.entries(args).map(([k, v]) => [k, String(v).trim().length > 16 ? String(v).trim().slice(0, 16) + '...' : String(v).trim()])
                        );
                        const structuredResult = await tool.executeTool(tc.function.name, args);
                        const isFailed = structuredResult.error !== undefined && structuredResult.error !== null;
                        displayMessage('tool', `${tc.function.name}${JSON.stringify(abbreviatedArgs)}`, isFailed ? 'red' : 'grey');
                        messages.push({ role: 'assistant', content: null, tool_calls: [tc] });
                        // Store structured result error as metadata for live-pruning
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: structuredResult.result, _toolError: structuredResult.error });
                    }
                } else {
                    // Final text response
                    const finalContent = msg.content ?? '';
                    const finalMsg = { role: 'assistant', content: finalContent };
                    if (msg.reasoning_content) finalMsg.reasoning_content = msg.reasoning_content;
                    messages.push(finalMsg);
                    displayMessage('assistant', finalContent);
                    displayTokenUsage();
                    break; // Exit tool loop
                }
            } catch (err) {
                console.error(`\n❌ API Error: ${err.message}\n`);
                break;
            }
        }
    }
    rl.close();
}

main().catch(console.error);