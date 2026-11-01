import * as z from "zod";
import { IsoDate } from "./ids.js";

/** Everyone saved in any of the account's roles or its CRM, one row per person. */
const PersonKey = z.string().min(1).max(600);
const FilterText = z.string().trim().min(1).max(200);
const Tag = z.string().trim().min(1).max(60);

export const RecruitingContactFiltersSchema = z.strictObject({
  /** Name, title, company or location contains this. */
  query: FilterText.optional(),
  statuses: z.array(z.string().min(1).max(100)).max(30).optional(),
  /** Product role ids, or "crm:<id>" for a CRM role that is not attached to one. */
  roleIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  tags: z.array(Tag).max(30).optional(),
  location: FilterText.optional(),
  company: FilterText.optional(),
  title: FilterText.optional(),
  school: FilterText.optional(),
  skills: FilterText.optional(),
  addedAfter: IsoDate.optional(),
  addedBefore: IsoDate.optional(),
  contactedAfter: IsoDate.optional(),
  contactedBefore: IsoDate.optional(),
  repliedAfter: IsoDate.optional(),
  repliedBefore: IsoDate.optional(),
  contacted: z.boolean().optional(),
  replied: z.boolean().optional(),
  shortlisted: z.boolean().optional(),
});
export type RecruitingContactFilters = z.infer<typeof RecruitingContactFiltersSchema>;

export const RECRUITING_CONTACTS_PAGE_MAX = 100;

export const ListRecruitingContactsInput = z.strictObject({
  filters: RecruitingContactFiltersSchema.default({}),
  sort: z.enum(["name", "added", "contacted", "replied"]).default("name"),
  /** Opaque cursor from the previous page. */
  cursor: z
    .string()
    .regex(/^\d{1,7}$/)
    .optional(),
  limit: z.number().int().min(1).max(RECRUITING_CONTACTS_PAGE_MAX).default(50),
});
export type ListRecruitingContactsInput = z.input<typeof ListRecruitingContactsInput>;

export const RecruitingContactRoleSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  /** The role's conversation; null for a CRM role with no product role. */
  groupId: z.string().nullable(),
  /** The person's key inside this role, for opening their profile there. */
  candidateKey: z.string().nullable(),
  shortlisted: z.boolean(),
  /** Set for a product role: what a shortlist change needs. */
  threadId: z.string().nullable(),
  revision: z.number().int().nonnegative().nullable(),
});

export const RecruitingContactSchema = z.strictObject({
  personKey: PersonKey,
  name: z.string().nullable(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  school: z.string().nullable(),
  profileImageUrl: z.string().nullable(),
  companyLogoUrl: z.string().nullable(),
  companyWebsiteUrl: z.string().nullable(),
  schoolLogoUrl: z.string().nullable(),
  schoolWebsiteUrl: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  email: z.string().nullable(),
  status: z.string(),
  /** The key notes and logged activity use for this person. */
  noteKey: z.string(),
  roles: z.array(RecruitingContactRoleSchema),
  tags: z.array(z.string()),
  addedAt: IsoDate.nullable(),
  lastContactedAt: IsoDate.nullable(),
  lastRepliedAt: IsoDate.nullable(),
});
export type RecruitingContact = z.infer<typeof RecruitingContactSchema>;

export const ListRecruitingContactsOutput = z.strictObject({
  items: z.array(RecruitingContactSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
export type ListRecruitingContactsOutput = z.infer<typeof ListRecruitingContactsOutput>;

/** The choices the filter menus offer, from the account's own records. */
export const RecruitingContactFacetsOutput = z.strictObject({
  roles: z.array(z.strictObject({ id: z.string(), title: z.string() })),
  statuses: z.array(z.string()),
  tags: z.array(z.string()),
});

export const UpdateRecruitingContactTagsInput = z.strictObject({
  personKeys: z.array(PersonKey).min(1).max(500),
  add: z.array(Tag).max(10).default([]),
  remove: z.array(Tag).max(10).default([]),
});
