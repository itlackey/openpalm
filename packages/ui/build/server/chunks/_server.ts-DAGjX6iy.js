import { u as unauthorizedJson } from './json-juD_ypql.js';
import './index-CoD1IJuy.js';

const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  return new Response(
    `event: ready
data: {"ok":true,"service":"admin"}

`,
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*"
      }
    }
  );
};

export { GET };
//# sourceMappingURL=_server.ts-DAGjX6iy.js.map
