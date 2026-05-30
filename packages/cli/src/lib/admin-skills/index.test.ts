import { describe, it, expect } from "bun:test";
import {
  validateContainerOp,
  validateDestructiveOp,
  validatePathArg,
  validateAddonName,
} from "./index.ts";

describe("validateContainerOp", () => {
  it("rejects path traversal in service name", () => {
    const r = validateContainerOp("../../etc/passwd");
    expect(r.ok).toBe(false);
  });

  it("rejects unknown service name", () => {
    const r = validateContainerOp("evil-service");
    expect(r.ok).toBe(false);
  });

  it("accepts a valid core service name", () => {
    // CORE_SERVICES contains "assistant"
    const r = validateContainerOp("assistant");
    expect(r.ok).toBe(true);
  });
});

describe("validateDestructiveOp", () => {
  it("rejects empty confirmation", () => {
    const r = validateDestructiveOp("");
    expect(r.ok).toBe(false);
  });

  it("rejects wrong confirmation string", () => {
    const r = validateDestructiveOp("yes");
    expect(r.ok).toBe(false);
  });

  it("accepts correct confirmation", () => {
    const r = validateDestructiveOp("yes-i-am-sure");
    expect(r.ok).toBe(true);
  });
});

describe("validatePathArg", () => {
  it("rejects path traversal", () => {
    expect(validatePathArg("../../secrets").ok).toBe(false);
  });

  it("rejects shell injection characters", () => {
    expect(validatePathArg("foo$(rm -rf /)").ok).toBe(false);
  });

  it("accepts a normal relative path", () => {
    expect(validatePathArg("knowledge/tasks/my-task.yml").ok).toBe(true);
  });
});

describe("validateAddonName", () => {
  it("rejects names with slashes", () => {
    expect(validateAddonName("../../admin").ok).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(validateAddonName("my addon").ok).toBe(false);
  });

  it("accepts a clean addon name", () => {
    expect(validateAddonName("voice-channel").ok).toBe(true);
  });
});
