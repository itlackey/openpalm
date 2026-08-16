/**
 * The query parameter a workspace ticket travels in.
 *
 * Its own module because both sides need it and neither may import the other:
 * the minting/redeeming logic is server-only (`$lib/server/workspace-ticket.ts`,
 * which is where the rationale lives), and the page that attaches it to an
 * iframe URL runs in the browser. A string literal spelled twice is exactly the
 * kind of drift that authenticates nothing and reports no error.
 */
export const WORKSPACE_TICKET_PARAM = 'op_ticket';
