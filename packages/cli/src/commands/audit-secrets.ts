import { defineCommand } from 'citty';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  auditComposeSecrets,
  auditFileBasedSecrets,
  createState,
  discoverStackOverlays,
  resolveSecretsDir,
  type SecretAuditIssue,
} from '@openpalm/lib';

export default defineCommand({
  meta: {
    name: 'audit-secrets',
    description: 'Audit stack.env, compose files, and secret file permissions for secret-boundary violations',
  },
  args: {
    format: {
      type: 'string',
      description: 'Output format: json (default) or human',
      default: 'json',
    },
  },
  async run({ args }) {
    const format = String(args.format ?? 'json').toLowerCase();
    if (format !== 'json' && format !== 'human') {
      console.error(`Unknown --format value: ${args.format}. Expected 'json' or 'human'.`);
      process.exit(2);
    }

    const state = createState();
    const issues: SecretAuditIssue[] = [];
    const stackEnvPath = `${state.stackDir}/stack.env`;

    issues.push(...auditFileBasedSecrets({
      stackEnvPath: existsSync(stackEnvPath) ? stackEnvPath : undefined,
      secretsDir: resolveSecretsDir(state.stackDir),
    }).issues);

    for (const file of discoverStackOverlays(state.homeDir)) {
      issues.push(...auditComposeSecrets(readFileSync(file, 'utf-8')).map((issue) => ({
        ...issue,
        path: issue.path ? `${file}:${issue.path}` : file,
      })));
    }

    if (format === 'json') {
      console.log(JSON.stringify({ ok: issues.length === 0, issues }));
    } else if (issues.length === 0) {
      console.log('Secret boundary audit OK.');
    } else {
      for (const issue of issues) {
        console.log(`${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}${issue.path ? ` (${issue.path})` : ''}`);
      }
    }

    process.exit(issues.length === 0 ? 0 : 1);
  },
});
