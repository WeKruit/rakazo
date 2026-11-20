import { describe, expect, it } from "vitest";
import {
  desktopProtectionGuardMessage,
  isProtectedComputerLifecycleCommand,
  protectedComputerLifecycleRefusal,
} from "./computer-lifecycle-guard.js";

describe("computer lifecycle command guard", () => {
  it("does not run a command that names a way to stop the desktop or browser", () => {
    for (const command of [
      "pkill chromium",
      "killall chrome",
      "kill -9 1234",
      "k\\ill -9 1234",
      "xkill",
      "systemctl restart chromium",
      "systemctl --user restart chromium",
      "service chromium restart",
      "rm -rf ~/.browser-profiles/chromium",
      "rm -f /tmp/.X1-lock",
      "bash -c 'pkill chromium'",
      'bash -lc "killall chrome"',
      "python3 - <<'PY'\nimport os; os.system('pkill chromium')\nPY",
    ])
      expect(isProtectedComputerLifecycleCommand(command)).toBe(true);
  });

  it("runs ordinary shell work, heredoc scripts and sourced files included", () => {
    // Staging 2a781497: 8 of 27 shell calls were python heredocs refused by the old parser.
    for (const command of [
      "pwd && ls -la",
      "node scripts/check.js",
      "systemctl status chromium",
      'rm -f "$WORKSPACE/tmp.txt"',
      "python3 - <<'PY'\nimport json\nprint(json.dumps({'a': 1}))\nPY",
      "cat <<EOF > notes.md\nhello\nEOF",
      "source .venv/bin/activate && pytest",
      'bash -c "echo $HOME"',
    ])
      expect(isProtectedComputerLifecycleCommand(command)).toBe(false);
  });

  it("names what it refused", () => {
    expect(protectedComputerLifecycleRefusal("pkill chromium")).toBe("protected command pkill");
    expect(desktopProtectionGuardMessage("protected command pkill")).toContain(
      "protected command pkill",
    );
  });
});
