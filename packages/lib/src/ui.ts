import { createInterface } from "node:readline/promises";

const NO_COLOR = Bun.env.NO_COLOR !== undefined;
const IS_TTY = process.stdout.isTTY;
const COLORS_ENABLED = !NO_COLOR && IS_TTY;

const ANSI = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  GREEN: "\x1b[32m",
  RED: "\x1b[31m",
  YELLOW: "\x1b[33m",
  CYAN: "\x1b[36m",
};

export function bold(text: string): string { return COLORS_ENABLED ? `${ANSI.BOLD}${text}${ANSI.RESET}` : text; }
export function green(text: string): string { return COLORS_ENABLED ? `${ANSI.GREEN}${text}${ANSI.RESET}` : text; }
export function yellow(text: string): string { return COLORS_ENABLED ? `${ANSI.YELLOW}${text}${ANSI.RESET}` : text; }
export function cyan(text: string): string { return COLORS_ENABLED ? `${ANSI.CYAN}${text}${ANSI.RESET}` : text; }
export function dim(text: string): string { return COLORS_ENABLED ? `${ANSI.DIM}${text}${ANSI.RESET}` : text; }
export function log(msg: string): void { console.log(msg); }
export function info(msg: string): void { console.log(`${cyan("ℹ")} ${msg}`); }
export function warn(msg: string): void { console.log(`${yellow("⚠")} ${msg}`); }
export function error(msg: string): void { console.error(`${COLORS_ENABLED ? `${ANSI.RED}✖${ANSI.RESET}` : "✖"} ${msg}`); }

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
