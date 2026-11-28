import type { AgentModelOAuthCredential, AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findDefaultModelCredential, findModelCredential } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cloudflareGatewayProviderEnv } from "../cloudflare-ai-gateway.js";
import { resolveDeploymentModel } from "../deployment-model.js";
import type { ExecutorDeps } from "../executor.js";
import {
  isCatalogModelChoice,
  isDeploymentModelChoice,
  selectConfiguredModel,
  UnavailableModelForAuthError,
  validateConnectedModelChoice,
  validateModelAuthAvailability,
} from "../model-selection.js";
import { modelIdSupportsImages } from "../model-vision.js";
import { codexLiveListsModel } from "../pi-codex-catalog.js";
import {
  parseModelSecret,
  RetiredModelCredentialError,
  resolveModelAuth,
  secretValuesToRedact,
  serializeModelSecret,
  storedModelOAuthModifier,
  withStoredModelCredential,
} from "../pi-oauth.js";
import type { AccountModelRequest } from "./harness-models.js";

// An agent's model and its backups, with their keys. Moved from executor.ts so a run and a
// session resolve the same model for a bot.

export type ModelDeps = Pick<
  ExecutorDeps,
  "prisma" | "secretStore" | "codexCatalog" | "deploymentModelKey" | "deploymentModelConfigured"
>;

export const MISSING_MODEL_MESSAGE = "Connect a model in Settings before running bots.";

export function runtimeFallbackModel(runtime: AgentRuntime) {
  return runtime.describe().capabilities.scripted ? { provider: "scripted", id: "scripted" } : null;
}

/**
 * The deployment key is a bearer credential for exactly one vendor, so it is handed out
 * only when the provider that won the resolution above is that vendor. A provider named
 * by deployment settings or a bot override gets no key rather than another vendor's.
 */
function deploymentKeyFor(deps: ModelDeps, provider: string): string | undefined {
  if (!deps.deploymentModelKey) return undefined;
  return provider === resolveDeploymentModel().provider ? deps.deploymentModelKey : undefined;
}

/**
 * A run can afford a longer catalog wait than the models.list read bound — the
 * account answer decides whether a statically excluded model is allowed at all.
 * Still bounded well under the fetch's own abort timeout.
 */
const CODEX_LIVE_RUN_WAIT_MS = 8_000;

