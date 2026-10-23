import { ListRecruitingCandidatesInput } from "@rakazo/contracts";

export type Panel =
  | "computer"
  | "settings"
  | "routine"
  | "create"
  | "create-group"
  | "group-settings"
  | "recruiting"
  | null;
export type RightPanelState = { panel: Panel; routineId?: string };

/** Panels that are safe to remember across reloads. Create flows stay ephemeral. */
const durablePanels: readonly Panel[] = [
  "computer",
  "settings",
  "routine",
  "group-settings",
  "recruiting",
  null,
];

export function rightPanelStorageKey(
  userId: string,
  spaceId: string,
  kind: "bot" | "group",
  targetId: string,
): string {
  return `rakazo:right-panel-state:${userId}:${spaceId}:${kind}:${targetId}`;
}

export function readRightPanelState(key: string): RightPanelState {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      !value ||
      typeof value !== "object" ||
      !("panel" in value) ||
      !durablePanels.includes(value.panel as Panel)
    )
      return { panel: null };
    return {
      panel: value.panel as Panel,
      ...(value.panel === "routine" &&
      "routineId" in value &&
      typeof value.routineId === "string" &&
      value.routineId
        ? { routineId: value.routineId }
        : {}),
    };
  } catch {
    return { panel: null };
  }
}

export function writeRightPanelState(key: string, panel: Panel, routineId?: string) {
  // Keep the last durable preference while create/create-group is open.
  if (panel === "create" || panel === "create-group") return;
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ panel, ...(panel === "routine" && routineId ? { routineId } : {}) }),
    );
  } catch {
    // Restricted storage must not prevent opening or closing the panel.
  }
}

const candidateFiltersSchema = ListRecruitingCandidatesInput.omit({
  roleId: true,
  cursor: true,
  limit: true,
});
export type RecruitingPanelState = {
  tab: "role" | "dashboard" | "evidence" | "missing" | "memory" | "activity";
  candidateView: "cards" | "table";
  filters: Omit<ListRecruitingCandidatesInput, "roleId" | "cursor" | "limit">;
  pageCount: number;
  selectedCandidateKey: string | null;
  detailOpen: boolean;
};

export function readRecruitingPanelState(key: string | null): RecruitingPanelState {
  const empty: RecruitingPanelState = {
    tab: "role",
    candidateView: "table",
    filters: { sort: "score" },
    pageCount: 1,
    selectedCandidateKey: null,
    detailOpen: false,
  };
  if (!key) return empty;
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    const filters = candidateFiltersSchema.safeParse(value?.filters);
    if (
      !value ||
      !["role", "dashboard", "evidence", "missing", "memory", "activity"].includes(value.tab) ||
      !["cards", "table"].includes(value.candidateView) ||
      !filters.success ||
      !Number.isSafeInteger(value.pageCount) ||
      value.pageCount < 1 ||
      (value.selectedCandidateKey !== null &&
        !ListRecruitingCandidatesInput.shape.roleId.safeParse(value.selectedCandidateKey)
          .success) ||
      typeof value.detailOpen !== "boolean"
    )
      return empty;
    return {
      tab: value.tab,
      candidateView: value.candidateView,
      filters: { sort: "score", ...filters.data },
      pageCount: value.pageCount,
      selectedCandidateKey: value.selectedCandidateKey,
      detailOpen: value.detailOpen,
    };
  } catch {
    return empty;
  }
}

export function writeRecruitingPanelState(key: string, state: RecruitingPanelState) {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Restricted storage must not prevent using the recruiting list.
  }
}
