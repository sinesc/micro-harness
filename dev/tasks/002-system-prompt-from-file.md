# Tasks

## Update system prompt handling

Please update application logic to load the system prompt from file.
- add new /prompt command. When called without arguments it should should provide an enumerated, alphanumerically sorted list of available system prompts (config/system/*.md)
- when called with an index from the enumeration or the name of the system prompt (excluding path and extension) it should set the respective system prompt.
- on application start the latest sytem prompt (highest index, last from the list) should be loaded
- check other files that might directly access Application.SYSTEM_PROMPT and fix.

Implementation guidelines
- use SYSTEM_PROMPT_DIR to store path
- implement prompt listing/setting within the slash command, only keep one prompt in memory at a time.
- store `systemPrompt` { name: *file basename*, content: *prompt content* } on application instance
- put logic to load latest prompt into separate function, may duplicate some logic from slash command, we'll later add a persistent configuration to obsolete this function.