export async function resolveModelKey(
  deps: ModelDeps,
  userId: string,
  spaceId: string,
  credential: {
    id: string;
    secretId: string;
    provider: string;
    defaultModel?: string | null;
    supportsImages?: boolean;
  } | null,
  provider: string,
  modelId: string,
  registerSecrets?: (values: string[]) => void,
  requireStoredSecret = false,
): Promise<{
  apiKey?: string;
  accountId?: string;
  gatewayId?: string;
  baseUrl?: string;
  cacheCapabilities?: AgentRunRequest["model"]["cacheCapabilities"];
  contextWindow?: number;
  reasoning?: boolean;
  maxTokens?: number;
  thinkingLevel?: AgentRunRequest["model"]["thinkingLevel"];
  acceptsImages?: boolean;
  maxImagesPerPrompt?: number;
  oauth?: AgentModelOAuthCredential;
  modifyOAuth?: NonNullable<AgentRunRequest["model"]["oauth"]>["modify"];
  redact: string[];
}> {
  if (credential) {
    const result = await withStoredModelCredential(
      deps.prisma,
      deps.secretStore,
      { userId, spaceId },
      credential,
      async (plaintext, { persist, retire, signal }) => {
        registerSecrets?.(secretValuesToRedact(parseModelSecret(plaintext)));
        const unavailable = validateModelAuthAvailability(provider, modelId, plaintext);
        if (unavailable && !deps.codexCatalog) throw new UnavailableModelForAuthError(unavailable);
        const resolved = await resolveModelAuth(plaintext, credential.provider, {
          persist,
          retire,
          signal,
        });
        const oauth = resolved.secret.kind === "oauth" ? resolved.secret.credential : undefined;
        const baseUrl =
          resolved.secret.kind === "openai_compatible" ? resolved.secret.baseUrl : undefined;
        const acceptsImages =
          credential.provider === OPENAI_COMPATIBLE_PROVIDER_ID &&
          resolved.secret.kind === "openai_compatible" &&
          (modelIdSupportsImages(resolved.secret.visionModelIds, modelId) ||
            // Legacy secrets have no per-model list, so keep their existing
            // capability scoped to the model saved in the space preference.
            (resolved.secret.visionModelIds === undefined &&
              credential.supportsImages === true &&
              credential.defaultModel?.trim() === modelId.trim()));
        const accountId =
          resolved.secret.kind === "api_key" ? resolved.secret.accountId : undefined;
        const gatewayId =
          resolved.secret.kind === "api_key" ? resolved.secret.gatewayId : undefined;
        cloudflareGatewayProviderEnv({ provider, accountId, gatewayId });
        return {
          secret: resolved.secret,
          apiKey: resolved.apiKey,
          accountId,
          gatewayId,
          baseUrl,
          cacheCapabilities:
            resolved.secret.kind !== "oauth" ? resolved.secret.cacheCapabilities : undefined,
          contextWindow:
            resolved.secret.kind !== "oauth" ? resolved.secret.contextWindow : undefined,
          reasoning:
            resolved.secret.kind === "openai_compatible" ? resolved.secret.reasoning : undefined,
          maxTokens: resolved.secret.maxTokens,
          thinkingLevel:
            resolved.secret.kind === "openai_compatible"
              ? resolved.secret.thinkingLevel
              : undefined,
          acceptsImages,
          maxImagesPerPrompt:
            resolved.secret.kind === "openai_compatible"
              ? resolved.secret.maxImagesPerPrompt
              : undefined,
          oauth,
          modifyOAuth: oauth
            ? storedModelOAuthModifier(
                deps.prisma,
                deps.secretStore,
                { userId, spaceId },
                credential,
              )
            : undefined,
          redact: [...secretValuesToRedact(resolved.secret), resolved.apiKey].filter(
            (value): value is string => Boolean(value),
          ),
        };
      },
    );
    if (!result)
      throw new RetiredModelCredentialError(
        "Model connection is no longer available. Connect it again.",
      );
    const authError = validateModelAuthAvailability(
      provider,
      modelId,
      serializeModelSecret(result.secret),
    );
    if (
      authError &&
      !(
        deps.codexCatalog &&
        result.secret.kind === "oauth" &&
        (await codexLiveListsModel(deps.codexCatalog, userId, result.secret, modelId, {
          waitMs: CODEX_LIVE_RUN_WAIT_MS,
        }))
      )
    )
      throw new UnavailableModelForAuthError(authError);
    return result;
  }
  if (requireStoredSecret) throw new Error("Backup model credential is no longer available");
  cloudflareGatewayProviderEnv({ provider });
  return { apiKey: deploymentKeyFor(deps, provider), redact: [] };
}

export function runModelFromResolved(
  provider: string,
  id: string,
  resolved: Awaited<ReturnType<typeof resolveModelKey>>,
  thinkingLevel: AgentRunRequest["model"]["thinkingLevel"] | undefined,
): AgentRunRequest["model"] {
  return {
    provider,
    id,
    apiKey: resolved.oauth ? undefined : resolved.apiKey,
    ...cloudflareRunFields(resolved),
    baseUrl: resolved.baseUrl,
    cacheCapabilities: resolved.cacheCapabilities,
    contextWindow: resolved.contextWindow,
    reasoning: resolved.reasoning,
    maxTokens: resolved.maxTokens,
    acceptsImages: resolved.acceptsImages,
    maxImagesPerPrompt: resolved.maxImagesPerPrompt,
    thinkingLevel: thinkingLevel ?? resolved.thinkingLevel ?? null,
    oauth: resolved.oauth
      ? {
          credential: resolved.oauth,
          modify: resolved.modifyOAuth,
        }
      : undefined,
  };
}

