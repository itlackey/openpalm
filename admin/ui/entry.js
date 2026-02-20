/**
 * Thin wrapper around adapter-node's generated server.
 * Adds /health, root redirect, and CORS before the SvelteKit handler.
 */
import http from "node:http";
import { handler } from "./build/handler.js";

const PORT = parseInt(process.env.PORT || "8100", 10);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-admin-token, x-request-id",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const server = http.createServer((req, res) => {
  // /health — outside SvelteKit's /admin base path
  if (req.url === "/health" && req.method === "GET") {
    const body = JSON.stringify({ ok: true, service: "admin", time: new Date().toISOString() });
    res.writeHead(200, { "content-type": "application/json", ...CORS });
    res.end(body);
    return;
  }

  // Root redirect
  if (req.url === "/" && req.method === "GET") {
    res.writeHead(302, { location: "/admin/", ...CORS });
    res.end();
    return;
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // Add CORS to response
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode, ...args) {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    return origWriteHead(statusCode, ...args);
  };

  // Delegate to SvelteKit
  handler(req, res);
});

server.listen(PORT, () => {
  console.log(`Listening on http://0.0.0.0:${PORT}`);
});
