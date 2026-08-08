-- Raw event log. One row per client-side telemetry event.
-- device_id: anonymous UUID persisted in the tester's browser (localStorage), stable across visits.
-- session_id: fresh UUID per page load, groups events within one visit.
-- payload: arbitrary event-specific JSON, stored as text.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT,
  event TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  client_ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_device_id ON events(device_id);
CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at);
