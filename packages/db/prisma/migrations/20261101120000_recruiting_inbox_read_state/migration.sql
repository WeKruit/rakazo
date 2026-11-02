CREATE TABLE recruiting_inbox_initializations (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES "spaces"(id) ON DELETE CASCADE,
  initialized_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, space_id)
);
CREATE TABLE recruiting_inbox_cursors (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES "spaces"(id) ON DELETE CASCADE,
  thread_key TEXT NOT NULL,
  last_read_at TIMESTAMP(3),
  unread BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, space_id, thread_key)
);
