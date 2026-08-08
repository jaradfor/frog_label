import { getDeviceId, sessionId } from './identity';

const CLIENT_NAME = 'frog-label-web';
const DEFAULT_ENDPOINT = 'https://frog-label-telemetry.e4e-telemetry.workers.dev/events';
const ENDPOINT = import.meta.env.VITE_TELEMETRY_URL || DEFAULT_ENDPOINT;

// Only send from real deployments by default, so local `npm run dev` sessions
// don't pollute tester analytics. Set VITE_TELEMETRY_FORCE=true to test the
// pipeline itself from a local build.
const ENABLED = import.meta.env.PROD || import.meta.env.VITE_TELEMETRY_FORCE === 'true';

const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFER_SIZE = 20;

let buffer = [];
let flushTimer = null;
let currentTaskId = null;

function send(events) {
  if (events.length === 0) return;

  const body = JSON.stringify({
    client: CLIENT_NAME,
    device_id: getDeviceId(),
    session_id: sessionId,
    events,
  });

  // text/plain keeps this a CORS "simple request" (no preflight), which also
  // means it's compatible with sendBeacon's Blob requirement.
  const blob = new Blob([body], { type: 'text/plain' });
  const beaconSent =
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function' &&
    navigator.sendBeacon(ENDPOINT, blob);

  if (!beaconSent) {
    fetch(ENDPOINT, {
      method: 'POST',
      body,
      keepalive: true,
      headers: { 'Content-Type': 'text/plain' },
    }).catch(() => {
      // Best-effort — telemetry must never surface an error to the tester.
    });
  }
}

function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;
  const toSend = buffer;
  buffer = [];
  send(toSend);
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}

/** Associates subsequent track() calls with a task until changed/cleared. */
export function setTelemetryTaskId(taskId) {
  currentTaskId = taskId ?? null;
}

export function track(event, payload = {}) {
  if (!ENABLED) return;
  buffer.push({ event, ts: Date.now(), task_id: currentTaskId, payload });
  if (buffer.length >= MAX_BUFFER_SIZE) {
    flush();
  } else {
    scheduleFlush();
  }
}
