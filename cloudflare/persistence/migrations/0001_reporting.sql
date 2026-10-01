-- Reporting projection only. Durable Object SQLite remains the authority.
CREATE TABLE runtime_task_projection (
  scope TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
