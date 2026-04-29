# Coding Harness Improvement Recommendations

## Current Strengths
- Clean architecture with tool caching for stable line numbers
- Good safety net with `MAX_ITERATIONS`
- Proper tool calling loop

## Areas for Improvement

### 1. Context Window Management (High Priority)
Messages grow unbounded, which can exhaust the context window.
- Implement automatic summarization of older messages
- Or trim/summarize when approaching context limits
- Keep conversation history relevant

### 2. Configurable Settings (High Priority)
Hardcoded LM Studio URL and settings.
- Make URL configurable via CLI args or env vars
- Allow model, temperature, and other params to be customized
- Consider a config file (e.g., `.harnessrc`)

### 3. File Search Tool (Medium Priority)
No grep-like functionality for finding code patterns.
- Add a `search_files` tool that searches file contents
- Support regex patterns
- Return file paths and matching line numbers

### 4. Streaming Support (Medium Priority)
Currently `stream: false` means longer waits for responses.
- Implement streaming for faster feedback
- Show partial responses as they arrive
- Better UX for long-running completions

### 5. Tool Result Truncation (Medium Priority)
Large file reads could overwhelm context.
- Truncate tool results with summary (e.g., "File has 5000 lines, showing first 100...")
- Include total count in truncated output
- Allow user to request more if needed

### 6. Shell Command Execution (Low Priority)
Useful for running scripts, tests, or build commands.
- Add a `run_command` tool
- Include timeout and output capture
- Security considerations for sandboxing

### 7. Working Directory Tracking (Low Priority)
No awareness of current directory.
- Display current directory in prompt
- Support `cd` commands
- Show relative paths in tool outputs

## Implementation Priority
1. Context window management
2. Configurable settings
3. File search tool
4. Streaming support
5. Tool result truncation