export function cloudflareRunFields(resolved: { accountId?: string; gatewayId?: string }): {
  accountId?: string;
  gatewayId?: string;
} {
  return {
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
    ...(resolved.gatewayId ? { gatewayId: resolved.gatewayId } : {}),
  };
}

export async function resolveConnectedModelFor(
  deps: ModelDeps,
  scope: { userId: string; spaceId: string },
  provider: string,
  modelId: string,
  registerSecrets?: (values: string[]) => void,
  requireStoredSecret = false,
): Promise<AgentRunRequest["model"]> {
  const credential = await findModelCredential(deps.prisma, scope, provider, modelId);
  const deployment = deps.deploymentModelConfigured ? resolveDeploymentModel() : null;
  const validationError = await validateConnectedModelChoice(
    deps.prisma,
    scope,
    provider,
    modelId,
    deployment,
  );
  if (validationError) throw new Error(validationError);
  if (!credential && !isDeploymentModelChoice(provider, modelId, deployment))
    throw new Error("Connect that model provider first");
  // Free-form selections must keep the preference that owns this modelId. A
  // intervening delete/change can make findModelCredential fall back to another
  // same-provider credential; reject that mismatch instead of mixing baseUrl.
  if (!isCatalogModelChoice(provider, modelId) && credential?.defaultModel !== modelId) {
    throw new Error("Unknown model for that provider");
  }
  const resolved = await resolveModelKey(
    deps,
    scope.userId,
    scope.spaceId,
    credential,
    provider,
    modelId,
    registerSecrets,
    requireStoredSecret,
  );
  return {
    provider,
    id: modelId,
    apiKey: resolved.oauth ? undefined : resolved.apiKey,
    ...cloudflareRunFields(resolved),
    baseUrl: resolved.baseUrl,
    cacheCapabilities: resolved.cacheCapabilities,
    contextWindow: resolved.contextWindow,

    reasoning: resolved.reasoning,
    maxTokens: resolved.maxTokens,
    acceptsImages: resolved.acceptsImages,
    maxImagesPerPrompt: resolved.maxImagesPerPrompt,
    thinkingLevel:
      ((credential?.defaultModel === modelId
        ? credential.thinkingLevel
        : null) as AgentRunRequest["model"]["thinkingLevel"]) ??
      resolved.thinkingLevel ??
      null,
    oauth: resolved.oauth
      ? {
          credential: resolved.oauth,
          modify: resolved.modifyOAuth,
        }
      : undefined,
  };
}

/** The account's backup models in order; none when the list cannot be read. */
export async function loadBackupModels(
  prisma: Pick<PrismaClient, "spaceBackupModel">,
  run: { id: string; userId: string; spaceId: string },
): Promise<{ provider: string; modelId: string }[]> {
  try {
    return await prisma.spaceBackupModel.findMany({
      where: { userId: run.userId, spaceId: run.spaceId },
      orderBy: { position: "asc" },
      select: { provider: true, modelId: true },
    });
  } catch (error) {
    getLogger().warn("Backup models could not be loaded", {
      runId: run.id,
      error,
    });
    return [];
  }
}

