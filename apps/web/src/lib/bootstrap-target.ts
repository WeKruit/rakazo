export function initialBootstrapTarget(
  pathname: string,
  desktop: boolean,
): { botId?: string; groupId?: string } | null {
  const appRoute = pathname === "/app" || pathname.startsWith("/app/");
  if (!appRoute && !(desktop && pathname === "/")) return null;
  return appRoute ? threadTargetFromPath(pathname) : { botId: undefined };
}

function threadTargetFromPath(pathname: string) {
  const segments = pathname.split("/");
  if (segments[2] === "artifacts" || segments[2] === "board") return { botId: undefined };
  const group = segments[2] === "g";
  const encoded = segments[group ? 3 : 2];
  if (!encoded) return { botId: undefined };
  try {
    const id = decodeURIComponent(encoded);
    return group ? { groupId: id } : { botId: id };
  } catch {
    return { botId: undefined };
  }
}
