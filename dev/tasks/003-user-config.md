# Add user configuration file

## Implement persistent user configuration support.

- configuration loaded on application start, saved on exit
- file format json
- file location *user home*/.config/micro-harness/config.json (linux support is sufficient)
- handle missing file/path gracefully
- persisted settings: for now only the currently selected system prompt

## Move message context to config folder.

- context should be saved as context.*project-path*.json within the config folder. *project-path* is the current working directory with path separators replaced by dashes.

### Example:

Working directory: `/workspaces/silicon-tracer/`
User name: dennis
Context file: `/home/dennis/.config/micro-harness/context.workspaces-silicon-tracer.json
