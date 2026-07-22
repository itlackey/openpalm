import { createServer } from 'node:http';

const FIXTURE_USERNAME = 'pwa-user';
const FIXTURE_PASSWORD = 'pwa-secret-password';
const EXPECTED_AUTHORIZATION = `Basic ${Buffer.from(`${FIXTURE_USERNAME}:${FIXTURE_PASSWORD}`).toString('base64')}`;

function json(response, status, body, headers) {
  response.writeHead(status, {
    ...headers,
    'content-type': 'application/json',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

export async function startOpenCodeFixture({ port, allowedOrigins }) {
  const allowedOriginSet = new Set(allowedOrigins);
  const sessions = [];
  const messages = new Map();
  const eventClients = new Set();
  let generation = 0;
  let stats = emptyStats();
  let verificationPaused = false;
  let releaseVerification = null;

  function emptyStats() {
    return {
      authorizedRequests: 0,
      rejectedAuth: 0,
      eventConnections: 0,
      eventClosed: 0,
      messagePosts: 0,
      sessionListRequests: 0,
      pendingVerificationRequests: 0,
    };
  }

  function releasePausedVerification() {
    verificationPaused = false;
    releaseVerification?.();
    releaseVerification = null;
  }

  function reset() {
    releasePausedVerification();
    generation += 1;
    for (const client of eventClients) client.response.end();
    eventClients.clear();
    sessions.splice(0);
    messages.clear();
    stats = emptyStats();
  }

  function state() {
    return {
      ...stats,
      activeEventStreams: eventClients.size,
      sessions: sessions.length,
      messages: [...messages.values()].reduce((count, rows) => count + rows.length, 0),
      sessionIds: sessions.map((session) => session.id),
    };
  }

  function seedSessions(entries) {
    sessions.splice(0);
    messages.clear();
    for (const entry of entries) {
      sessions.push({
        id: entry.id,
        title: entry.title,
        time: entry.time,
      });
      messages.set(entry.id, Array.isArray(entry.messages) ? entry.messages : []);
    }
  }

  function requireAuth(request, response, headers) {
    if (request.headers.authorization === EXPECTED_AUTHORIZATION) {
      stats.authorizedRequests += 1;
      return true;
    }
    stats.rejectedAuth += 1;
    json(response, 401, { error: 'unauthorized' }, {
      ...headers,
      'www-authenticate': 'Basic realm="OpenCode fixture"',
    });
    return false;
  }

  function broadcast(event) {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of eventClients) {
      if (client.generation === generation && !client.response.writableEnded) {
        client.response.write(frame);
      }
    }
  }

  const server = createServer(async (request, response) => {
    const requestOrigin = request.headers.origin;
    const corsHeaders = {
      'access-control-allow-origin': allowedOriginSet.has(requestOrigin) ? requestOrigin : allowedOrigins[0],
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      vary: 'Origin',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }

    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (request.method === 'POST' && url.pathname === '/__test/reset') {
      reset();
      json(response, 200, state(), corsHeaders);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/__test/state') {
      json(response, 200, state(), corsHeaders);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/__test/sessions') {
      const body = await readJson(request);
      if (!Array.isArray(body.sessions)) {
        json(response, 400, { error: 'sessions_required' }, corsHeaders);
        return;
      }
      seedSessions(body.sessions);
      json(response, 200, state(), corsHeaders);
      return;
    }
    const fixtureSessionMatch = url.pathname.match(/^\/__test\/session\/([^/]+)$/);
    if (request.method === 'DELETE' && fixtureSessionMatch) {
      const id = decodeURIComponent(fixtureSessionMatch[1]);
      const index = sessions.findIndex((session) => session.id === id);
      if (index >= 0) sessions.splice(index, 1);
      messages.delete(id);
      json(response, 200, state(), corsHeaders);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/__test/verification/pause') {
      releasePausedVerification();
      verificationPaused = true;
      json(response, 200, state(), corsHeaders);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/__test/verification/release') {
      releasePausedVerification();
      json(response, 200, state(), corsHeaders);
      return;
    }

    if (!requireAuth(request, response, corsHeaders)) return;
    let apiPath = url.pathname.startsWith('/secondary')
      ? url.pathname.slice('/secondary'.length) || '/'
      : url.pathname;
    if (apiPath === '/oc') apiPath = '/';
    else if (apiPath.startsWith('/oc/')) apiPath = apiPath.slice('/oc'.length);
    if (request.method === 'GET' && apiPath === '/') {
      json(response, 200, { fixture: 'openpalm-pwa-opencode' }, corsHeaders);
      return;
    }
    if (request.method === 'GET' && apiPath === '/event') {
      const client = { response, generation };
      eventClients.add(client);
      stats.eventConnections += 1;
      response.writeHead(200, {
        ...corsHeaders,
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      });
      response.flushHeaders();
      response.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      response.on('close', () => {
        eventClients.delete(client);
        if (client.generation === generation) stats.eventClosed += 1;
      });
      return;
    }
    if (request.method === 'GET' && apiPath === '/session') {
      stats.sessionListRequests += 1;
      if (verificationPaused) {
        const requestStats = stats;
        requestStats.pendingVerificationRequests += 1;
        await new Promise((resolve) => {
          releaseVerification = resolve;
        });
        requestStats.pendingVerificationRequests -= 1;
      }
      json(response, 200, sessions, corsHeaders);
      return;
    }
    if (request.method === 'POST' && apiPath === '/session') {
      const id = `fixture-session-${sessions.length + 1}`;
      const now = Date.now();
      sessions.unshift({ id, title: 'Fixture conversation', time: { created: now, updated: now } });
      messages.set(id, []);
      json(response, 200, { id }, corsHeaders);
      return;
    }

    const messageMatch = apiPath.match(/^\/session\/([^/]+)\/message$/);
    if (request.method === 'GET' && messageMatch) {
      json(response, 200, messages.get(messageMatch[1]) ?? [], corsHeaders);
      return;
    }
    if (request.method === 'POST' && messageMatch) {
      stats.messagePosts += 1;
      const sessionId = messageMatch[1];
      const body = await readJson(request);
      const text = Array.isArray(body.parts)
        ? body.parts
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('')
        : '';
      const reply = `Fixture reply: ${text}`;
      const rows = messages.get(sessionId) ?? [];
      rows.push(
        {
          info: { id: `user-${rows.length + 1}`, role: 'user', time: { created: Date.now() } },
          parts: [{ type: 'text', text }],
        },
        {
          info: { id: `assistant-${rows.length + 2}`, role: 'assistant', time: { created: Date.now() } },
          parts: [{ type: 'text', text: reply }],
        },
      );
      messages.set(sessionId, rows);
      json(response, 200, { parts: [{ type: 'text', text: reply }] }, corsHeaders);
      queueMicrotask(() => {
        broadcast({
          type: 'message.part.delta',
          properties: { sessionID: sessionId, partID: 'fixture-text', field: 'text', delta: reply },
        });
        broadcast({ type: 'session.idle', properties: { sessionID: sessionId } });
      });
      return;
    }

    json(response, 404, { error: 'not_found' }, corsHeaders);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
