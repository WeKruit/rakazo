// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import type { RecruitingCalibrationRound } from "@rakazo/contracts";

vi.mock("../../lib/rpc", () => ({ rpc: {} }));

import { CalibrationRoundView } from "./CalibrationRound";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement | undefined;
afterEach(() => container?.remove());

const round = (approvedAt: string | null = null): RecruitingCalibrationRound => ({
  round: 2,
  createdAt: "2026-10-23T16:00:00.000Z",
  approvedAt,
  candidates: Array.from({ length: 10 }, (_, index) => ({
    candidateKey: `person-${index}`,
    name: `Person ${index}`,
    title: "Warehouse operations manager",
    company: `Company ${index}`,
    location: null,
    linkedinUrl: `https://www.linkedin.com/in/person-${index}`,
  })),
});

async function mount(value: RecruitingCalibrationRound) {
  const onSendFeedback = vi.fn(async (_text: string) => true);
  const onApprove = vi.fn(async (_text: string) => true);
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <CalibrationRoundView round={value} onSendFeedback={onSendFeedback} onApprove={onApprove} />,
    ),
  );
  return { onSendFeedback, onApprove };
}

const button = (label: string) =>
  [...container!.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  )!;

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

it("sends feedback on a few people and the direction as one message", async () => {
  const { onSendFeedback } = await mount(round());
  expect(container!.textContent).toContain("Round 2 · 10 people");
  const send = button("Send feedback");
  expect(send.disabled).toBe(true);
  await act(async () => button("Good example: Person 1").click());
  await act(async () => button("Not a fit: Person 4").click());
  await act(async () => {
    type(
      container!.querySelector<HTMLInputElement>('input[aria-label="Reason: Person 4"]')!,
      "Too retail",
    );
  });
  await act(async () => {
    type(container!.querySelector("textarea")!, "More cross-dock sites");
  });
  expect(send.disabled).toBe(false);
  await act(async () => send.click());
  expect(onSendFeedback).toHaveBeenCalledTimes(1);
  expect(onSendFeedback.mock.calls[0]![0]).toBe(
    "Round 2 feedback:\n👍 Person 1\n👎 Person 4: Too retail\nOverall: More cross-dock sites",
  );
  expect(container!.textContent).toContain("Feedback sent");
});

it("accepts the round with the recruiter's words", async () => {
  const { onApprove, onSendFeedback } = await mount(round());
  await act(async () => button("Looks good, find more").click());
  expect(onApprove).toHaveBeenCalledWith("Round 2 looks good. Start finding more people.");
  expect(onSendFeedback).not.toHaveBeenCalled();
});

it("shows an accepted round without feedback controls", async () => {
  await mount(round("2026-10-23T17:00:00.000Z"));
  expect(container!.textContent).toContain("Accepted. Finding more people.");
  expect(container!.querySelector("form")).toBeNull();
  expect(container!.querySelectorAll("a")).toHaveLength(10);
});
