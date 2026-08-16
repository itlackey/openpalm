/**
 * The guardian's upstream credential to the assistant.
 *
 * The property under test: it follows the SECRET FILE and nothing else. It
 * used to be gated on `OPENCODE_AUTH`, which tracked whether the assistant's
 * port was published — so the guardian attached a credential only when an
 * unrelated network toggle was on, and the assistant, the guardian and two
 * healthchecks each had to reach the same verdict about that flag.
 * Disagreement produced a 401 on every portal call rather than an error.
 *
 * The second property: it never throws. An operator who empties their own
 * secret gets an assistant serving without auth and a guardian that sends
 * none — not a guardian that refuses to start.
 */
import { describe, expect, test } from "bun:test";
import { resolveAssistantUpstreamAuth } from "./config.js";

const PASSWORD_FILE = "/run/secrets/opencode_server_password";
const withFile = (contents: string) => () => contents;

describe("resolveAssistantUpstreamAuth — follows the secret file", () => {
  test("resolves a credential with no posture flag set at all", () => {
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE },
      withFile("s3cret\n"),
    );
    expect(auth?.authorization).toBe(`Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
  });

  test("a stale OPENCODE_AUTH=false row cannot switch it off", () => {
    // Upgraded homes carry the retired key until the schema-9 sweep. Honouring
    // it would send no credential to an assistant that is serving with one.
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_AUTH: "false", OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE },
      withFile("s3cret\n"),
    );
    expect(auth?.authorization).toContain("Basic ");
  });

  test("honours OPENCODE_SERVER_USERNAME, so an override does not 401", () => {
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE, OPENCODE_SERVER_USERNAME: "custom" },
      withFile("s3cret\n"),
    );
    expect(auth?.authorization).toBe(`Basic ${Buffer.from("custom:s3cret").toString("base64")}`);
  });

  test("strips only trailing newlines, matching every other reader of this secret", () => {
    // The assistant entrypoint reads it with `$(cat)` and lib strips trailing
    // newlines only. Trimming spaces here would 401 a password like "pw ".
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE },
      withFile("pass word \n\n"),
    );
    expect(auth?.authorization).toBe(
      `Basic ${Buffer.from("opencode:pass word ").toString("base64")}`,
    );
  });

  test("UTF-8 encodes, so a non-Latin-1 password authenticates", () => {
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE },
      withFile("pässwörd🔒\n"),
    );
    expect(auth?.authorization).toBe(
      `Basic ${Buffer.from("opencode:pässwörd🔒", "utf-8").toString("base64")}`,
    );
  });
});

describe("resolveAssistantUpstreamAuth — no password means no header, never a crash", () => {
  // The assistant reads the same file the same way, so "no password here"
  // means "no password there" — sending nothing is the matching behaviour.
  // Throwing instead turned an operator emptying their own secret into a
  // guardian that would not boot, and made this module unimportable by any
  // tool or test without the compose secret mounted.
  test("no password file configured", () => {
    expect(resolveAssistantUpstreamAuth({}, withFile("s3cret\n"))).toBeNull();
  });

  test("an unreadable password file", () => {
    expect(
      resolveAssistantUpstreamAuth({ OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE }, () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });

  test("an empty or whitespace-only password file", () => {
    for (const contents of ["", "\n", "   \n", "\t\n"]) {
      expect(
        resolveAssistantUpstreamAuth(
          { OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE },
          withFile(contents),
        ),
        JSON.stringify(contents),
      ).toBeNull();
    }
  });
});
