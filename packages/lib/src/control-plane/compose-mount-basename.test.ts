/**
 * Every OP_HOME bind-mount source in the shipped stack must be pre-createable
 * as the RIGHT kind of thing.
 *
 * `ensureComposeVolumeTargets` creates every bind source before compose runs
 * and decides file-vs-directory from the host basename alone (`isFileMount`:
 * a dot means a file). A DIRECTORY mount whose host basename contains a dot is
 * therefore pre-created as an empty file, and the container gets a file where
 * it needs a directory.
 *
 * That shipped once: `data/paperclip/.locale/en_US.UTF-8` was pre-created as a
 * file, the locale one-shot's `mkdir` failed with "File exists", and
 * `depends_on: service_completed_successfully` meant paperclip never started on
 * a fresh install. `isFileMount`'s own docblock asks for dotless directory
 * names; nothing enforced it.
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STACK_DIR = fileURLToPath(new URL("../../../skeleton/system/stack/", import.meta.url));

/** Host paths that are genuinely FILES, and so are correctly dotted. */
const KNOWN_FILE_MOUNTS = new Set(["auth.json"]);

function bindSources(): Array<{ file: string; source: string; line: string }> {
  const out: Array<{ file: string; source: string; line: string }> = [];
  for (const file of readdirSync(STACK_DIR).filter((f) => f.endsWith(".yml"))) {
    for (const raw of readFileSync(`${STACK_DIR}${file}`, "utf-8").split("\n")) {
      const line = raw.trim();
      // Short-form volume rows only: `- <host>:<container>[:mode]`.
      const m = /^- (\$\{OP_(?:HOME|HOST)[^:]*\}[^:]*):/.exec(line);
      if (m) out.push({ file, source: m[1], line });
    }
  }
  return out;
}

describe("compose bind-mount host basenames survive pre-creation", () => {
  it("finds the shipped bind mounts at all (guards the parser itself)", () => {
    const sources = bindSources();
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.some((s) => s.source.includes("/knowledge"))).toBe(true);
  });

  it("no DIRECTORY mount has a dotted host basename", () => {
    const offenders = bindSources()
      .map((s) => ({ ...s, basename: s.source.split("/").pop() ?? "" }))
      .filter((s) => s.basename.includes(".") && !KNOWN_FILE_MOUNTS.has(s.basename))
      // `${VAR}` basenames resolve at compose time; the heuristic sees the
      // resolved value, which this static check cannot know.
      .filter((s) => !s.basename.includes("${"));
    expect(
      offenders.map((s) => `${s.file}: ${s.source}`),
      "dotted host basenames are pre-created as empty FILES by ensureComposeVolumeTargets — use a dotless host path and put the dotted name on the container side only",
    ).toEqual([]);
  });
});
