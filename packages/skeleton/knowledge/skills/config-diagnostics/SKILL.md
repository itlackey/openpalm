---
name: config-diagnostics
type: skill
description: Diagnose OpenPalm configuration issues (missing API keys, validation errors, connection problems) using the admin /api/host/config/validate endpoint and secret presence metadata, without exposing any actual secret values.
when_to_use: Use when the user reports configuration issues, missing API keys, validation errors, or connection problems and needs guidance on what to fix without leaking secrets.
license: Proprietary
metadata:
  author: openpalm
  version: "1.0"
---

# Config Diagnostics Skill

When a user asks about configuration issues, connection problems, missing API
keys, or validation errors, use the admin API and non-secret metadata to diagnose
and guide them — without ever exposing actual secret values.

## Procedure

1. **Call `GET /api/host/config/validate`** to get the current validation result
   (authenticated via the `op_session` cookie — the legacy `x-admin-token`
   header was removed):
   ```
   GET /api/host/config/validate
   ```
   Response: `{ ok: boolean, errors: string[], warnings: string[] }`

2. **Interpret validation errors** using the variable name and documented
   filesystem contract:
   - Non-secret stack configuration belongs in `knowledge/env/stack.env`
   - Stack/runtime secrets belong in `knowledge/secrets/<lowercase_name>`
   - User AKM env config belongs in `knowledge/env/user.env`

3. **Guide the user to fix issues** via:
   - The admin UI for secret variables when available
   - Direct creation of `~/.openpalm/knowledge/secrets/<name>` with mode 0600 for stack/runtime secrets
   - Direct editing of `~/.openpalm/knowledge/env/user.env` for AKM user env values
   - The admin UI or direct edits to `knowledge/env/stack.env` for non-secret stack configuration

## Critical Rules

- **NEVER read, display, echo, or reference actual `.env` or secret file contents.**
- **NEVER suggest `cat ~/.openpalm/knowledge/env/user.env` or any command that exposes secret values.**
- When referring to a variable, use its name and expected storage location only.
  Example: "OPENAI_API_KEY is missing — this is your OpenAI API key (string,
  sensitive, required when using the openai provider)."
- Always direct users to fix secrets through the admin UI or direct file edits,
  never through the assistant terminal.

## Example Responses

**User:** "Why isn't my AI connection working?"

**Assistant:**
1. Calls `GET /api/host/config/validate`
2. Reads non-secret provider configuration and secret presence metadata
3. Responds: "Validation shows OPENAI_API_KEY is not set. This variable holds
   your OpenAI API key — set it in Settings > Secrets in the admin UI, or write
   the value to `~/.openpalm/knowledge/secrets/openai_api_key` with mode 0600."

**User:** "Can you show me my env or secret files?"

**Assistant:** "I don't read actual env or secret files to protect your credentials.
Instead, I can check the validation status via the admin API and explain what
each variable does using the schema. Would you like me to run a validation check?"
