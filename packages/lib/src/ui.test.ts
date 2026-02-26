import { describe, expect, it, mock } from "bun:test";

describe("confirm", () => {
  it("uses readline interface and closes it after prompt", async () => {
    const answers = ["yes", "no"];
    let closeCalls = 0;

    mock.module("node:readline/promises", () => ({
      createInterface: () => ({
        question: async () => answers.shift() ?? "",
        close: () => {
          closeCalls += 1;
        },
      }),
    }));

    const { confirm } = await import("./ui.ts");

    await expect(confirm("Proceed?")).resolves.toBe(true);
    await expect(confirm("Proceed?")).resolves.toBe(false);
    expect(closeCalls).toBe(2);
  });
});
