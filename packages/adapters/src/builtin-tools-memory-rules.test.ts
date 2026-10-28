import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";

describe("memory tool rules", () => {
  it.each(["remember", "save_shared_memory", "save_memory"])(
    "%s keeps a topic-only forgotten list",
    (name) => {
      const tool = builtinAgentTools.find((candidate) => candidate.name === name);
      expect(tool?.description).toContain("one home per fact");
      expect(tool?.description).toContain(
        'add the topic and date only (never the content) under a "## Forgotten" heading',
      );
      expect(tool?.description).toContain("never bring that topic up again");
    },
  );
});
