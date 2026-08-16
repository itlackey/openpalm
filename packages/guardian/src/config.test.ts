/**
 * The guardian's upstream credential to the assistant.
 *
 * The property under test is that it is UNCONDITIONAL. This used to be gated
 * on `OPENCODE_AUTH`, which tracked whether the assistant's port was
 * published — so the guardian attached a credential only when an unrelated
 * network toggle was on, and the assistant, the guardian and two healthchecks
 * each had to reach the same verdict about that flag. Disagreement produced a
 * 401 on every portal call rather than an error anyone could see.
 *
 * The second property is fail-closed at BOOT: a guardian that cannot resolve
 * the credential must refuse to start, not start and 401 forever.
 */
import { describe, expect, test } from "bun:test";
import { resolveAssistantUpstreamAuth } from "./config.js";

const PASSWORD_FILE = "/run/secrets/opencode_server_password";
const withFile = (contents: string) => () => contents;

describe("resolveAssistantUpstreamAuth — always attached", () => {
  test("resolves a credential with no posture flag set at all", () => {
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE },
      withFile("s3cret\n"),
    );
    expect(auth.authorization).toBe(`Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
  });

  test("a stale OPENCODE_AUTH=false row cannot switch it off", () => {
    // Upgraded homes carry the retired key until the schema-9 sweep. Honouring
    // it would send no credential to an always-authenticated assistant.
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_AUTH: "false", OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE },
      withFile("s3cret\n"),
    );
    expect(auth.authorization).toContain("Basic ");
  });

  test("honours OPENCODE_SERVER_USERNAME, so an override does not 401", () => {
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE, OPENCODE_SERVER_USERNAME: "custom" },
      withFile("s3cret\n"),
    );
    expect(auth.authorization).toBe(`Basic ${Buffer.from("custom:s3cret").toString("base64")}`);
  });

  test("strips only trailing newlines, matching every other reader of this secret", () => {
    // The assistant entrypoint reads it with `$(cat)` and lib strips trailing
    // newlines only. Trimming spaces here would 401 a password like "pw ".
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE },
      withFile("pass word \n\n"),
    );
    expect(auth.authorization).toBe(
      `Basic ${Buffer.from("opencode:pass word ").toString("base64")}`,
    );
  });

  test("UTF-8 encodes, so a non-Latin-1 password authenticates", () => {
    const auth = resolveAssistantUpstreamAuth(
      { OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE },
      withFile("pässwörd🔒\n"),
    );
    expect(auth.authorization).toBe(
      `Basic ${Buffer.from("opencode:pässwörd🔒", "utf-8").toString("base64")}`,
    );
  });
});

describe("resolveAssistantUpstreamAuth — fail closed at boot", () => {
  test("no password file configured is a boot error naming the variable", () => {
    expect(() => resolveAssistantUpstreamAuth({}, withFile("s3cret\n"))).toThrow(
      /OPENCODE_SERVER_PASSWORD_FILE is not set/,
    );
  });

  test("an unreadable password file is a boot error naming the path", () => {
    expect(() =>
      resolveAssistantUpstreamAuth({ OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE }, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(new RegExp(PASSWORD_FILE));
  });

  test("an empty password file is a boot error, never an empty credential", () => {
    for (const contents of ["", "\n", "   \n"]) {
      expect(() =>
        resolveAssistantUpstreamAuth(
          { OPENCODE_SERVER_PASSWORD_FILE: PASSWORD_FILE },
          withFile(contents),
        ),
      ).toThrow(/is empty/);
    }
  });
});
