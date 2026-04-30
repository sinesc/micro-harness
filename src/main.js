#!/usr/bin/env node
import readline from 'readline';
import { Tool } from './tools.js';

const LM_STUDIO_URL = 'http://10.13.37.110:1234';
const CONTEXT_WINDOW = 131072; // Default context window size

const SYSTEM_PROMPT = `You are a coding assistant operating in a terminal harness. You have access to file tools.
CURRENT SITUATION: The code you are working on is the coding harness you are operating in. The overall goal is to improve the harness,
so if you encounter any difficulty with the provided tools, please report the issue and wait for user feedback.
**Do not try to work around issues with one tool by using another tool.**
The application uses nodejs, the entry point is in src/main.js .
IMPORTANT RULES:
1. Line numbers are 1-indexed.
2. Line numbers remain stable across edits until you explicitly call read_file.
3. When using edit_file, specify operation: "insert" or "replace".
4. For "insert": provide 'line' (1-indexed position to insert before) and 'content'.
5. For "replace": provide 'start_line', 'end_line' (1-indexed, inclusive range) and 'content'.
6. If you need to know the current state of a file, call read_file.
7. Always provide a short concise sentence explaining the intent of your next action, e.g. "Creating project file structure.", "Reading files required to understand the issue.", ...
7. Always return concise, useful feedback on changes made.`;

// Token usage tracking
let totalPromptTokens = 0;
let totalCompletionTokens = 0;
let totalTokens = 0;

// Instantiate Tool
const tool = new Tool();

async function fetchCompletion(messages) {
    const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'local-model',
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

function displayMessage(message) {
    message = (message || '').trim();
    if (message !== '') {
        console.log(message);
    }
}

async function main() {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('🚀 LLM Coding Harness started. Type "exit" to quit.\n');

    while (true) {
        const userPrompt = await new Promise(resolve => rl.question('> ', resolve));
        if (userPrompt.trim().toLowerCase() === 'exit') break;

        messages.push({ role: 'user', content: userPrompt });

        let iteration = 0;
        const MAX_ITERATIONS = 25; // Safety net against infinite loops

        while (iteration < MAX_ITERATIONS) {
            iteration++;
            try {
                const response = await fetchCompletion(messages);

                // Track token usage
                if (response.usage) {
                    totalPromptTokens += response.usage.prompt_tokens || 0;
                    totalCompletionTokens += response.usage.completion_tokens || 0;
                    totalTokens += response.usage.total_tokens || 0;
                }

                const msg = response.choices[0].message;

                // Fix: Use ?.length to avoid truthy empty arrays
                if (msg.tool_calls?.length) {
                    // Display any text message the model included with the tool call
                    messages.push({ role: 'assistant', content: msg.content }); // TODO: unclear whether this is helpful/expected
                    displayMessage(msg.content);
                    for (const tc of msg.tool_calls) {
                        const args = JSON.parse(tc.function.arguments);
                        // Display tool name and abbreviated arguments (limit each property to 10 chars)
                        const abbreviatedArgs = Object.fromEntries(
                            Object.entries(args).map(([k, v]) => [k, String(v).length > 10 ? String(v).slice(0, 10) + '...' : String(v)])
                        );
                        console.log(`🔧 Tool: ${tc.function.name}, Args: ${JSON.stringify(abbreviatedArgs)}`);
                        const result = await tool.executeTool(tc.function.name, args);
                        messages.push({ role: 'assistant', content: null, tool_calls: [tc] });
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
                    }
                } else {
                    // Final text response
                    const finalContent = msg.content ?? '';
                    messages.push({ role: 'assistant', content: finalContent });
                    displayMessage(finalContent);
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
