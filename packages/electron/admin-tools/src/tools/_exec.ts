/**
 * Shared execFile wrapper for the admin-tools compose lifecycle tools:
 * captures stdout/stderr and a numeric exit code, with no shell interpolation
 * (repo "no shell strings" rule).
 */
import { execFile } from "node:child_process";

export function runCapture(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const errno = (err as NodeJS.ErrnoException | null)?.code;
      const code = typeof errno === "number" ? errno : err ? 1 : 0;
      resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code });
    });
  });
}
