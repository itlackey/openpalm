# data/workspace/

Shared workspace between the host and the assistant/admin containers.

This directory is mounted as `/work` inside the assistant container and the
admin addon. It is the primary shared working directory for collaborative work.

## Usage

Place files you want the assistant to work with here:

```bash
# From the host
cp -r my-project ~/.openpalm/data/workspace/

# The assistant sees it at /work/my-project/
```

## Notes

- Files created by the assistant or admin follow the configured runtime UID/GID.
- This directory is durable and survives restarts.
- It is not a secrets store; keep credentials in `vault/`.
