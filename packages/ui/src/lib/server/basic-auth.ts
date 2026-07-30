/**
 * Basic-auth encoding for host-UI → OpenCode/guardian calls.
 *
 * The implementation lives in `@openpalm/lib` (control-plane/opencode-auth.ts)
 * because the UI's routes, the UI's OpenCode client factory, and the CLI all
 * need the identical byte sequence — a credential encoder duplicated per
 * consumer is how the 401/rotation regression family kept reappearing. This
 * module stays as the `$lib/server` import site the UI already uses.
 */
export {
  assistantAuthHeaders,
  basicAuthHeader,
  DEFAULT_OPENCODE_USERNAME,
  stripTrailingNewlines,
  type OpenCodeCredential,
} from '@openpalm/lib';
