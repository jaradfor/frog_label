const MAX_BODY_BYTES = 64 * 1024; // 64KB per request
const MAX_EVENTS_PER_BATCH = 200;
const EVENT_NAME_RE = /^[a-zA-Z0-9_]{1,64}$/;
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/; // loose UUID-shaped check, not a strict parser
const EXPECTED_CLIENT = 'frog-label-web';

function corsHeaders(origin, allowedOrigins) {
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function json(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateBody(body) {
  if (!isPlainObject(body)) return 'body must be an object';
  if (body.client !== EXPECTED_CLIENT) return 'unrecognized client';
  if (typeof body.device_id !== 'string' || !ID_RE.test(body.device_id)) return 'invalid device_id';
  if (typeof body.session_id !== 'string' || !ID_RE.test(body.session_id)) return 'invalid session_id';
  if (!Array.isArray(body.events) || body.events.length === 0) return 'events must be a non-empty array';
  if (body.events.length > MAX_EVENTS_PER_BATCH) return 'too many events in one batch';

  for (const evt of body.events) {
    if (!isPlainObject(evt)) return 'each event must be an object';
    if (typeof evt.event !== 'string' || !EVENT_NAME_RE.test(evt.event)) return 'invalid event name';
    if (evt.task_id != null && typeof evt.task_id !== 'string') return 'invalid task_id';
    if (evt.ts != null && typeof evt.ts !== 'number') return 'invalid ts';
    if (evt.payload != null && !isPlainObject(evt.payload)) return 'payload must be an object';
  }
  return null;
}

async function handleEvents(request, env, allowedOrigins) {
  const origin = request.headers.get('Origin');
  const headers = corsHeaders(origin, allowedOrigins);

  // Origin allowlisting here is a courtesy filter for browser-originated noise,
  // not real access control — CORS is unenforceable against a direct server-to-server
  // request. This endpoint is intentionally a public write-only ingest sink (same
  // trust model as a PostHog/Sentry ingest key), so no secret gates writes.
  if (origin && !allowedOrigins.includes(origin)) {
    return json({ error: 'origin not allowed' }, 403, headers);
  }

  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: 'payload too large' }, 413, headers);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: 'payload too large' }, 413, headers);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid JSON' }, 400, headers);
  }

  const validationError = validateBody(body);
  if (validationError) {
    return json({ error: validationError }, 400, headers);
  }

  const now = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO events (device_id, session_id, task_id, event, payload, client_ts, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const batch = body.events.map((evt) =>
    stmt.bind(
      body.device_id,
      body.session_id,
      evt.task_id ?? null,
      evt.event,
      JSON.stringify(evt.payload ?? {}),
      evt.ts ?? now,
      now,
    ),
  );

  try {
    await env.DB.batch(batch);
  } catch (err) {
    console.error('D1 batch insert failed', err);
    return json({ error: 'storage failure' }, 500, headers);
  }

  return new Response(null, { status: 204, headers });
}

export default {
  async fetch(request, env) {
    const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request.headers.get('Origin'), allowedOrigins),
      });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true }, 200);
    }

    if (url.pathname === '/events' && request.method === 'POST') {
      return handleEvents(request, env, allowedOrigins);
    }

    return json({ error: 'not found' }, 404);
  },
};
