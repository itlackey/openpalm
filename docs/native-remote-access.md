# Optional Codex and Claude Code remote sessions

Available in `0.14.0-alpha.3` and later. Updating source alone does not update
a running installation's CLI or image; install the release CLI and run `update`.

These options start **separate native coding agents** in the Assistant's
workspace. They do not turn Codex or Claude Code into clients of OpenCode, expose
its conversation history, or apply Guardian credential policies. Use OpenCode
or Guardian MCP if you want the OpenPalm personal agent and its existing sessions.

Both switches default off. No public URL, extra container, SSH daemon, published
port, host-home mount, or runtime package installation is added. The release image
bakes exact CLI versions. Native account state stays in `OP_HOME/data/assistant`
under the vendor's normal files; it is not included in portable knowledge backup
or imported as an OpenCode provider credential. Pairing output is private and
bounded under the container's `/tmp/openpalm-runtime/remote`; restart replaces it.

## Codex (experimental)

```sh
openpalm remote setup codex
openpalm config assistant --codex-remote on
openpalm remote status codex
openpalm remote pair codex
```

Setup uses Codex's device sign-in in an interactive terminal. Startup runs native
`codex remote-control` in the foreground with `on-request` approvals and
`workspace-write` sandboxing. Pair requests a fresh short-lived code from the
running native service. Treat that code as private.

Codex labels this command experimental. A pairing code is **not** a guarantee
that a particular app can connect to a Linux container. OpenAI's published mobile
setup currently starts from a supported Mac/Windows desktop app; desktop/SSH and
CLI remote-control availability differ. Follow your client's native pairing flow
if it supports manual codes. OpenPalm does not add an SSH server or an
unauthenticated app-server transport to work around availability limits.
Container hosts must also support Codex's native sandbox for tool execution;
OpenPalm does not weaken container isolation or disable sandboxing to make it run.
See [OpenAI's command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
and [remote connection requirements](https://learn.chatgpt.com/docs/remote-connections).

The alpha.3 published-image walkthrough found a host/container limitation:
`codex sandbox /usr/bin/true` failed with `No permissions to create a new
namespace` under the default container isolation, even though host user
namespaces were enabled. This prevents verified sandboxed tool execution on
that installation; enabling the switch or obtaining a pairing code does not
resolve it. Do not disable the sandbox or make Assistant privileged as a
workaround. See the [verification record](operations/release.md#alpha3-published-artifact-verification-record)
and [OpenAI's sandbox requirements](https://learn.chatgpt.com/docs/sandboxing).

## Claude Code Remote Control

```sh
openpalm remote setup claude
openpalm config assistant --claude-remote on
openpalm remote status claude
openpalm remote pair claude
```

The first command opens Claude Code inside `/work`. Accept workspace trust
yourself, use `/login` with an eligible Claude subscription, then `/remote-control`
and approve its one-time consent. Use `/exit` when finished. OpenPalm cannot
perform these approvals for you. Remote Control needs subscription sign-in, not
an Anthropic API key or an OpenCode provider login.

Startup runs native `claude remote-control` in server mode, with one concurrent
session, default interactive permissions, and Chrome access off. The pair command
shows the private native output containing the connection link, or the sign-in /
consent error if startup failed. Open the link in claude.ai/code or use Claude's
mobile app. Claude Code uses outbound HTTPS and does not need an inbound listener.
See [Anthropic's requirements and troubleshooting](https://code.claude.com/docs/en/remote-control).

The image includes Claude's AKM plugin: five discovery/feedback/remember commands,
the AKM skill, and lifecycle hooks. Claude's native loader uses
`CLAUDE_CODE_PLUGIN_DIRS=/opt/openpalm/plugins/akm`, inherited by the remote worker
and its child sessions. There is no extra install step or marketplace download,
and container updates replace the pinned plugin without rewriting your Claude
settings. Run `claude plugin list` or `claude plugin details akm` inside Assistant
to inspect it. It appears as `akm@inline`; you can disable that identity through
Claude's own `enabledPlugins` settings. Workspace trust and tool approvals still
apply. AKM uses the existing `/stash` knowledge bundle; automatic learning and
session extraction remain off (`AKM_AUTO_LEARNING=0`, `AKM_AUTO_MEMORY=0`).
See [Claude's native plugin loading reference](https://code.claude.com/docs/en/plugins/loading).

## Toggles, recovery, and trust

The optional Admin utility exposes both switches under agent preferences. Native
terminal setup is still required. CLI switches save stack intent and recreate
Assistant automatically; add `--no-apply` to defer until the next restart.

```sh
openpalm config assistant --codex-remote off --claude-remote off
```

Turning a switch off stops its container processes, but keeps native account
state and does not revoke paired devices in the vendor account. Manage account
sign-out and device revocation through the vendor's own controls. To repeat setup,
turn that agent off first to avoid competing background and interactive sessions.

These agents have trusted access to the workspace and Assistant's mounted
knowledge, like native OpenCode. Guardian's `chat`/`read`/`full` credential registry
does not control them. Do not enable them for untrusted users. They keep their
own histories and permissions; OpenPalm's automatic OpenCode memory capture and
restricted scheduled profile do not implicitly apply to vendor-native sessions.

`process-running` means only that the local process started, not that sign-in,
pairing, a remote client, or a tool call succeeded. `waiting-to-retry` includes an
exit code and next attempt time. Failures retry every five minutes without
stopping OpenCode or scheduled work. Inspect native output with `openpalm remote
logs codex` or `openpalm remote logs claude` when pairing fails. Do not paste those logs into
public issues without removing pairing links and account details.

## Acceptance checklist

1. Fresh install: both remote switches are false; neither remote worker starts.
2. Complete each vendor's interactive setup without copying host authentication.
3. Enable one switch. Verify OpenCode and scheduler remain healthy; the other
   vendor remains stopped. Inspect local status, then pair a supported client.
4. From that client, create a session, inspect a workspace file, request a harmless
   file edit, and exercise both approve and deny. Confirm approvals are not bypassed.
   For Codex, verify sandboxed execution works on this host; report unsupported
   sandbox/client limitations rather than weakening security settings.
5. Restart Assistant. Verify native sign-in persists and the remote agent starts
   again. Confirm session continuation using the vendor's own supported flow;
   no OpenCode session or Guardian policy should appear in the vendor history.
6. Test missing sign-in/consent in an isolated fresh home. The worker should wait
   to retry while OpenCode and scheduler stay healthy; no pairing link enters
   Docker logs. Fix through interactive setup with startup temporarily disabled.
7. Disable both switches. Verify all remote child processes stop and no additional
   port, privileged mount, or Guardian/portal credential reaches Assistant.

Automated tests cover config intent, CLI argument validation, private bounded
output, environment separation, retry behavior, and child-process shutdown.
Image smoke tests exercise the baked vendor CLIs. Subscription consent and
client pairing still require a human/account-supported acceptance run; package
versions and local process health alone are not an end-to-end connection test.

Maintainers can run missing-sign-in image acceptance without any real account:

```sh
OPENPALM_SMOKE_REMOTE=1 ./scripts/smoke-image.sh openpalm/assistant:remote-dev assistant
```
