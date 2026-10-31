-- A conversation's event log is keyed by (threadId, seq). The id stays unique for row lookups.
-- Build the id index first so id lookups never lose an index, then promote the existing
-- (threadId, seq) unique index to the primary key instead of building a new one.
CREATE UNIQUE INDEX "events_id_key" ON "events"("id");
ALTER TABLE "events" DROP CONSTRAINT "events_pkey";
ALTER TABLE "events" ADD CONSTRAINT "events_pkey" PRIMARY KEY USING INDEX "events_threadId_seq_key";
-- The primary key covers this access path.
DROP INDEX "events_threadId_seq_idx";

-- Bumped on every message change, so a resident history copy can re-read only changed rows.
-- A constant-per-statement default adds the column without rewriting the table.
ALTER TABLE "messages" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
