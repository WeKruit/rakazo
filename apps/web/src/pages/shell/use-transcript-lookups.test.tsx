// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { useTranscriptLookups } from "./use-transcript-lookups";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => act(() => root?.unmount()));

type Lookups = ReturnType<typeof useTranscriptLookups>;
const bot = (status: string, name = "Sourcer") => ({
  id: "b1",
  name,
  color: "#123456",
  spawnKey: "sourcer",
  status,
});
const member = (status: string) => ({ botId: "b1", name: "Sourcer", color: "#123456", status });

it("keeps message lookups when only a bot's status changes", () => {
  const seen: Lookups[] = [];
  function Probe(props: { bots: ReturnType<typeof bot>[]; members: ReturnType<typeof member>[] }) {
    seen.push(useTranscriptLookups(props.bots, props.members));
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root?.render(<Probe bots={[bot("idle")]} members={[member("idle")]} />));
  act(() => root?.render(<Probe bots={[bot("running")]} members={[member("running")]} />));
  act(() => root?.render(<Probe bots={[bot("running", "Scout")]} members={[member("running")]} />));
  const [first, statusOnly, renamed] = seen;
  expect(statusOnly?.resolveBot).toBe(first?.resolveBot);
  expect(statusOnly?.resolveMemberName).toBe(first?.resolveMemberName);
  expect(renamed?.resolveBot).not.toBe(first?.resolveBot);
  expect(renamed?.resolveBot("b1")).toMatchObject({ name: "Scout", spawnKey: "sourcer" });
  expect(first?.resolveMemberName("b1")).toBe("Sourcer");
});
