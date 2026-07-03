import { createInterface } from 'node:readline';

/**
 * Prompt the user for a y/N confirmation on stdin/stdout. Returns false in
 * any non-interactive context (no TTY) so CI runs do not hang waiting on
 * input — callers must pair this with an explicit `--yes` flag for
 * unattended invocations.
 */
export async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
