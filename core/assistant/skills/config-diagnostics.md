# Config Diagnostics Skill

When a user asks about configuration issues, connection problems, missing API
keys, or validation errors, use the admin API and schema files to diagnose
and guide them — without ever exposing actual secret values.

## Procedure

1. **Call `GET /admin/config/validate`** to get the current validation result:
   ```
   GET /admin/config/validate
   x-admin-token: <admin-token>
   ```
   Response: `{ ok: boolean, errors: string[], warnings: string[] }`

2. **Read schema files** at `/etc/opencode/env-schema/` to understand variable
   descriptions, types, and requirements:
   - `secrets.env.schema` — user secrets (API keys, tokens, credentials)
   - `stack.env.schema` — system-managed paths and runtime identity

3. **Interpret validation errors** using the schema metadata:
   - Match error variable names to schema entries for human-readable descriptions
   - Use `# @type` annotations to explain the expected format
   - Use `# @required` annotations to explain why the variable is needed

4. **Guide the user to fix issues** via:
   - The admin UI (Settings > Secrets) for secret variables
   - Direct editing of `CONFIG_HOME/secrets.env` for advanced users
   - The admin UI (Settings > Stack) for system configuration

## Critical Rules

- **NEVER read, display, echo, or reference actual `.env` file contents.**
  Schema files describe variable structure — they contain no real values.
- **NEVER suggest `cat secrets.env` or any command that exposes secret values.**
- When referring to a variable, use its name and schema description only.
  Example: "OPENAI_API_KEY is missing — this is your OpenAI API key (string,
  sensitive, required when using the openai provider)."
- Always direct users to fix secrets through the admin UI or direct file edits,
  never through the assistant terminal.

## Example Responses

**User:** "Why isn't my AI connection working?"

**Assistant:**
1. Calls `GET /admin/config/validate`
2. Reads `secrets.env.schema` to find OPENAI_API_KEY description
3. Responds: "Validation shows OPENAI_API_KEY is not set. This variable holds
   your OpenAI API key — set it in Settings > Secrets in the admin UI, or add
   `OPENAI_API_KEY=<your-key>` to `~/.config/openpalm/secrets.env`."

**User:** "Can you show me my secrets.env file?"

**Assistant:** "I don't read actual secret files to protect your credentials.
Instead, I can check the validation status via the admin API and explain what
each variable does using the schema. Would you like me to run a validation check?"
