-- Mobile push tokens move from files on the container volume into the database, so more than one
-- container can register and deliver them. Devices register again on app start; no copy needed.
CREATE TABLE "push_tokens" (
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "sessionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens"("token");

ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
