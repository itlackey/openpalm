## New Snippet: [name]

### Type
- [ ] Channel
- [ ] Service
- [ ] Automation

### Checklist
- [ ] YAML file is in the correct `community/snippets/{channels,services,automations}/` directory
- [ ] Passes schema validation (CI will verify)
- [ ] `metadata.id` is unique (no conflict with existing snippets)
- [ ] `metadata.description` is clear and accurate (10-500 chars)
- [ ] All `env` entries have `name`, `label`, `type`, and `required`
- [ ] `security` block honestly describes capabilities
- [ ] I have tested this container image locally

### GitHub Topic (for self-hosted discovery)
If you're also publishing this snippet as a self-hosted repo, tag it with:
- `openpalm-channel` for channels
- `openpalm-service` for services
- `openpalm-automation` for automations

### Notes
<!-- Any additional context about this snippet -->
