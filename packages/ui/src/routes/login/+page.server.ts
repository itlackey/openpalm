import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

/**
 * Sanitize the post-login destination to an internal path only, defeating
 * open-redirect via `?redirectTo=//evil.com` or `/\evil.com`.
 */
export function _safeRedirect(target: string | null): string {
  if (!target) return "/chat";
  // Must be a root-relative path and not a protocol-relative / backslash trick.
  if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\")) {
    return "/chat";
  }
  return target;
}

export const load: PageServerLoad = ({ locals, url }) => {
  const redirectTo = _safeRedirect(url.searchParams.get("redirectTo"));
  // Already authenticated (resolved by hooks.server.ts) → skip the login page.
  if (locals.role === "admin") {
    redirect(302, redirectTo);
  }
  return { redirectTo };
};
