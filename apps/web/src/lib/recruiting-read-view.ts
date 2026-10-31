import type { ReadRecruitingViewInput } from "@rakazo/contracts";
import type { rpc } from "./rpc";

type ResearchInput = Extract<ReadRecruitingViewInput, { kind: "research" }>;
type View = Awaited<ReturnType<typeof rpc.recruiting.readView>>;

/** No partial result escapes when any page loses its fresh role/revision proof. */
export async function readResearchViewPages(
  input: Omit<ResearchInput, "kind" | "offset">,
  read: (input: ResearchInput, options?: { signal?: AbortSignal }) => Promise<View>,
  signal?: AbortSignal,
) {
  const gathered: NonNullable<Extract<View, { kind: "research" }>["data"]> = {
    tasks: [],
    actions: [],
    observations: [],
  };
  for (let offset = 0; ; offset += 200) {
    signal?.throwIfAborted();
    const view = await read({ ...input, kind: "research", offset }, { signal });
    signal?.throwIfAborted();
    if (view.kind !== "research") throw new Error("Recruiting read kind changed");
    if (
      !view.data ||
      view.workspace?.role.id !== input.roleId ||
      view.workspace.revision.id !== input.roleRevisionId
    ) {
      return { ...view, data: null };
    }
    gathered.tasks.push(...view.data.tasks);
    gathered.actions.push(...view.data.actions);
    gathered.observations.push(...view.data.observations);
    if (
      [view.data.tasks, view.data.actions, view.data.observations].every(
        (rows) => rows.length < 200,
      )
    ) {
      return { ...view, data: gathered };
    }
  }
}

const views = [
  "brief",
  "feedback",
  "shortlist",
  "contacts",
  "sequence",
  "inbox",
  "interview",
  "tasks",
  "routines",
] as const;
type AccountView = (typeof views)[number];
export function isAccountRecruitingView(value: string | null): value is AccountView {
  return views.some((view) => view === value);
}
