# Write-project documentation

## Setup

- Create a `documentation` folder if it doesn't exist. If user specifies different destination folder use that one instead.
- Scope optionally limited to contents of the user specified folder (ask if not provided).

## Approach

- Walk through the directory tree one file/directory at a time.
- For each directory with sourcecode files create a new directory within the documentation.
- For each sourcecode file create a new markdown file (e.g. for `main.js` name would be `main.js.md`) in the appropriate documentation directory. If documentation already exists and not explicitly asked to update documentation: skip the file.
- Forget file contents to avoid overloading your context.
- Once done with a directory, create an `index.md` overview-file.
- IMPORTANT: There are too many directories and files to gather them all first. Instead process the files of one directory at a time, then visit the subdirectories and use the same strategy there.

## Documentation details

- Folders (`index.md`):
    - `# Summary` headline, brief content summary (no more than three sentences).
    - `# Files` headline, list of files with links to the markdown documents.
- Files (`filename.extension.md`):
    - `# Summary` headline, brief content summary (no more than three sentences).
    - `# Classes` headline, list of contained classes, for each class a...
        - `## Methods` headline followed by a listing of class methods (with signature, e.g. `displayMessageChunk(role, chunk, isFirst, isLast, color = null)`)
        - `## Properties` headline followed by other properties of the class, e.g. `static SYSTEM_PROMPT_DIR`

