# Quick Usage

```bash
# Send to the tag named "ops"
bash scripts/notify.sh --channel ops --subject "Task Complete" --body "The build finished successfully"

# Read body from stdin
bun test 2>&1 | bash scripts/notify.sh --channel ops --subject "Test Results" --stdin

# Use an explicit config file
bash scripts/notify.sh --channel alerts --config ~/.config/apprise/apprise.conf --subject "Alert" --body "Something happened"
```

## Examples

### Notify on task completion

```bash
bash scripts/notify.sh -c ops -s "Agent Task Complete" -b "Successfully processed 12 issues"
```

### Send build results

```bash
bun test 2>&1 | bash scripts/notify.sh -c ops -s "Test Results" --stdin
```

### Alert on error

```bash
journalctl -u my-service -n 50 | bash scripts/notify.sh -c alerts -s "ERROR: Service Failed" --stdin
```

### Notify multiple audiences

```bash
bash scripts/notify.sh --tag ops --tag email --subject "Deploy finished" --body "Production is updated"
```
