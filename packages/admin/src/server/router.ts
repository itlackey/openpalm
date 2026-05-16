/**
 * Simple path-matching router for Bun.serve API server.
 * Handles static paths and parameterized segments ([name], [id], [providerId]).
 */

type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;

type Route = {
  pattern: RegExp;
  paramNames: string[];
  methods: Record<string, Handler>;
};

const routes: Route[] = [];

export function addRoute(path: string, methods: Record<string, Handler>): void {
  const paramNames: string[] = [];
  const pattern = path.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({ pattern: new RegExp(`^${pattern}$`), paramNames, methods });
}

export function dispatch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  for (const route of routes) {
    const match = path.match(route.pattern);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = match[i + 1];
    });
    const handler = route.methods[method];
    if (!handler) {
      return Promise.resolve(new Response("Method Not Allowed", { status: 405 }));
    }
    return handler(req, params);
  }
  return Promise.resolve(new Response("Not Found", { status: 404 }));
}
