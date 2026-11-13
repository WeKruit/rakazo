import * as z from "zod";

export const IntegrationProviderIdSchema = z.enum(["composio", "pipedream"]);
export const IntegrationProviderConfigSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("composio"), apiKey: z.string().trim().min(1).max(16384) }),
  z.object({
    provider: z.literal("pipedream"),
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().trim().min(1).max(16384),
    projectId: z.string().trim().min(1).max(512),
    environment: z.enum(["production", "development"]).default("production"),
  }),
]);
export type IntegrationProviderConfig = z.infer<typeof IntegrationProviderConfigSchema>;
export type IntegrationProviderId = z.infer<typeof IntegrationProviderIdSchema>;
export const IntegrationSetupStateSchema = z.object({
  canConfigure: z.boolean(),
  needsSetup: z.boolean(),
  webUrl: z.string().url(),
  providers: z.array(z.object({ id: IntegrationProviderIdSchema, configured: z.boolean() })),
});
export type IntegrationSetupState = z.infer<typeof IntegrationSetupStateSchema>;

/** An optional yes/no judge the server asks about text (for example, whether a reply refuses). */
export const JudgeProviderConfigSchema = z.object({
  provider: z.literal("typesafe"),
  apiKey: z.string().trim().min(1).max(16384),
  /** The deployment's own required-language check: one person's row in, one verdict out. */
  languageUrl: z.string().url().optional(),
});
export type JudgeProviderConfig = z.infer<typeof JudgeProviderConfigSchema>;
/** Saving without a key keeps the saved one, so the language check can change on its own. */
export const SaveJudgeInputSchema = JudgeProviderConfigSchema.extend({
  apiKey: JudgeProviderConfigSchema.shape.apiKey.optional(),
});
export type SaveJudgeInput = z.infer<typeof SaveJudgeInputSchema>;
