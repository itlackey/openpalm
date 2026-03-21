# workspace/

Shared workspace between the host and the assistant container.

This directory is mounted as `/work` inside the assistant container and set
as its working directory. Both the user and the assistant can read and write
files here, making it the primary location for collaborative work.

## Usage

Place files you want the assistant to work with in this directory:

```bash
# From the host
cp my-project/ ~/.openpalm/workspace/

# The assistant sees it at /work/my-project/
```

The assistant's OpenCode instance starts in `/work`, so any file operations
default to this directory unless an absolute path is specified.

## Notes

- Files created by the assistant will be owned by `OP_UID:OP_GID`
  (default `1000:1000`), matching the container's runtime user.
- This directory is excluded from version control. Only this README is tracked.
- Large files and build artifacts in this directory will consume disk space
  on the host — clean up as needed.
