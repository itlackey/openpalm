import { defineCommand } from 'citty';
import { existsSync, readFileSync } from 'node:fs';
import {
  auditComposeSecrets,
  auditFileBasedSecrets,
  auditSecretFilesystem,
  createState,
  discoverStackOverlays,
  privateSecretsDir,
  secretsDir,
  stackEnvFile,
  type SecretAuditIssue,
} from '@openpalm/lib';
import { parseOutputFormat } from '../lib/output-format.ts';

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
    const format = parseOutputFormat(args.format);
    if (!format) {
      console.error(`Unknown --format value: ${args.format}. Expected 'json' or 'human'.`);
      process.exit(2);
    }

    const state = createState();
    const issues: SecretAuditIssue[] = [];
    const stackEnvPath = stackEnvFile(state.homeDir);

    // Pure path resolvers only: resolveSecretsDir()/resolvePrivateSecretsDir()
    // mkdir the directory and chmod it and its files to the exact modes
    // auditSecretFilesystem checks for, so auditing through them would repair
    // the violations instead of reporting them.
    issues.push(...auditFileBasedSecrets({
      stackEnvPath: existsSync(stackEnvPath) ? stackEnvPath : undefined,
      secretsDir: secretsDir(state.homeDir),
    }).issues);

    // G1: delegated secrets (guardian/portal-only) live under private/secrets/,
    // not knowledge/secrets/ — audit that tree too so a permission regression
    // there (e.g. a world-readable op_guardian_admin_token) is not silently
    // missed just because it moved out of the stash.
    if (existsSync(privateSecretsDir(state.homeDir))) {
      issues.push(...auditSecretFilesystem(privateSecretsDir(state.homeDir)));
    }

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
