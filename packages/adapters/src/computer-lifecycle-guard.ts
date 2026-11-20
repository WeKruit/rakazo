/**
 * A graphical bot's desktop and browser keep running while its agent uses the shell. A command
 * that names a way to stop them is not run; everything else, heredocs and scripts included, is.
 * This only guards against an accidental kill: the computer itself is the isolation boundary,
 * as in Claude Code and Pi, so the command is read word by word, never parsed as a shell would.
 * Staging 2a781497: the shell parser this replaces refused 8 of 27 commands (python heredocs).
 */
const KILL_WORDS = /^(?:kill|pkill|killall|xkill)$/;
const SERVICE_WORDS = /^(?:systemctl|service)$/;
const SERVICE_ACTIONS = /^(?:stop|restart|kill)$/;

function words(command: string): string[] {
  return command
    .replaceAll("\\\n", "")
    .replaceAll("\\", "")
    .split(/[\s;&|()`'"<>{}]+/)
    .filter(Boolean);
}

/** Short reason the command is not run on a graphical computer, when it names a desktop stop. */
export function protectedComputerLifecycleRefusal(command: string): string | undefined {
  const list = words(command);
  for (const word of list) {
    const base = (word.split("/").at(-1) ?? "").toLowerCase();
    if (KILL_WORDS.test(base)) return `protected command ${base}`;
    if (/(?:\.browser-profiles|--user-data-dir)/i.test(word)) return "browser profile path";
    if (/(?:\/tmp\/\.x11-unix|\/tmp\/\.x\d+-lock)/i.test(word)) return "X11 path";
  }
  const service = list.find((word) => SERVICE_WORDS.test(word.split("/").at(-1) ?? ""));
  const action = service && list.find((word) => SERVICE_ACTIONS.test(word.toLowerCase()));
  return service && action ? `${service.split("/").at(-1)} ${action.toLowerCase()}` : undefined;
}

export function isProtectedComputerLifecycleCommand(command: string): boolean {
  return protectedComputerLifecycleRefusal(command) !== undefined;
}

export function desktopProtectionGuardMessage(reason: string): string {
  return `This command was not run: it would stop the desktop or browser (${reason}). Everything else in the shell is available.`;
}
