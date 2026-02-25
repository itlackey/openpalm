# Core: Gateway OpenCode Safety

## Immutable safety policy
- Classify actions by risk:
  - Safe = auto-run allowed
  - Medium/High = explicit approval required
- Reject actions that violate allowlists.
- Reject actions that violate data exfiltration policy.
