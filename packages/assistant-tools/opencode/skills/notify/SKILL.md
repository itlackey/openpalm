---
description: Send notifications to various destinations such as Discord, Telegram, Slack, Microsoft Teams, and email.
---

# Notify

Use this skill when you need to send a notification to a human or system audience without building a custom integration for that destination.

## Objective

Send short operational notifications with a familiar interface:

- `--channel` maps to an Apprise tag
- `--subject` or `--title` maps to the Apprise title
- `--body` or `--stdin` provides the message body
- destination routing lives in an Apprise config file instead of hard-coded SMTP recipients

## Requirements

Install the Apprise CLI before using this skill if it is not already available in your environment.:

```bash
pip install apprise
```

## Script

Run the wrapper script from this skill directory:

```bash
bash scripts/notify.sh [options]
```

Recommended pattern:

1. Put real destinations in an Apprise config file.
2. Tag each destination by audience or urgency.
3. Call `notify.sh` with a title, a body, and one or more tags.

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--channel, -c` | Apprise tag to notify; alias for `--tag` | - |
| `--tag, -g` | Apprise tag to notify; can be repeated | - |
| `--config, -f` | Apprise config file; can be repeated | Apprise default search paths |
| `--subject, --title, -s, -t` | Notification title | `Notification` |
| `--body, -b` | Message body | - |
| `--stdin` | Read message body from stdin | false |
| `--attach` | Attachment path or URL; can be repeated | - |
| `--dry-run, -d` | Resolve config and tags without sending | false |

## Usage Pattern

For one audience:

```bash
bash scripts/notify.sh \
  --channel ops \
  --subject "Deploy complete" \
  --body "Release 2026.03.28 is now live"
```

For multiple audiences using OR logic:

```bash
bash scripts/notify.sh \
  --tag ops \
  --tag email \
  --subject "Deploy complete" \
  --body "Release 2026.03.28 is now live"
```

For a narrower filter using AND logic:

```bash
bash scripts/notify.sh \
  --tag ops,critical \
  --subject "Database error" \
  --body "Primary database health checks are failing"
```

## Config Resolution

Configuration is resolved in this order:

1. `--config` / `-f` values passed to the script
2. `APPRISE_NOTIFY_CONFIG` environment variable
3. Apprise default config search paths such as `~/.apprise`, `~/.config/apprise.conf`, and `~/.config/apprise.yaml`

Example:

```bash
export APPRISE_NOTIFY_CONFIG="$HOME/.config/apprise/apprise.conf"
```

See `examples/apprise.conf` and `examples/apprise.yaml` for starter configs, including Telegram, Slack, and Microsoft Teams examples.


## Config Model

This skill expects an Apprise config file in text or YAML format.

Simple text example:

```text
discord=discord://webhook_id/webhook_token
alerts,critical=discord://another_webhook_id/another_webhook_token
email=mailtos://user:password@smtp.example.com?to=team@example.com&from=bot@example.com
```

Tag behavior follows Apprise rules:

- repeated `--tag` values use OR logic
- comma-separated tags inside one value use AND logic


## Operating Notes

- The wrapper fails fast if the `apprise` CLI is not installed.
- The wrapper requires at least one `--channel` or `--tag`.
- If `--body` is omitted and stdin is piped, stdin is consumed automatically.
- Prefer tags over raw Apprise URLs so credentials stay in config files instead of shell history.
- The config examples in this skill follow Apprise text-config syntax documented at `https://appriseit.com/config/`.