/** The bot's configured model (or the space default) with its key, as a person's turn runs it. */
export async function resolveBotModel(
  deps: ModelDeps & Pick<ExecutorDeps, "runtime">,
  scope: { userId: string; spaceId: string; botId?: string },
): Promise<AgentRunRequest["model"]> {
  const override = scope.botId
    ? await deps.prisma.bot.findFirst({
        where: {
          id: scope.botId,
          userId: scope.userId,
          spaceId: scope.spaceId,
        },
        select: { modelProvider: true, modelId: true, thinkingLevel: true },
      })
    : null;
  const hasOverride = Boolean(override?.modelProvider && override.modelId);
  const [overrideCredential, defaultCredential, settings] = await Promise.all([
    hasOverride
      ? findModelCredential(deps.prisma, scope, override!.modelProvider!, override!.modelId)
      : Promise.resolve(null),
    findDefaultModelCredential(deps.prisma, scope),
    deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
    }),
  ]);
  const selected = selectConfiguredModel({
    override,
    overrideCredential,
    defaultCredential,
    settings,
    deployment: deps.deploymentModelConfigured ? resolveDeploymentModel() : null,
  });
  const { credential, thinkingLevel } = selected;
  let { provider, id } = selected;
  if (!provider || !id) {
    const runtimeFallback = runtimeFallbackModel(deps.runtime);
    provider ??= runtimeFallback?.provider;
    id ??= runtimeFallback?.id ?? null;
  }
  if (!provider || !id) throw new Error(MISSING_MODEL_MESSAGE);
  // The key is resolved for the provider that won above, not before it is known.
  const resolved = await resolveModelKey(
    deps,
    scope.userId,
    scope.spaceId,
    credential,
    provider,
    id,
  );
  return {
    provider,
    id,
    apiKey: resolved.oauth ? undefined : resolved.apiKey,
    ...cloudflareRunFields(resolved),
    baseUrl: resolved.baseUrl,
    cacheCapabilities: resolved.cacheCapabilities,
    contextWindow: resolved.contextWindow,

    reasoning: resolved.reasoning,
    maxTokens: resolved.maxTokens,
    acceptsImages: resolved.acceptsImages,
    maxImagesPerPrompt: resolved.maxImagesPerPrompt,
    thinkingLevel: thinkingLevel ?? resolved.thinkingLevel ?? null,
    oauth: resolved.oauth
      ? {
          credential: resolved.oauth,
          modify: resolved.modifyOAuth,
        }
      : undefined,
  };
}

/** Resolves a backup the account selected; the configured model is reused as already resolved. */
export function backupModelResolver(
  deps: ModelDeps,
  input: {
    scope: { userId: string; spaceId: string };
    /** JSON [provider, modelId] keys of the backups this turn may use. */
    selected: ReadonlySet<string>;
    configured?: { key: string; model: AgentRunRequest["model"] };
    registerSecrets?: (values: string[]) => void;
  },
): AgentRunRequest["resolveFallbackModel"] {
  if (!input.selected.size) return undefined;
  return async (provider, modelId) => {
    const key = JSON.stringify([provider, modelId]);
    if (!input.selected.has(key)) throw new Error("Backup model is not selected");
    if (input.configured && key === input.configured.key) return input.configured.model;
    return resolveConnectedModelFor(
      deps,
      input.scope,
      provider,
      modelId,
      input.registerSecrets,
      true,
    );
  };
}

/**
 * The input `createAccountModels` takes for a bot: its configured model and the account's backup
 * chain, resolved the way continueRun resolves a person's turn on the configured model.
 */
export async function loadSessionModelRequest(
  deps: ModelDeps & Pick<ExecutorDeps, "runtime">,
  key: { spaceId: string; userId: string; botId: string },
  registerSecrets?: (values: string[]) => void,
): Promise<Omit<AccountModelRequest, "tools">> {
  const model = await resolveBotModel(deps, key);
  const configuredKey = JSON.stringify([model.provider, model.id]);
  const backups = (await loadBackupModels(deps.prisma, { id: key.botId, ...key })).filter(
    (candidate) => JSON.stringify([candidate.provider, candidate.modelId]) !== configuredKey,
  );
  const selected = new Set(
    backups.map((candidate) => JSON.stringify([candidate.provider, candidate.modelId])),
  );
  const resolveFallbackModel = backupModelResolver(deps, {
    scope: key,
    selected,
    registerSecrets,
  });
  return {
    model,
    fallbackModels: backups.map(({ provider, modelId }) => ({ provider, id: modelId })),
    ...(resolveFallbackModel ? { resolveFallbackModel } : {}),
  };
}
