import { describe, expect, it } from "bun:test";
import { json } from "./http.ts";

describe("json helper", () => {
  it("returns compact JSON without pretty-print whitespace", async () => {
    const response = json(200, { a: 1, nested: { b: 2 } });
    const body = await response.text();

    expect(body).toBe('{"a":1,"nested":{"b":2}}');
  });

  it("sets status and content-type", () => {
    const response = json(201, { ok: true });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
  });
});
