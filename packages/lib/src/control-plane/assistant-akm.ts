import type { ControlPlaneState } from './types.js';
import { buildComposeOptions } from './compose-args.js';
import { composeExec } from './docker.js';

export type AssistantAkmCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  missing: boolean;
};

function looksMissing(stderr: string, exitCode: number): boolean {
  return exitCode === 127 || /executable file not found|no such file|not found/i.test(stderr);
}

export async function runAssistantAkmCommand(
  state: ControlPlaneState,
  args: string[],
  timeoutMs: number,
  options: { allowExitCodes?: number[] } = {},
): Promise<AssistantAkmCommandResult> {
  const result = await composeExec('assistant', ['akm', ...args], {
    ...buildComposeOptions(state),
    timeoutMs,
  });
  const allowed = (options.allowExitCodes ?? []).includes(result.code);

  return {
    ok: result.ok || allowed,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
    missing: looksMissing(result.stderr, result.code),
  };
}
