import { describe, expect, it } from "vitest";
import { CANVAS_SAVE_MESSAGE, canvasDocument, canvasSaveState } from "./canvas.js";

describe("canvas documents", () => {
  it("embeds the saved data without letting it close the script", () => {
    const doc = canvasDocument("<p>app</p>", { note: "</script><b>x</b>" });
    expect(doc).toContain("\\u003c/script>");
    expect(doc.indexOf("</script>")).toBe(doc.lastIndexOf("</script>"));
    expect(doc.endsWith("<p>app</p>")).toBe(true);
  });

  it("reads a save from the web frame or the native view and ignores anything else", () => {
    expect(canvasSaveState({ type: CANVAS_SAVE_MESSAGE, state: { done: 2 } })).toEqual({
      state: { done: 2 },
    });
    expect(canvasSaveState(JSON.stringify({ type: CANVAS_SAVE_MESSAGE, state: [1] }))).toEqual({
      state: [1],
    });
    expect(canvasSaveState("<html>")).toBeUndefined();
    expect(canvasSaveState({ type: "other" })).toBeUndefined();
  });
});
