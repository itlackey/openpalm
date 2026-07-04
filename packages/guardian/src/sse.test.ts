/**
 * Shared SSE frame parser unit tests.
 *
 * `parseSseFrames` splits a byte-stream buffer on the blank-line frame boundary,
 * tolerating BOTH "\n\n" (LF) and "\r\n\r\n" (CRLF) separators, and returns the
 * complete frames plus the unconsumed tail (a partial frame) to carry forward.
 * `extractData` pulls the concatenated `data:` payload out of one frame.
 *
 * The CRLF cases are the correctness fix: the old oc-client splitter only knew
 * "\n\n" and would never emit a frame from a CRLF stream.
 */
import { describe, it, expect } from "bun:test";

import { parseSseFrames, extractData } from "./sse";

describe("parseSseFrames", () => {
  it("splits LF-only multi-frame input and keeps the partial tail", () => {
    const { frames, rest } = parseSseFrames("data: a\n\ndata: b\n\ndata: c");
    expect(frames).toEqual(["data: a", "data: b"]);
    expect(rest).toBe("data: c");
  });

  it("splits CRLF multi-frame input and keeps the partial tail", () => {
    const { frames, rest } = parseSseFrames("data: a\r\n\r\ndata: b\r\n\r\ndata: c");
    expect(frames).toEqual(["data: a", "data: b"]);
    expect(rest).toBe("data: c");
  });

  it("handles a mixed LF/CRLF stream", () => {
    const { frames, rest } = parseSseFrames("data: a\n\ndata: b\r\n\r\n");
    expect(frames).toEqual(["data: a", "data: b"]);
    expect(rest).toBe("");
  });

  it("returns no frames and the whole buffer when no boundary is present", () => {
    const { frames, rest } = parseSseFrames("data: partial");
    expect(frames).toEqual([]);
    expect(rest).toBe("data: partial");
  });

  it("returns empty rest when the buffer ends exactly on a boundary", () => {
    const { frames, rest } = parseSseFrames("data: a\n\n");
    expect(frames).toEqual(["data: a"]);
    expect(rest).toBe("");
  });
});

describe("extractData", () => {
  it("strips a single leading space after the colon", () => {
    expect(extractData("data: hello")).toBe("hello");
  });

  it("keeps content when there is no leading space", () => {
    expect(extractData("data:hello")).toBe("hello");
  });

  it("joins multiple data lines with a newline (LF frame)", () => {
    expect(extractData("data: a\ndata: b")).toBe("a\nb");
  });

  it("joins multiple data lines with a newline (CRLF frame)", () => {
    expect(extractData("event: msg\r\ndata: a\r\ndata: b")).toBe("a\nb");
  });

  it("ignores comment and non-data fields, returning null for a data-less frame", () => {
    expect(extractData(": heartbeat")).toBeNull();
    expect(extractData("event: ping\nid: 7")).toBeNull();
  });
});
