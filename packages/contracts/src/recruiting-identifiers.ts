import * as z from "zod";
import { Id } from "./ids.js";

export const RecruitingId = Id.refine((value) => value.trim().length > 0, "ID must not be blank");

export const VerdictSchema = z.enum(["met", "unmet", "unknown"]);
export type Verdict = z.infer<typeof VerdictSchema>;
