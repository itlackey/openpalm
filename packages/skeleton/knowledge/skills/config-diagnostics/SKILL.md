---
name: config-diagnostics
type: skill
description: Diagnose assistant-visible OpenPalm configuration without reading secret values or claiming host-admin access.
when_to_use: Use when the user reports provider, AKM, model, or assistant configuration problems.
license: MPL-2.0
metadata:
  author: openpalm
  version: "1.1"
---

# Config Diagnostics

The assistant is isolated from the host control plane. It has no admin session,
admin credential, Docker socket, or default network path to the host admin
process. Never call `/api/host/*` or imply that host validation was performed.

## Procedure

1. Identify whether the symptom belongs to assistant-visible OpenCode/AKM state
   or to host-owned stack state.
2. For assistant-visible state, inspect only non-secret configuration and error
   metadata under the mounted boundaries:
   - managed OpenCode config at `/etc/opencode`
   - user OpenCode config at `/home/opencode/.config/opencode`
   - AKM config at `/etc/akm`
   - task and knowledge metadata under `/stash`
3. Do not read or display `/stash/secrets/auth.json`, `/stash/env/user.env`,
   `/run/secrets/*`, or environment values that may contain credentials.
4. For Docker, bind, delegated-secret, setup, or host lifecycle problems, ask
   the operator to use the Admin UI diagnostics or run the relevant host command:
   - `openpalm validate`
   - `openpalm doctor`
   - `openpalm status`
5. Explain the expected storage boundary without asking the user to paste a
   value into chat:
   - provider OpenCode auth: `knowledge/secrets/auth.json`
   - delegated UI/Guardian/API/portal/bot credentials: `private/secrets/`
   - AKM user env: `knowledge/env/user.env`
   - non-secret runtime state: `state/stack.env`

## Rules

- Never print, summarize, transform, or confirm the contents of a secret file.
- Never ask the user to paste a credential into chat or the assistant terminal.
- Do not describe a missing provider key unless an actual non-secret error or
  operator-run diagnostic identifies it.
- Clearly label host checks as instructions for the operator, not checks the
  assistant ran.
- Prefer the Admin UI for credential changes; direct file editing is an advanced
  host-side operation.
