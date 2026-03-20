/**
 * CLI `component` command group.
 *
 * Provides subcommands for managing component instances:
 *   list       — list available components (built-in + catalog)
 *   instances  — list enabled instances with status
 *   add        — create an instance from a component
 *   configure  — set key=value pairs on an instance .env
 *   remove     — stop, archive, and unregister an instance
 *   start      — start a stopped instance
 *   stop       — stop a running instance
 *
 * All business logic is delegated to @openpalm/lib. The CLI handles
 * argument parsing, terminal output, and Docker Compose invocation.
 */
import { defineCommand } from 'citty';
import { existsSync } from 'node:fs';
import {
  resolveOpenPalmHome,
  discoverComponents,
  listInstances,
  createInstance,
  configureInstance,
  deleteInstance,
  getInstanceDetail,
  installCaddyRoute,
  parseEnvSchema,
  buildComponentComposeArgs,
} from '@openpalm/lib';
import { runDockerCompose } from '../lib/docker.ts';

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Format a status value with color hints for terminal output.
 */
function formatStatus(enabled: boolean): string {
  return enabled ? 'enabled' : 'disabled';
}

// ── Subcommands ─────────────────────────────────────────────────────────

const listCmd = defineCommand({
  meta: {
    name: 'list',
    description: 'List available components (built-in + catalog)',
  },
  async run() {
    const home = resolveOpenPalmHome();
    const allComponents = discoverComponents(home);

    if (allComponents.length === 0) {
      console.log('No components found.');
      return;
    }

    console.log('Available components:\n');
    console.log('  ID                   Compose   Schema   Caddy');
    console.log('  ────────────────────  ────────  ───────  ─────');
    for (const comp of allComponents) {
      const id = comp.id.padEnd(20);
      const compose = comp.composePath ? 'yes' : 'no';
      const schema = comp.schemaPath ? 'yes' : 'no';
      const caddy = comp.caddyPath ? 'yes' : 'no';
      console.log(`  ${id}  ${compose.padEnd(8)}  ${schema.padEnd(7)}  ${caddy}`);
    }
    console.log(`\n  ${allComponents.length} component(s) found.`);
  },
});

const instancesCmd = defineCommand({
  meta: {
    name: 'instances',
    description: 'List enabled instances with status',
  },
  async run() {
    const home = resolveOpenPalmHome();
    const instances = listInstances(home);

    if (instances.length === 0) {
      console.log('No instances found.');
      console.log('Use `openpalm component add <component> [name]` to create one.');
      return;
    }

    console.log('Component instances:\n');
    console.log('  Instance ID          Component            Status');
    console.log('  ────────────────────  ────────────────────  ─────────');
    for (const inst of instances) {
      const id = inst.id.padEnd(20);
      const comp = inst.component.padEnd(20);
      const status = formatStatus(inst.enabled);
      console.log(`  ${id}  ${comp}  ${status}`);
    }
    console.log(`\n  ${instances.length} instance(s).`);
  },
});

