DROP INDEX IF EXISTS idx_connector_triggers_job_id;

ALTER TABLE connector_triggers RENAME TO connector_triggers_old;

CREATE TABLE connector_triggers (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('email_received', 'event_upcoming', 'linear_assignment')),
  account_id TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

INSERT INTO connector_triggers (id, job_id, kind, account_id, config, created_at)
SELECT id, job_id, kind, account_id, config, created_at FROM connector_triggers_old;

DROP TABLE connector_triggers_old;

CREATE INDEX idx_connector_triggers_job_id ON connector_triggers (job_id);

DROP INDEX IF EXISTS idx_connector_grants_token;

ALTER TABLE connector_grants RENAME TO connector_grants_old;

CREATE TABLE connector_grants (
  job_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('gmail','gcal','notion','linear')),
  server_name TEXT NOT NULL,
  token TEXT NOT NULL,
  tools TEXT NOT NULL DEFAULT '[]',
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, provider)
);

INSERT INTO connector_grants (job_id, provider, server_name, token, tools, account_id, created_at)
SELECT job_id, provider, server_name, token, tools, account_id, created_at FROM connector_grants_old;

DROP TABLE connector_grants_old;

CREATE INDEX idx_connector_grants_token ON connector_grants(token);
