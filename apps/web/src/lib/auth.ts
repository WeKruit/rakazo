import { createAuthClient, type ReactAuthClient } from "better-auth/react";

// Space membership and selection use the authorized product RPCs. The web client
// consumes no Better Auth organization hooks or actions.
export const authClient: ReactAuthClient<{ plugins: [] }> = createAuthClient({ plugins: [] });

// A named interface keeps exported controller types portable across package layouts.
export interface AuthSessionState extends ReturnType<typeof authClient.useSession> {}
