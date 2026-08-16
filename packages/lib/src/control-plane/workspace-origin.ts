/**
 * Where OpenCode's web UI is reachable from a browser — the ONE answer, and the
 * one place a remote-access provider gets to influence it.
 *
 * ## Why this is a provider's business at all
 *
 * OpenCode's web UI is a SPA compiled for an origin ROOT: it resolves its
 * assets and its API against `location.origin`, and it navigates itself to `/`
 * if served anywhere else. It therefore cannot live on a path of OpenPalm's own
 * origin — measured, not assumed — so it needs an origin of its own, and
 * something has to make that origin reachable by the browser.
 *
 * For a LAN or desktop install that is a published port and OpenPalm can work
 * it out. For every REMOTE deployment it is a property of the thing doing the
 * fronting: Tailscale serves a second port on the tailnet, Caddy answers a
 * second site block, and whatever `remote-providers.ts` gains next will have
 * its own answer again. None of that is knowable here, and hard-coding a port
 * is exactly how the first attempt came to work on a LAN and fail behind a
 * reverse proxy.
 *
 * So the provider declares it. One field, beside the `services`, `envKeys` and
 * `secrets` a provider already declares — a provider that adds remote access
 * says where the workspace surfaces, or says nothing and gets the default.
 *
 * ## The two shapes, kept honest
 *
 * A declared origin is ABSOLUTE, because the declarer knows the public name:
 * `https://openpalm.example:3820`. The default is a PORT, because only the
 * browser knows which host it typed — the server cannot tell a LAN IP from a
 * tailnet name from a reverse-proxied domain. These are genuinely different
 * facts and the type says so rather than smuggling one through the other.
 */

/** A workspace address, or the ingredients for the browser to compose one. */
export type WorkspaceAdvertisement =
  /** A public origin someone authoritative named. Used verbatim. */
  | { kind: "absolute"; origin: string }
  /** Same host the browser is on, this port. The only thing derivable server-side. */
  | { kind: "port"; port: number };

/** The env key an operator (or a provider's apply step) writes. */
export const WORKSPACE_ORIGIN_ENV = "OP_WORKSPACE_ORIGIN";

/**
 * Validate an operator-supplied workspace origin.
 *
 * Must be an absolute http(s) origin and nothing more — a path, query, or
 * userinfo would be silently dropped when the browser resolves the SPA's
 * root-absolute requests against it, which is the failure mode this whole file
 * exists to avoid. Returns null for anything unusable so the caller falls back
 * to the derivable default rather than framing a broken address.
 */
export function parseWorkspaceOrigin(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  // A workspace origin is an ORIGIN. Anything past it cannot survive the SPA's
  // root-absolute resolution, so accepting it would be accepting a lie.
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}
