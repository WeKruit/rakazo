import type { Api, Model, Models, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { FallbackStreamState, RuntimeModelTarget } from "../pi-runtime.js";
import {
  fallbackAwareModelStream,
  modelForCompletion,
  resolveRuntimeModel,
} from "../pi-runtime.js";

export type AccountModelRequest = Pick<
  AgentRunRequest,
  "model" | "fallbackModels" | "resolveFallbackModel" | "tools"
>;

/**
 * One account's models for a harness lane. The lane's model is the account's primary; its provider
 * is a delegate that streams through the runtime's backup chain (`fallbackAwareModelStream`), so a
 * provider outage moves to the next configured backup. Pi's own retry only repeats one model.
 */
export function createAccountModels(
  request: AccountModelRequest,
): { models: Models; model: Model<Api> } | undefined {
  const resolved = resolveRuntimeModel(request.model);
  if (!resolved.model) return undefined;
  const primary: RuntimeModelTarget = {
    config: request.model,
    models: resolved.models,
    model: modelForCompletion(resolved.model, request.model.maxTokens),
    apiKey: resolved.apiKey,
    credentials: resolved.credentials,
  };
  let active = primary;
  const state: FallbackStreamState = {
    request,
    getActive: () => active,
    signal: new AbortController().signal,
    attempted: new Set<string>(),
    nextIndex: 0,
    onSwitch: async (target) => {
      active = target;
    },
    // Every error this delegate sees comes straight from the target provider's stream.
    isProviderFailure: () => true,
    stream: (target, context, options) =>
      target.models.streamSimple(target.model, context, {
        ...options,
        apiKey: options?.apiKey ?? target.credentials?.accessToken ?? target.apiKey,
      }),
  };
  const delegate: Provider = {
    id: primary.model.provider,
    name: primary.model.provider,
    auth: { apiKey: { name: "account", resolve: async () => ({ auth: {} }) } },
    getModels: () => [primary.model],
    // The harness requests through streamSimple only; a direct stream goes to the active target.
    stream: (_model, context, options) =>
      active.models.stream(active.model, context, {
        ...options,
        apiKey: options?.apiKey ?? active.credentials?.accessToken ?? active.apiKey,
      }),
    streamSimple: (_model, context, options) => fallbackAwareModelStream(state, context, options),
  };
  const models = createModels();
  models.setProvider(delegate);
  return { models, model: primary.model };
}
