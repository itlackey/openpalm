/**
 * Shared Server-Sent Events (SSE) frame parsing.
 *
 * Two guardian call sites consume an upstream SSE byte stream (the /event
 * fan-out and the OpenCode client). Both need to (1) split the incoming buffer
 * on the blank-line frame boundary while carrying a partial trailing frame
 * forward, and (2) extract the `data:` payload of each complete frame. This
 * module is the single source of truth so the two paths cannot diverge.
 *
 * Frame boundaries: per the SSE spec a blank line ("\n\n") ends a frame; a
 * CRLF stream uses "\r\n\r\n". BOTH are tolerated here.
 */

/**
 * Split `buffer` into complete SSE frames on the blank-line boundary, tolerating
 * both "\n\n" and "\r\n\r\n". Returns the complete frames (separator stripped)
 * and the unconsumed tail (`rest`, a partial frame) to prepend to the next chunk.
 */
export function parseSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let working = buffer;
  let boundary = nextFrameBoundary(working);
  while (boundary !== -1) {
    frames.push(working.slice(0, boundary));
    working = working.slice(advancePastBoundary(working, boundary));
    boundary = nextFrameBoundary(working);
  }
  return { frames, rest: working };
}

function nextFrameBoundary(s: string): number {
  const lf = s.indexOf("\n\n");
  const crlf = s.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function advancePastBoundary(s: string, boundary: number): number {
  // Skip the blank-line separator itself.
  if (s.startsWith("\r\n\r\n", boundary)) return boundary + 4;
  return boundary + 2;
}

/**
 * Extract the concatenated `data:` field value from one SSE frame (per the SSE
 * spec a frame may have multiple `data:` lines joined by "\n"). Ignores comment
 * (":") lines and other fields (event:, id:). Returns null if the frame has no
 * data line (e.g. a heartbeat comment).
 */
export function extractData(rawFrame: string): string | null {
  const dataLines: string[] = [];
  for (const line of rawFrame.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      // Per spec a single leading space after the colon is stripped.
      dataLines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}
