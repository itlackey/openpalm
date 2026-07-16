/**
 * Pure unit tests for the /oc path safety gate + route classifier that replaced
 * the old default-deny allowlist. These run in-process (no upstream) and pin the
 * two behaviours the transparent proxy relies on:
 *   - canonicalizeOcPath: percent-decode + `..` traversal refusal (proxy hygiene),
 *     forwarding the DECODED path so the guardian and OpenCode agree on it.
 *   - classifyOcRoute: recognises exactly the tenant-scoped paths that carry a
 *     policy overlay; everything else is `{ kind: 'other' }` (forwarded).
 */
import { describe, it, expect } from 'bun:test';
import { canonicalizeOcPath, classifyOcRoute } from './oc-path.ts';

describe('canonicalizeOcPath', () => {
  it('passes a normal path through decoded', () => {
    expect(canonicalizeOcPath('/session/ses_1/message')).toEqual({ ok: true, path: '/session/ses_1/message' });
  });

  it('decodes percent-encoded segments (no structural change)', () => {
    expect(canonicalizeOcPath('/session/ses%5Fa')).toEqual({ ok: true, path: '/session/ses_a' });
  });

  it('refuses `..` traversal (literal)', () => {
    expect(canonicalizeOcPath('/session/../secret')).toEqual({ ok: false, reason: 'non_canonical_path' });
  });

  it('refuses `..` traversal smuggled via percent-encoding', () => {
    expect(canonicalizeOcPath('/session/%2e%2e/secret')).toEqual({ ok: false, reason: 'non_canonical_path' });
  });

  it('refuses an invalid percent-encoding', () => {
    expect(canonicalizeOcPath('/session/%zz')).toEqual({ ok: false, reason: 'invalid_encoding' });
  });

  it('an encoded slash decodes to a real separator (no sub-path smuggling)', () => {
    // %2f decodes to '/', so the classifier sees the extra segment rather than a
    // literal id containing a slash — the ownership check binds the real segment.
    expect(canonicalizeOcPath('/session/abc%2fshell')).toEqual({ ok: true, path: '/session/abc/shell' });
  });
});

describe('classifyOcRoute', () => {
  it('POST /session → session-create', () => {
    expect(classifyOcRoute('POST', '/session')).toEqual({ kind: 'session-create' });
  });

  it('GET /session → session-list', () => {
    expect(classifyOcRoute('GET', '/session')).toEqual({ kind: 'session-list' });
  });

  it('GET /event → event', () => {
    expect(classifyOcRoute('GET', '/event')).toEqual({ kind: 'event' });
  });

  it('POST /session/{id}/message → session-scoped moderated write', () => {
    expect(classifyOcRoute('POST', '/session/ses_1/message')).toEqual({
      kind: 'session-scoped',
      sessionId: 'ses_1',
      moderatedWrite: true,
      sessionDelete: false,
    });
  });

  it('POST /session/{id}/prompt_async → session-scoped moderated write', () => {
    expect(classifyOcRoute('POST', '/session/ses_1/prompt_async')).toMatchObject({
      kind: 'session-scoped',
      moderatedWrite: true,
    });
  });

  it('GET /session/{id}/message (history) → session-scoped, NOT moderated', () => {
    expect(classifyOcRoute('GET', '/session/ses_1/message')).toEqual({
      kind: 'session-scoped',
      sessionId: 'ses_1',
      moderatedWrite: false,
      sessionDelete: false,
    });
  });

  it('DELETE /session/{id} → session-scoped delete', () => {
    expect(classifyOcRoute('DELETE', '/session/ses_1')).toEqual({
      kind: 'session-scoped',
      sessionId: 'ses_1',
      moderatedWrite: false,
      sessionDelete: true,
    });
  });

  it('POST /permission/{id}/reply → permission-reply', () => {
    expect(classifyOcRoute('POST', '/permission/per_1/reply')).toEqual({ kind: 'permission-reply', requestId: 'per_1' });
  });

  it('POST /question/{id}/reject → question-reply', () => {
    expect(classifyOcRoute('POST', '/question/que_1/reject')).toEqual({ kind: 'question-reply', requestId: 'que_1' });
  });

  it('a non-tenant endpoint is other (forwarded transparently)', () => {
    expect(classifyOcRoute('GET', '/provider')).toEqual({ kind: 'other' });
    expect(classifyOcRoute('GET', '/doc')).toEqual({ kind: 'other' });
    expect(classifyOcRoute('POST', '/session/ses_1/shell')).toMatchObject({ kind: 'session-scoped', sessionId: 'ses_1' });
  });
});