const addCmd = defineCommand({
  meta: {
    name: 'add',
    description: 'Create an instance from a component',
  },
  args: {
    component: {
      type: 'positional',
      description: 'Component ID to instantiate',
      required: true,
    },
    name: {
      type: 'positional',
      description: 'Instance name (defaults to component ID)',
      required: false,
    },
  },
  async run({ args }) {
    const positionals: string[] = args._ ?? [];
    const componentId = positionals[0];
    const instanceId = positionals[1] ?? componentId;

    if (!componentId) {
      console.error('Error: component ID is required.');
      console.error('Usage: openpalm component add <component> [name]');
      process.exit(1);
    }

    const home = resolveOpenPalmHome();

    const componentDef = discoverComponents(home).find((c) => c.id === componentId);
    if (!componentDef) {
      console.error(`Error: component "${componentId}" not found.`);
      console.error('Run `openpalm component list` to see available components.');
      process.exit(1);
    }

    try {
      const instance = createInstance(home, componentDef, instanceId);
      console.log(`Created instance "${instance.id}" from component "${componentDef.id}".`);
      console.log(`  Directory: ${instance.instanceDir}`);

      // Install Caddy route if present
      if (instance.caddyPath) {
        installCaddyRoute(home, instance.id);
        console.log('  Caddy route installed.');
      }

      // Show schema fields that need configuration
      if (instance.schemaPath && existsSync(instance.schemaPath)) {
        const fields = parseEnvSchema(instance.schemaPath);
        const requiredFields = fields.filter((f) => f.required && !f.defaultValue);
        if (requiredFields.length > 0) {
          console.log('\n  Required configuration:');
          for (const field of requiredFields) {
            const help = field.helpText ? ` — ${field.helpText}` : '';
            console.log(`    ${field.name}${help}`);
          }
          console.log(`\n  Run: openpalm component configure ${instance.id} KEY=value ...`);
        }
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  },
});

const configureCmd = defineCommand({
  meta: {
    name: 'configure',
    description: 'Configure an instance with key=value pairs',
  },
  args: {
    instance: {
      type: 'positional',
      description: 'Instance ID to configure',
      required: true,
    },
    values: {
      type: 'positional',
      description: 'Key=value pairs (e.g. DISCORD_TOKEN=abc123)',
      required: false,
    },
  },
  async run({ args }) {
    const positionals: string[] = args._ ?? [];
    const instanceId = positionals[0];

    if (!instanceId) {
      console.error('Error: instance ID is required.');
      console.error('Usage: openpalm component configure <instance> KEY=value ...');
      process.exit(1);
    }

    const kvPairs = positionals.slice(1);
    if (kvPairs.length === 0) {
      // Show current configuration and schema
      const home = resolveOpenPalmHome();
      const detail = getInstanceDetail(home, instanceId);
      if (!detail) {
        console.error(`Error: instance "${instanceId}" not found.`);
        process.exit(1);
      }

      const fields = parseEnvSchema(detail.schemaPath);
      if (fields.length === 0) {
        console.log(`Instance "${instanceId}" has no configurable fields.`);
        return;
      }

      console.log(`Configuration schema for "${instanceId}":\n`);
      for (const field of fields) {
        const required = field.required ? ' (required)' : '';
        const sensitive = field.sensitive ? ' [sensitive]' : '';
        const defaultVal = field.defaultValue ? ` [default: ${field.defaultValue}]` : '';
        const help = field.helpText ? ` — ${field.helpText}` : '';
        console.log(`  ${field.name}${required}${sensitive}${defaultVal}${help}`);
      }
      console.log(`\nUsage: openpalm component configure ${instanceId} KEY=value ...`);
      return;
    }

    // Parse key=value pairs
    const values: Record<string, string> = {};
    for (const kv of kvPairs) {
      const eqIdx = kv.indexOf('=');
      if (eqIdx <= 0) {
        console.error(`Error: invalid key=value pair: "${kv}"`);
        console.error('Format: KEY=value (no spaces around =)');
        process.exit(1);
      }
      const key = kv.slice(0, eqIdx);
      const value = kv.slice(eqIdx + 1);
      values[key] = value;
    }

    const home = resolveOpenPalmHome();

    try {
      configureInstance(home, instanceId, values);
      console.log(`Configured instance "${instanceId}":`);
      for (const [key, value] of Object.entries(values)) {
        // Mask sensitive values in output
        const display = value.length > 4 ? `${value.slice(0, 4)}****` : '****';
        console.log(`  ${key}=${display}`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  },
});

const removeCmd = defineCommand({
  meta: {
    name: 'remove',
    description: 'Stop, archive, and remove an instance',
  },
  args: {
    instance: {
      type: 'positional',
      description: 'Instance ID to remove',
      required: true,
    },
  },
  async run({ args }) {
    const positionals: string[] = args._ ?? [];
    const instanceId = positionals[0];

    if (!instanceId) {
      console.error('Error: instance ID is required.');
      console.error('Usage: openpalm component remove <instance>');
      process.exit(1);
    }

    const home = resolveOpenPalmHome();

    // Stop the container first (best effort)
    try {
      const composeArgs = buildComponentComposeArgs(home);
      await runDockerCompose([...composeArgs, 'stop', `openpalm-${instanceId}`]);
    } catch {
      // Container may not be running — that's fine
    }

    try {
      deleteInstance(home, instanceId);
      console.log(`Instance "${instanceId}" removed and archived.`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  },
});

const startCmd = defineCommand({
  meta: {
    name: 'start',
    description: 'Start a stopped instance',
  },
  args: {
    instance: {
      type: 'positional',
      description: 'Instance ID to start',
      required: true,
    },
  },
  async run({ args }) {
    const positionals: string[] = args._ ?? [];
    const instanceId = positionals[0];

    if (!instanceId) {
      console.error('Error: instance ID is required.');
      console.error('Usage: openpalm component start <instance>');
      process.exit(1);
    }

    const home = resolveOpenPalmHome();

    const detail = getInstanceDetail(home, instanceId);
    if (!detail) {
      console.error(`Error: instance "${instanceId}" not found.`);
      process.exit(1);
    }

    try {
      const composeArgs = buildComponentComposeArgs(home);
      // Compose service name convention: openpalm-{instanceId}
      await runDockerCompose([...composeArgs, 'up', '-d', `openpalm-${instanceId}`]);
      console.log(`Instance "${instanceId}" started.`);
    } catch (err) {
      console.error(`Error starting instance: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  },
});

const stopCmd = defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop a running instance',
  },
  args: {
    instance: {
      type: 'positional',
      description: 'Instance ID to stop',
      required: true,
    },
  },
  async run({ args }) {
    const positionals: string[] = args._ ?? [];
    const instanceId = positionals[0];

    if (!instanceId) {
      console.error('Error: instance ID is required.');
      console.error('Usage: openpalm component stop <instance>');
      process.exit(1);
    }

    const home = resolveOpenPalmHome();

    const detail = getInstanceDetail(home, instanceId);
    if (!detail) {
      console.error(`Error: instance "${instanceId}" not found.`);
      process.exit(1);
    }

    try {
      const composeArgs = buildComponentComposeArgs(home);
      await runDockerCompose([...composeArgs, 'stop', `openpalm-${instanceId}`]);
      console.log(`Instance "${instanceId}" stopped.`);
    } catch (err) {
      console.error(`Error stopping instance: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  },
});

// ── Parent Command ──────────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: 'component',
    description: 'Manage component instances (list|instances|add|configure|remove|start|stop)',
  },
  subCommands: {
    list: listCmd,
    instances: instancesCmd,
    add: addCmd,
    configure: configureCmd,
    remove: removeCmd,
    start: startCmd,
    stop: stopCmd,
  },
});
