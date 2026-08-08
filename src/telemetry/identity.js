const DEVICE_ID_KEY = 'fl_device_id';

function newId() {
  return crypto.randomUUID();
}

// Persists across visits in this browser profile — the closest to "who is this
// tester" we can get with zero action on their part. Cleared storage, private
// browsing, or a different browser/device all produce a new one; that's an
// accepted limitation of a fully automatic, non-account-based identity.
export function getDeviceId() {
  let id;
  try {
    id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = newId();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
  } catch {
    // Storage unavailable (private mode edge cases, disabled storage) — fall
    // back to a session-only id rather than losing telemetry entirely.
    id = newId();
  }
  return id;
}

// One per page load — groups events within a single visit.
export const sessionId = newId();
