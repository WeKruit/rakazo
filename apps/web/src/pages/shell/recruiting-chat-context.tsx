import type { RecruitingChatContext, RecruitingCorrespondenceReference } from "@rakazo/contracts";
import { createContext, useContext } from "react";

/** A person selected in the workbench: display name plus an optional short record reference. */
export type RecruitingChatContact = { name: string; reference?: string };

/**
 * Lets workbench views tell the role chat what the recruiter is looking at. The next message
 * sent from the chat carries the open role's title, the selected contact and the selected inbox
 * email; the API renders them into the agent turn as bounded UI context.
 *
 * - `setSelectedContact(contact | null)`: call when a candidate or contact row is selected or
 *   cleared. Pass the visible name and, when available, the record id as `reference`.
 * - `setSelectedEmail(reference | undefined)`: call when an inbox email is selected or cleared.
 *   Selections reset when the conversation changes.
 */
export type RecruitingChatContextApi = {
  setSelectedContact: (contact: RecruitingChatContact | null) => void;
  setSelectedEmail: (reference: RecruitingCorrespondenceReference | undefined) => void;
};

const RecruitingChatContextValue = createContext<RecruitingChatContextApi>({
  setSelectedContact: () => undefined,
  setSelectedEmail: () => undefined,
});

export const RecruitingChatContextProvider = RecruitingChatContextValue.Provider;

export function useRecruitingChatContext(): RecruitingChatContextApi {
  return useContext(RecruitingChatContextValue);
}

const MAX_TEXT = 200;

function bounded(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/gu, " ").trim();
  if (!text) return undefined;
  // Never split a surrogate pair at the cut.
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT).replace(/[\uD800-\uDBFF]$/u, "") : text;
}

/** The bounded summary a chat send carries, or undefined when nothing is selected. */
export function recruitingChatContext(
  roleTitle: string | undefined,
  contact: RecruitingChatContact | null | undefined,
): RecruitingChatContext | undefined {
  const role = bounded(roleTitle);
  const name = bounded(contact?.name);
  const reference = bounded(contact?.reference);
  if (!role && !name) return undefined;
  return {
    ...(role ? { roleTitle: role } : {}),
    ...(name ? { contact: { name, ...(reference ? { reference } : {}) } } : {}),
  };
}
