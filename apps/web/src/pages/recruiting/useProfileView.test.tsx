// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const recordView = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({ rpc: { recruiting: { profileActivity: { recordView } } } }));

import { useProfileView } from "./useProfileView";

let root: ReturnType<typeof createRoot>;
let element: HTMLDivElement;
function Fixture({
  candidateKey = "autumn:a",
  visible = true,
  refresh = 0,
}: {
  candidateKey?: string | null;
  visible?: boolean;
  refresh?: number;
}) {
  const view = useProfileView({ spaceId: "space", roleId: "role", candidateKey, visible });
  return (
    <button type="button" data-refresh={refresh} onClick={view.retry}>
      {view.status}
    </button>
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  element = document.createElement("div");
  root = createRoot(element);
  recordView.mockResolvedValue({ id: "view", at: "2026-10-23T12:00:00Z", actorName: "Recruiter" });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const render = async (props: Parameters<typeof Fixture>[0] = {}) =>
  act(async () => root.render(<Fixture {...props} />));

it("records once across tab switches and refreshes, then a new actual open", async () => {
  await render();
  await render({ visible: false });
  await render({ refresh: 1 });
  expect(recordView).toHaveBeenCalledTimes(1);
  await render({ candidateKey: null, visible: false });
  await render();
  expect(recordView).toHaveBeenCalledTimes(2);
  expect(recordView.mock.calls[0]![0].viewId).not.toBe(recordView.mock.calls[1]![0].viewId);
});
it("keeps the same visit ID for an explicit retry after failure", async () => {
  recordView.mockRejectedValueOnce(new Error("temporary"));
  await render();
  expect(element.textContent).toBe("failed");
  await act(async () => element.querySelector("button")!.click());
  expect(element.textContent).toBe("recorded");
  expect(recordView.mock.calls[0]![0]).toEqual(recordView.mock.calls[1]![0]);
});
it("reports a pending write completion after switching to Activity", async () => {
  let finish!: () => void;
  recordView.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ id: "view" });
      }),
  );
  await render();
  await render({ visible: false });
  expect(element.textContent).toBe("recording");
  await act(async () => finish());
  expect(element.textContent).toBe("recorded");
  await render();
  expect(recordView).toHaveBeenCalledTimes(1);
});
it("retries a late failure on Activity with the original visit ID", async () => {
  let reject!: () => void;
  recordView.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = () => fail(new Error("temporary"));
      }),
  );
  await render();
  const visit = recordView.mock.calls[0]![0];
  await render({ visible: false });
  expect(element.textContent).toBe("recording");
  await act(async () => reject());
  expect(element.textContent).toBe("failed");
  await act(async () => element.querySelector("button")!.click());
  expect(recordView).toHaveBeenCalledTimes(2);
  expect(recordView.mock.calls[1]![0]).toEqual(visit);
  expect(element.textContent).toBe("recorded");
  await render({ visible: false, refresh: 1 });
  expect(recordView).toHaveBeenCalledTimes(2);
});
it("ignores an old person's delayed write result", async () => {
  let reject!: () => void;
  recordView.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = () => fail(new Error("old failure"));
      }),
  );
  await render();
  await render({ candidateKey: "autumn:b" });
  await act(async () => reject());
  expect(element.textContent).toBe("recorded");
  expect(recordView.mock.calls[1]![0].candidateKey).toBe("autumn:b");
});
it("does not record a profile that has not actually been opened", async () => {
  await render({ visible: false });
  expect(recordView).not.toHaveBeenCalled();
  await act(async () => element.querySelector("button")!.click());
  expect(recordView).not.toHaveBeenCalled();
  await render();
  expect(recordView).toHaveBeenCalledTimes(1);
});
