## Pending

- Reconcile duplicate/overlapping variables in stack.env.schema
- Reconcile stack.yaml settings vs stack.env variables
- Ensure all code related to managed.env is removed
- Do a full audit or all code related to service/addon environment variable handling
- Support add-on config, data, and vault directories that will copy to OP_HOME when the addon is installed
  - need to decide on directory naming that supports instances
- Refactor to add .openpalm/registry and move addons and optional schedule tasks into the registry
  - Update the compose arg parsing so it uses only the subdirectories of stack/addons and does not require the stack.yaml entries
  - Need to verify that this refactor does not break functionality currently provided by the addon object in stack.yaml and that those options can be handled in the compose file and/or via the config/data/vault copying for addons

## Next

- Clean up tests that should move to lib from admin and other packages
- Consider running openviking from the existing memory container
