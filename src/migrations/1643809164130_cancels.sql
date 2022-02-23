-- Up Migration

CREATE TABLE "cancel_events" (
  "address" BYTEA NOT NULL,
  "block" INT NOT NULL,
  "block_hash" BYTEA NOT NULL,
  "tx_hash" BYTEA NOT NULL,
  "tx_index" INT NOT NULL,
  "log_index" INT NOT NULL,
  "timestamp" INT NOT NULL,
  "order_kind" order_kind_t NOT NULL,
  "order_id" TEXT NOT NULL
);

ALTER TABLE "cancel_events"
  ADD CONSTRAINT "cancel_events_pk"
  PRIMARY KEY ("block_hash", "tx_hash", "log_index");

-- Down Migration

DROP TABLE "cancel_events";