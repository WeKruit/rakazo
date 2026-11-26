-- Run standalone: CONCURRENTLY cannot execute inside a transaction block.
-- The account Inbox finds the conversations that own mail; only those rows are indexed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS recruiting_inbox_messages_conversation_page
ON recruiting_inbox_messages(user_id, space_id, thread_id, message_at DESC, id DESC)
WHERE thread_id IS NOT NULL;
