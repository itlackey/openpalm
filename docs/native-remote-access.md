# Optional Codex and Claude Code remote sessions

Available in `0.14.0-alpha.3` and later. Updating source alone does not update
a running installation's CLI or image; install the release CLI and run `update`.

The guided `remote enable` command and Admin sign-in dialog described below
are unreleased changes after alpha.3. They require both the new CLI/Admin and
an Assistant image containing `openpalm-remote-setup`; the published alpha.3
still uses the manual `remote setup` flow documented under advanced controls.

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
openpalm remote enable codex
# Optional: limit native tools to read-only access
openpalm remote enable codex --sandbox read-only
openpalm remote status codex
openpalm remote pair codex
```

Guided enable pauses the selected worker, checks its native sandbox with a
harmless local command, and then uses Codex device sign-in. It opens the native
sign-in URL in the host browser; enter the one-time code there. Use
`--no-browser` over SSH and open the printed link on your own computer. If device
login is unavailable, enable it in your ChatGPT account/workspace settings.
Successful setup automatically saves sandbox intent and enables startup.
It then requests a fresh private pairing code from the background service.
Startup runs native
`codex remote-control` in the foreground with `on-request` approvals and
`workspace-write` (default) or explicitly selected `read-only` sandboxing.
Both require native sandbox support; neither is a namespace-error workaround.
Pair requests a fresh short-lived code from the
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
openpalm remote enable claude
openpalm remote status claude
openpalm remote pair claude
```

Guided enable pauses the selected worker and opens native subscription sign-in
in your host browser. Complete sign-in and, if requested, paste the native code
back into the CLI or Admin dialog. It then starts native Remote Control inside
`/work`: read the workspace-trust and one-time Remote Control consent prompts
and answer `y` to accept or `n` to decline. OpenPalm never answers them for you
or rewrites native trust settings. Once the native connection URL is produced,
the setup worker stops and normal background startup is enabled automatically.
The guide waits for and opens the **background worker's** connection URL, not
the temporary setup server's URL. A startup/pairing failure rolls startup back
off; a connection link still does not prove your remote client or tools work.
Remote Control needs subscription sign-in, not
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

In Admin, open **Connections → Remote coding agents** and choose **Set up**
for Claude Code or Codex. Confirm trusted workspace access and select
**Continue**. Codex uses workspace-write automatically; its optional read-only
mode is under **Advanced settings**. The browser handles account login;
the private dialog displays native prompts and
accepts your answers. Cancellation or a failed prerequisite leaves startup off.
No terminal is required for the guided Admin flow. CLI enable requires a
terminal for prompt answers; `--trust` explicitly confirms OpenPalm's trust
warning but does not accept any vendor prompt.
After setup or restart, use Admin's **Open session** for Claude or
**Get pairing code** for Codex to refresh private connection details.

During initial CLI onboarding, optionally use:

```sh
openpalm setup --claude-remote
openpalm setup --codex-remote
```

Provider readiness runs first; these separate native accounts are never inferred
from the provider login. Only one guided setup or lifecycle operation runs at a
time. A 15-minute deadline and closing Admin cancel unfinished native setup.

Disable startup without deleting native account state:

```sh
openpalm remote disable claude
openpalm remote disable codex
```

### Advanced/manual controls (also available in alpha.3)

If you prefer the native terminal directly:

```sh
openpalm remote setup codex
openpalm config assistant --codex-remote on
openpalm remote setup claude
# Accept trust, /login, /remote-control consent, then /exit
openpalm config assistant --claude-remote on
```

Manual switches save intent and recreate Assistant; add `--no-apply` to defer.
They do not run guided prerequisite checks or sign in for you.

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
2. Use guided enable in CLI and Admin. Verify only the selected worker pauses,
   a native sign-in link opens in the host browser (with a printed fallback),
   and trust/consent are explicit human answers. Do not copy host authentication.
   Cancel once and verify startup stays off with no lingering setup process.
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
Image smoke tests exercise the baked vendor CLIs. Native prompt fixtures test
the PTY bridge, human answers and refusal, native-account reuse, sandbox failure,
cancellation, split-output URL redaction, and activation
gating. Admin E2E checks dialog navigation, focus, and safe choices. A live
credential-free container probe verified Claude's browser sign-in URL and
cancellation, and Codex's unsupported-sandbox failure before sign-in on the
tested host. Subscription consent and
client pairing still require a human/account-supported acceptance run; package
versions and local process health alone are not an end-to-end connection test.

Maintainers can run missing-sign-in image acceptance without any real account:

```sh
docker build -f containers/assistant/Dockerfile \
  --build-arg PLATFORM_VERSION=0.14.0-alpha.3 \
  -t openpalm/assistant:guided-remote-dev .
OPENPALM_SMOKE_REMOTE=1 ./scripts/smoke-image.sh openpalm/assistant:guided-remote-dev assistant
```
