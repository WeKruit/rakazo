import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import type {
  AgentModelOAuthCredential,
  AgentRunModel,
  ModelCredentialFailedState,
  ModelCredentialRetireReason,
} from "@rakazo/adapter-kit";
import { modifyModelCredential } from "./pi-oauth.js";

export function toOAuthCredential(value: AgentModelOAuthCredential): OAuthCredential {
  return { ...value, type: "oauth" };
}

/**
 * Request-scoped Pi store for one already-authorized provider. Pi's default
 * in-memory store cannot see Rakazo's encrypted database; refreshes are
 * serialized here and published back for encryption.
 */
export class PiRuntimeCredentialStore implements CredentialStore {
  private credential?: Credential;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly providerId: string,
    credential?: Credential,
    private readonly persistOAuth?: (credential: OAuthCredential) => Promise<void>,
    private readonly retireOAuth?: (
      reason: ModelCredentialRetireReason,
      detail?: string,
      failed?: ModelCredentialFailedState,
    ) => Promise<boolean | undefined>,
    private readonly modifyOAuth?: NonNullable<AgentRunModel["oauth"]>["modify"],
  ) {
    this.credential = credential;
  }

  /**
   * The token a request resolves to right now. `modify` swaps the stored
   * credential on refresh, so callers must read this per request rather than
   * caching the credential they seeded the store with.
   */
  get accessToken(): string | undefined {
    return this.credential?.type === "oauth" ? this.credential.access : undefined;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return providerId === this.providerId ? this.credential : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return this.credential ? [{ providerId: this.providerId, type: this.credential.type }] : [];
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== this.providerId) return Promise.resolve(undefined);
    const previous = this.chain;
    const operation = previous.then(async () => {
      options?.signal?.throwIfAborted();
      this.credential = this.modifyOAuth
        ? toOAuthCredential(
            await this.modifyOAuth(async (current) => {
              const local = toOAuthCredential(current);
              const next = await fn(local);
              if (next && next.type !== "oauth")
                throw new Error("OAuth modification returned a different credential type");
              return next === local ? undefined : next;
            }, options?.signal),
          )
        : await modifyModelCredential(this.credential, fn, {
            persist: this.persistOAuth,
            retire: this.retireOAuth,
          });
      options?.signal?.throwIfAborted();
      return this.credential;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (providerId !== this.providerId) return Promise.resolve();
    const previous = this.chain;
    const operation = previous.then(() => {
      options?.signal?.throwIfAborted();
      this.credential = undefined;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }
}
