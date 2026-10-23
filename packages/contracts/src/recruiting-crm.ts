import * as z from "zod";
import { Id } from "./ids.js";

const NativeId = Id.refine((value) => value.trim().length > 0, "ID must not be blank");
const Text = z.string().refine((value) => value.trim().length > 0, "Text must not be blank");
const ProfessionalText = Text.max(1000);
const Revision = z.number().int().positive();

/** UI selection only. Current provider access and native business receipts remain authoritative. */
export const RecruitingCrmRoleReferenceSchema = z.strictObject({
  sourceId: NativeId,
  serverRevision: Revision,
  organizationId: z.uuid(),
  crmRoleId: z.uuid(),
});
export type RecruitingCrmRoleReference = z.infer<typeof RecruitingCrmRoleReferenceSchema>;

export const RecruitingCrmTargetSchema = z.strictObject({
  mcpServerId: NativeId,
  serverRevision: Revision,
  organizationId: z.uuid(),
  crmRoleId: z.uuid(),
  crmClientId: z.uuid(),
  clientLabel: Text,
  roleLabel: Text,
});
export type RecruitingCrmTarget = z.infer<typeof RecruitingCrmTargetSchema>;

export const RecruitingCrmBindingInputSchema = z.strictObject({
  operation: z.literal("bind"),
  roleId: NativeId,
  expectedRoleRevision: Revision,
  expectedBindingEffectId: NativeId.nullable(),
  crmRoleReadEffectId: NativeId,
});
export type RecruitingCrmBindingInput = z.infer<typeof RecruitingCrmBindingInputSchema>;

export const RecruitingCrmTargetToolInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("read"), roleId: NativeId }),
  RecruitingCrmBindingInputSchema,
]);
export type RecruitingCrmTargetToolInput = z.infer<typeof RecruitingCrmTargetToolInputSchema>;

export const RecruitingCrmImportInputSchema = z.strictObject({
  roleId: NativeId,
  candidateKey: NativeId,
  bindingEffectId: NativeId,
  sourceEffectId: NativeId,
  rowIndex: z.number().int().nonnegative(),
});
export type RecruitingCrmImportInput = z.infer<typeof RecruitingCrmImportInputSchema>;

/** Core validates the LinkedIn profile; contracts never depend on core. Exact facts stay unchanged. */
export const RecruitingCrmImportArgsSchema = z.strictObject({
  p_org: z.uuid(),
  p_role: z.uuid(),
  p_name: ProfessionalText,
  p_linkedin_url: Text.max(2048),
  p_source_file: Text.max(2048),
  p_title: ProfessionalText.optional(),
  p_company: ProfessionalText.optional(),
  p_location: ProfessionalText.optional(),
});
export type RecruitingCrmImportArgs = z.infer<typeof RecruitingCrmImportArgsSchema>;

export const RecruitingCrmImportReceiptSchema = z.strictObject({
  candidate_id: z.uuid(),
  source_id: z.uuid(),
  membership_id: z.uuid(),
  organization_id: z.uuid(),
  role_spec_id: z.uuid(),
  // This is the database's decoded identity; JavaScript does not fold or compare its case.
  linkedin_identity: Text.regex(/^\/in\/[^/]+$/).refine(
    (value) =>
      value.slice(4).trim().length > 0 &&
      !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    "LinkedIn identity must contain one nonblank profile segment",
  ),
  source_file: Text.max(2048),
});
export type RecruitingCrmImportReceipt = z.infer<typeof RecruitingCrmImportReceiptSchema>;

export const RecruitingCrmCandidateSyncSchema = z
  .strictObject({
    effectId: NativeId,
    target: RecruitingCrmTargetSchema,
    bindingEffectId: NativeId,
    sourceEffectId: NativeId,
    rowIndex: z.number().int().nonnegative(),
    status: z.enum(["pending", "approved", "syncing", "synced", "unknown", "denied", "stopped"]),
    receipt: RecruitingCrmImportReceiptSchema.nullable(),
  })
  .refine(
    (value) => (value.status === "synced") === (value.receipt !== null),
    "Only a synced import has a verified CRM receipt",
  );
export type RecruitingCrmCandidateSync = z.infer<typeof RecruitingCrmCandidateSyncSchema>;
