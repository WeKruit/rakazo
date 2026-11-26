-- The structured form of a memory document the server writes and reads back (a bot's learned tool
-- fixes), kept beside its text. NULL for every existing document and for documents people write.
ALTER TABLE "memory_documents" ADD COLUMN "data" JSONB;
