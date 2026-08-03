import { defineCommand } from 'citty';
import {
  getAutomationRegistrationStatus,
  type AutomationRegistrationStatus,
  type ControlPlaneState,
} from '@openpalm/lib';
import { defineAction } from '../lib/action.ts';
import { ensureValidState } from '../lib/cli-state.ts';

type AutomationsCheckDeps = {
  getState: () => ControlPlaneState;
  inspect: (state: ControlPlaneState) => Promise<AutomationRegistrationStatus>;
};

const defaultDeps: AutomationsCheckDeps = {
  getState: ensureValidState,
  inspect: getAutomationRegistrationStatus,
};

const TERMINAL_UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function quoteDiagnosticValue(value: string): string {
  let escaped = '';
  for (const character of value) {
    if (character === '"' || character === '\\') {
      escaped += `\\${character}`;
      continue;
    }
    if (TERMINAL_UNSAFE_RE.test(character)) {
      const codePoint = character.codePointAt(0) ?? 0;
      escaped += codePoint <= 0xffff
        ? `\\u${codePoint.toString(16).padStart(4, '0')}`
        : `\\u{${codePoint.toString(16)}}`;
      continue;
    }
    escaped += character;
  }
  return `"${escaped}"`;
}

function quoteDiagnosticValues(values: string[]): string {
  return values.map(quoteDiagnosticValue).join(', ');
}

export async function automationsCheck(deps: AutomationsCheckDeps = defaultDeps): Promise<void> {
  const status = await deps.inspect(deps.getState());
  if (!status.ok) {
    throw new Error(`Unable to inspect the Assistant scheduler: ${status.error}`);
  }
  if (status.localFileNames.length === 0) {
    console.log('No local automation task files installed.');
  } else {
    console.log(`Found ${status.localFileNames.length} local automation task file(s):`);
    for (const fileName of status.localFileNames) {
      console.log(`  - ${quoteDiagnosticValue(fileName)}`);
    }

    console.log(
      `Scheduler ID matches: ${status.matchingSchedulerIds.length}/${status.localFileNames.length} (bundle attribution unavailable)`,
    );
    if (status.localOnlyFileNames.length > 0) {
      console.log(
        `Local files without a matching scheduler ID: ${quoteDiagnosticValues(status.localOnlyFileNames)}`,
      );
    }
  }

  if (status.schedulerOnlyTaskIds.length > 0) {
    console.log(`Scheduler-only IDs: ${quoteDiagnosticValues(status.schedulerOnlyTaskIds)}`);
  }
}

export default defineCommand({
  meta: {
    name: 'automations',
    description: 'Manage automation tasks',
  },
  subCommands: {
    check: defineCommand({
      meta: {
        name: 'check',
        description: 'Report automation task registration status',
      },
      run: defineAction(async () => {
        await automationsCheck();
      }),
    }),
  },
});
