# Tasks

## Live context pruning

Implement live context pruning in MessageContext.prepare(). The goal is to keep only relevant information in the context. The original context remains unchanged but is filtered as it passes through the `prepare()` function. Pruning rules:

Entire context including last turn:
- Full read_file results: keep only the last one per file

Context up to the last user message (so excluding the current turn):
- Partial read_file results: keep only if the file hasn't been fully read since
- edit_file previews: keep only if the file hasn't been fully read since
    - for accepted previews: replace edit_file result with success message and completely skip the associated apply_preview tool call and response
    - for not-accepted preview: replace edit_file result with failed message ("Anchor mismatch")
- Failed tool calls/results: discard all

Implementation advice:
- use tool call id to identify call and associated result (build a maps for easy lookup (e.g. tool call id => [ call message index, result message index ])
- use preview id to identify edit result and associated preview (build a map...)
- iterate backwards through the context
    - build result array as you go
    - take note of full reads per file (e.g. array of filenames `fullFilesEncountered`) and the first user message you encounter (set a bool variable `userMessageEncountered`)
    - handle full files based on `fullFilesEncountered`
    - handle partial files based on `fullFilesEncountered` and `userMessageEncountered` = true
    - handle previews based on `fullFilesEncountered` and `userMessageEncountered` = true
- return the reversed result array (since you built the result backwards)
