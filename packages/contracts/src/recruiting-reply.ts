import * as z from "zod";
import { Id } from "./ids.js";

const NativeId = Id.refine((value) => value.trim().length > 0);
const Header = z.string().refine((value) => !/[\r\n\0]/.test(value));

export const RecruitingReplyTargetSchema = z.strictObject({
  roleId: NativeId,
  expectedRoleRevision: z.number().int().positive(),
  crmImportEffectId: NativeId,
  mcpServerId: NativeId,
  serverRevision: z.number().int().positive(),
  replyToEmailId: NativeId,
});
export type RecruitingReplyTarget = z.infer<typeof RecruitingReplyTargetSchema>;

export const RecruitingReplyInputSchema = RecruitingReplyTargetSchema.extend({
  subject: Header.refine((value) => value.trim().length > 0),
  body: z
    .strictObject({ text: z.string().optional(), html: z.string().optional() })
    .refine((body) => !!(body.text?.trim() || body.html?.trim())),
  cc: Header.optional(),
  bcc: Header.optional(),
});
export type RecruitingReplyInput = z.infer<typeof RecruitingReplyInputSchema>;
