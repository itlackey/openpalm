/**
 * Terminal UI helpers with no external dependencies
 */

import { createInterface } from "node:readline/promises";

// Detect if colors should be disabled
const NO_COLOR = Bun.env.NO_COLOR !== undefined;
const IS_TTY = process.stdout.isTTY;
const COLORS_ENABLED = !NO_COLOR && IS_TTY;

// ANSI color codes
const ANSI = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  GREEN: "\x1b[32m",
  RED: "\x1b[31m",
  YELLOW: "\x1b[33m",
  CYAN: "\x1b[36m",
};

/**
 * Wrap text in bold ANSI codes
 */
export function bold(text: string): string {
  return COLORS_ENABLED ? `${ANSI.BOLD}${text}${ANSI.RESET}` : text;
}

/**
 * Wrap text in green ANSI codes
 */
export function green(text: string): string {
  return COLORS_ENABLED ? `${ANSI.GREEN}${text}${ANSI.RESET}` : text;
}

/**
 * Wrap text in yellow ANSI codes
 */
export function yellow(text: string): string {
  return COLORS_ENABLED ? `${ANSI.YELLOW}${text}${ANSI.RESET}` : text;
}

/**
 * Wrap text in cyan ANSI codes
 */
export function cyan(text: string): string {
  return COLORS_ENABLED ? `${ANSI.CYAN}${text}${ANSI.RESET}` : text;
}

/**
 * Wrap text in dim ANSI codes
 */
export function dim(text: string): string {
  return COLORS_ENABLED ? `${ANSI.DIM}${text}${ANSI.RESET}` : text;
}

/**
 * Log a message to stdout
 */
export function log(msg: string): void {
  console.log(msg);
}

/**
 * Log an info message with cyan prefix
 */
export function info(msg: string): void {
  console.log(`${cyan("ℹ")} ${msg}`);
}

/**
 * Log a warning message with yellow prefix
 */
export function warn(msg: string): void {
  console.log(`${yellow("⚠")} ${msg}`);
}

/**
 * Log an error message with red prefix
 */
export function error(msg: string): void {
  console.error(`${COLORS_ENABLED ? `${ANSI.RED}✖${ANSI.RESET}` : "✖"} ${msg}`);
}

/**
 * Create a spinner that rotates through animation characters
 */
export function spinner(msg: string): { stop: (finalMsg?: string) => void } {
  const frames = ["|", "/", "-", "\\"];
  let frameIndex = 0;
  let intervalId: Timer | null = null;

  if (IS_TTY) {
    intervalId = setInterval(() => {
      const frame = frames[frameIndex];
      frameIndex = (frameIndex + 1) % frames.length;
      process.stdout.write(`\r${cyan(frame)} ${msg}`);
    }, 80);
  } else {
    // If not TTY, just print the message once
    console.log(msg);
  }

  return {
    stop(finalMsg?: string): void {
      if (intervalId) {
        clearInterval(intervalId);
      }
      if (IS_TTY) {
        // Clear the line
        process.stdout.write("\r\x1b[K");
      }
      if (finalMsg) {
        console.log(finalMsg);
      }
    },
  };
}

/**
 * Prompt user for yes/no confirmation
 */
export async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const input = await rl.question(`${prompt} ${dim("(y/N)")}: `);
  rl.close();

  const answer = input.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
