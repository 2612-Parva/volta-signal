-- Volta Signal initial schema.
-- All timestamps are stored as UTC ISO-8601 strings; Halifax-local values are
-- derived at the display boundary only.

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  month_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'collecting', 'drafted', 'review', 'approved', 'sending', 'sent', 'failed', 'expired'
  )),
  recommended_variant TEXT,
  primary_cta TEXT,
  facts_pack_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  slack_channel_id TEXT,
  slack_message_ts TEXT,
  approved_variant_id TEXT,
  approved_checksum TEXT,
  approved_at TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE source_items (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  evidence_text TEXT NOT NULL,
  published_at TEXT,
  event_start_at TEXT,
  event_end_at TEXT,
  province TEXT,
  audience_json TEXT NOT NULL DEFAULT '[]',
  consent TEXT NOT NULL DEFAULT 'public' CHECK (consent IN ('public', 'approved', 'unknown')),
  confidence INTEGER NOT NULL,
  score INTEGER NOT NULL,
  score_breakdown_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE(canonical_url, content_hash)
);

CREATE INDEX source_items_recent_idx
  ON source_items(last_seen_at, published_at, event_start_at);

CREATE TABLE issue_items (
  issue_id TEXT NOT NULL REFERENCES issues(id),
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  PRIMARY KEY(issue_id, source_item_id)
);

CREATE TABLE variants (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'founder_signal', 'builder_dispatch', 'community_pulse'
  )),
  subject TEXT NOT NULL,
  preheader TEXT NOT NULL,
  structured_json TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT NOT NULL,
  checksum TEXT NOT NULL,
  quality_score INTEGER NOT NULL,
  reading_minutes INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(issue_id, kind, revision)
);

CREATE TABLE send_attempts (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  audience_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('test', 'live')),
  idempotency_key TEXT NOT NULL UNIQUE,
  approver_slack_id TEXT NOT NULL,
  provider_campaign_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'approved', 'creating', 'testing', 'sending', 'sent', 'failed'
  )),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX audit_events_issue_idx ON audit_events(issue_id, created_at);

-- One row per (month, stage). The unique key is how the 30-minute cron avoids
-- doing the same monthly work twice.
CREATE TABLE job_runs (
  job_key TEXT PRIMARY KEY,
  month_key TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  detail_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT
);

-- Aggregate campaign metrics only. Never recipient-level data.
CREATE TABLE issue_metrics (
  issue_id TEXT NOT NULL REFERENCES issues(id),
  phase TEXT NOT NULL CHECK (phase IN ('early', 'settled')),
  provider_campaign_id TEXT NOT NULL,
  emails_sent INTEGER NOT NULL DEFAULT 0,
  unique_opens INTEGER NOT NULL DEFAULT 0,
  unique_clicks INTEGER NOT NULL DEFAULT 0,
  unsubscribes INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  complaints INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL DEFAULT '{}',
  collected_at TEXT NOT NULL,
  PRIMARY KEY(issue_id, phase)
);
