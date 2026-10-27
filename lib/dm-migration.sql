-- DM-only persistence. The application also ensures this table idempotently.
CREATE TABLE IF NOT EXISTS dm_documents (
  owner_id TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (owner_id, doc_key)
);
