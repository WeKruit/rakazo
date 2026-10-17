import { expect, it, vi } from "vitest";

const get = vi.hoisted(() => vi.fn().mockResolvedValue({ contentBase64: "aGVsbG8=" }));
vi.mock("./rpc", () => ({ rpc: { artifacts: { get } } }));

import { fetchArtifactBytes } from "./artifact-open";

it("preserves explicit diagnostics on file reads without adding it to ordinary reads", async () => {
  const bytes = await fetchArtifactBytes({ botId: "bot", includeDiagnostics: true }, "context");
  expect(new TextDecoder().decode(bytes)).toBe("hello");
  expect(get).toHaveBeenLastCalledWith({
    botId: "bot",
    artifactId: "context",
    includeDiagnostics: true,
  });
  await fetchArtifactBytes({ groupId: "group" }, "resume");
  expect(get).toHaveBeenLastCalledWith({ groupId: "group", artifactId: "resume" });
});
