CREATE TABLE "model_oauth_sessions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "provider" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "acceptsCode" BOOLEAN NOT NULL DEFAULT false,
  "codeCiphertext" TEXT,
  "result" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "model_oauth_sessions_userId_provider_state_idx" ON "model_oauth_sessions"("userId", "provider", "state");
CREATE INDEX "model_oauth_sessions_expiresAt_idx" ON "model_oauth_sessions"("expiresAt");
