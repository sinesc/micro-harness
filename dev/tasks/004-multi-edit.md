# Task: Improve edit_file tool

## Overview

Update edit_file tool to support editing multiple chunks of a file with a single tool call and change preview system from *confirm before apply* approach to *apply immediately, undo if necessary*.

## Requirements

- instead of the current `start_line`, `end_line` and `replacement` parameters edit_file should accept a new `edits` array of objects { start_line, end_line, replacement }.
- all edits should refer to the original line numbers of the file (retaining current logic).
- the tool should check for and reject overlapping edits.
- `edit_file` code paths that currently display a preview should directly apply the changes.
- all successfull edits should be shown to the model (similar output as the current preview mechanic) with wording to indicate that these changes have been applied and if necessary can be undone using the `undo` tool.
- update tool descriptions and system prompt in file `config/system/004-misc.md` as required (ignore the other system prompts)
- remove `apply_preview` and its documentation

## Implementation hints

- Please factor the editing and validation logic for a single edit into a private support method and call it for each edit.