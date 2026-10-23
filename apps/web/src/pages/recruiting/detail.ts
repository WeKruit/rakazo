import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { RecruitingCandidate } from "@rakazo/contracts";
import type { RecruitingTabProps } from "./shared";

/** The person a detail view shows, as the opening row already displayed it. */
export type RecruitingDetailPerson = {
  candidateId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  linkedinUrl?: string | null;
  stage?: string | null;
  contactStatus?: string | null;
  outreachStatus?: string | null;
};

export type RecruitingDetailView = "thread" | "contact" | "interview";

export type RecruitingDetailTarget = {
  view: RecruitingDetailView;
  person: RecruitingDetailPerson;
  role: Pick<RecruitingTabProps, "roleId" | "spaceId" | "conversation">;
  /** The person's Autumn search result, when they have one. */
  candidate?: RecruitingCandidate;
  /** False when the person has no CRM record, so `candidateId` reads no CRM mail or calendar. */
  crm?: boolean;
  /** What the opening list can do for this person; nothing here sends a message. */
  actions?: {
    emailDraft?: () => void;
    findEmail?: () => void;
    shortlist?: { shortlisted: boolean; disabled: boolean; set: (shortlisted: boolean) => void };
    openEvidence?: (trigger: HTMLElement) => void;
  };
  /** The neighbouring person in the opening list, to walk it without closing the panel. */
  walk?: (step: -1 | 1) => RecruitingDetailTarget | undefined;
};

/** Search parameter holding the open detail; history entries make browser Back close it. */
export const DETAIL_PARAM = "detail";

export function detailKey(target: RecruitingDetailTarget) {
  return `${target.view}.${target.person.candidateId}`;
}

export type RecruitingDetailController = {
  stack: readonly RecruitingDetailTarget[];
  current?: RecruitingDetailTarget;
  /** Opens a target on top of the stack (one history entry), keeping the page underneath. */
  open: (target: RecruitingDetailTarget) => void;
  /** Shows another target in place of the current one, without a new history entry. */
  replace: (target: RecruitingDetailTarget) => void;
  back: () => void;
  close: () => void;
};

const DetailContext = createContext<RecruitingDetailController | null>(null);
export const RecruitingDetailProvider = DetailContext.Provider;

/** The open-detail API, or null outside a workbench that hosts the detail panel. */
export function useRecruitingDetail() {
  return useContext(DetailContext);
}

/**
 * Detail panel state. Each open pushes one history entry carrying `?detail=`; Back and browser
 * Back pop it, Close unwinds every entry this panel pushed. Focus returns to the opener on close.
 * `resetKey` (the conversation) clears the stack when the page underneath changes.
 */
export function useRecruitingDetailController(resetKey?: string): RecruitingDetailController {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [stack, setStack] = useState<RecruitingDetailTarget[]>([]);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const returnFocus = useRef<HTMLElement | null>(null);
  const param = searchParams.get(DETAIL_PARAM);

  useEffect(() => {
    const current = stackRef.current;
    if (!param) {
      if (current.length) setStack([]);
      return;
    }
    let index = current.length - 1;
    while (index >= 0 && detailKey(current[index]!) !== param) index -= 1;
    if (index === -1) {
      // A reloaded or shared URL carries no row snapshot to show; drop the stale entry.
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete(DETAIL_PARAM);
          return next;
        },
        { replace: true },
      );
      if (current.length) setStack([]);
    } else if (index < current.length - 1) setStack(current.slice(0, index + 1));
  }, [param]);

  // The URL names the person on screen: a concurrent search-param write must not leave
  // `?detail=` pointing at someone the panel no longer shows.
  useEffect(() => {
    const top = stack.at(-1);
    if (!top || param === detailKey(top)) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set(DETAIL_PARAM, detailKey(top));
        return next;
      },
      { replace: true },
    );
  }, [stack]);

  const lastReset = useRef(resetKey);
  useEffect(() => {
    if (lastReset.current === resetKey) return;
    lastReset.current = resetKey;
    if (!stackRef.current.length) return;
    setStack([]);
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(DETAIL_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [resetKey]);

  const open = useCallback(
    (target: RecruitingDetailTarget) => {
      const current = stackRef.current;
      const top = current.at(-1);
      if (top && detailKey(top) === detailKey(target)) return;
      if (!current.length)
        returnFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const next = [...current, target];
      stackRef.current = next;
      setStack(next);
      setSearchParams((previous) => {
        const params = new URLSearchParams(previous);
        params.set(DETAIL_PARAM, detailKey(target));
        return params;
      });
    },
    [setSearchParams],
  );
  const replace = useCallback(
    (target: RecruitingDetailTarget) => {
      const current = stackRef.current;
      if (!current.length) return;
      const next = [...current.slice(0, -1), target];
      stackRef.current = next;
      setStack(next);
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          params.set(DETAIL_PARAM, detailKey(target));
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const back = useCallback(() => navigate(-1), [navigate]);
  const close = useCallback(() => {
    const depth = stackRef.current.length;
    if (depth) navigate(-depth);
  }, [navigate]);

  const empty = stack.length === 0;
  useEffect(() => {
    if (!empty) return;
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
  }, [empty]);

  return useMemo(
    () => ({ stack, current: stack.at(-1), open, replace, back, close }),
    [stack, open, replace, back, close],
  );
}
