# Managed stack

`stack.compose.yml` is the complete managed topology:

- Assistant is the only default service.
- `gateway` enables Guardian.
- `discord` enables Guardian and the Discord adapter.
- `slack` enables Guardian and the Slack adapter.

StackConfig also owns the native Assistant bind and the `chat`, `read`, or
`full` Guardian policy assigned to each named credential. Loopback binds and
portal `chat` policies are the safe defaults; the owner defaults to `full`.

The operator overlay is
`OP_HOME/config/stack/custom.compose.yml`. The CLI resolves both files,
activates profiles from the stack configuration, audits the final project, and invokes
Docker Compose.

No other managed Compose files are supported.
