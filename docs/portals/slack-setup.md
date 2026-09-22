# Slack adapter

Slack is an optional Socket Mode adapter and MCP client of Guardian.

## 1. Create the Slack app

Create an app in the Slack API console and:

1. enable Socket Mode;
2. create an app-level token with `connections:write`;
3. grant the bot `app_mentions:read`, `chat:write`, and the history scopes
   needed for the channel types you will allow;
4. subscribe to `app_mention` plus the message events needed for those channel
   types; and
5. install the app to the workspace.

Store the bot and app tokens through the CLI:

```bash
openpalm portal token slack \
  --bot-token-file /private/path/to/bot-token \
  --app-token-file /private/path/to/app-token
```

Both files must be mode 0600. Do not store the values in Compose environment
variables.

In OpenPalm Admin, **Connections → Slack** presents the same scopes and event
checklist and opens Slack's app console. **Add Slack tokens** moves directly to
the private token form. Both tokens are required initially; afterward either
one can be rotated without re-entering the other.

## 2. Configure a default-deny scope

Configure access through validated stack intent:

```bash
openpalm portal access slack --channels C0123456789 --no-apply
```

Values are comma-separated Slack IDs. Every non-empty allowlist must match. A
blocked user always loses access. Configure users alone to allow direct
messages; a DM cannot satisfy a channel constraint. The adapter refuses all use
when both allowlists are empty.

In Admin, expand **Who can use it**, enter the same IDs, choose the default
access identity, and select **Save connections**. If a required scope or token
is missing, Admin opens and focuses the exact field that needs attention.

## 3. Enable and verify

```bash
openpalm credential set-policy slack chat
openpalm config portal slack --credential slack --no-apply
openpalm addon enable slack
openpalm status
openpalm logs
```

`chat` is the safe default for a shared chat platform. `read` additionally lets
the agent inspect non-secret content in `/stash` and `/work`; `full` inherits Assistant tool
permissions and should be used only when both the Slack allowlist and every
permitted user are trusted to trigger state-changing work.

The selected credential is the fallback for every allowed Slack user. Map an
exact Slack user ID to another named credential when that user needs a different
policy:

```bash
openpalm credential add support-read read
openpalm credential map slack U012ABCDEF support-read
openpalm credential mappings slack
```

Remove the override with `openpalm credential unmap slack U012ABCDEF`. Channel,
user, and block-list checks still apply; a credential mapping never grants
portal access. The portal receives only a generated keyring for its fallback
and mapped credentials. Guardian OAuth issuer/subject mappings use the same
registry for remote MCP clients; Slack itself continues to use exact
platform-user mappings.

Mention the app in an allowed channel or message it directly when the user
scope permits that. Thread replies retain an opaque, credential-scoped Guardian
conversation handle. Changing a user's mapping starts fresh policy continuity.
Send `/clear` or `!clear` to reset it.

The Slack adapter is intentionally a conversational subset of the MCP catalog.
If a `full` agent pauses for a permission decision, the adapter tells the user
to complete that explicit decision with a full MCP client; chat text is never
treated as permission approval.

Continuity state is stored at `data/portal/slack/portal.db`.
