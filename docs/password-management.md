# Credential and secret management

OpenPalm separates Assistant provider authentication, named Guardian/MCP
credentials, and service-specific runtime secrets.

## Layout

```text
~/.openpalm/
  state/
    stack.json                         # non-secret intent and credential metadata
    stack.env                          # derived non-secret Compose values
    credentials/
      registry.json                    # derived key-free Guardian registry
      <username>/key                   # named bearer key
    portal-credentials/
      discord/credentials.json         # derived Discord-scoped keyring
      slack/credentials.json           # derived Slack-scoped keyring
    secrets/
      op_opencode_password             # native OpenCode Basic-auth password
      op_guardian_handle_key           # opaque-handle encryption/ownership key
      discord_bot_token
      slack_bot_token
      slack_app_token
  knowledge/secrets/auth.json          # Assistant-readable provider auth
```

Private directories use mode `0700`; key and secret files use mode `0600`.
Assistant never receives `state/credentials`, the Guardian handle key, or
portal platform tokens.

## Named Guardian credentials

Each credential has an operator-facing username, a stable internal identity, a
private key, and a `chat`, `read`, or `full` policy.

```bash
openpalm credential list
openpalm credential add automation read
openpalm credential show automation
openpalm credential set-policy automation full
openpalm credential rotate automation
openpalm credential remove automation
```

`add` and `rotate` generate a key unless `--key-file <path>` or `--key-file -`
is supplied. `show` omits the key unless `--show-key` is explicit. Do not pass
keys directly in command arguments.

Guardian receives the whole named store read-only because it must authenticate
every key. Select each portal's fallback credential with:

```bash
openpalm config portal discord --credential automation
openpalm config portal slack --credential automation
```

Map exact platform users to other credentials with:

```bash
openpalm credential map discord 123456789012345678 support-read
openpalm credential map slack U012ABCDEF automation
openpalm credential mappings discord
openpalm credential unmap slack U012ABCDEF
```

The operator-owned maps live at
`config/portal/<discord|slack>/credentials.json`. The control plane validates
them and generates a separate private runtime keyring for each portal. A
keyring contains only the fallback and credentials referenced by that portal's
map. Mapping does not bypass the portal's default-deny allowlists.

The bearer header contains only the key. Rotating a key preserves the stable
identity and its owned sessions. Removing and recreating a username creates a
new identity.

## Provider authentication

`knowledge/secrets/auth.json` is intentionally Assistant-readable because
OpenCode needs model-provider credentials. Guardian receives a narrow read-only
mount of that file for its loopback moderator. Keep Guardian keys and service
secrets out of `knowledge/` and `workspace/`.

## Non-secret environment

`state/stack.env` contains only derived paths, image pins, bind addresses,
ports, enabled profiles, and lifecycle state. Never put passwords, bearer keys,
provider keys, or credential JSON in
that file, Compose `environment`, logs, or project configuration.
