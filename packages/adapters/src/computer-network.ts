import { createHash } from "node:crypto";
import type {
  AdapterContext,
  ComputerRef,
  SandboxNetworkPolicy,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** Owner rules on what the computer may reach, kept beside the tool rules. */
export const EGRESS_RULE_KIND = "egress";
/** A block rule on this value limits the computer to the sites the owner allowed. */
export const EGRESS_ALL_SITES = "*";

/** A hostname as the owner typed it or as a URL carries it: lowercase, no scheme, port or path. */
export function egressHost(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === EGRESS_ALL_SITES) return trimmed;
  let host: string;
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return undefined;
  }
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return undefined;
  return host;
}

export type EgressRules = Array<{ effect: string; matchValue: string }>;

/** The Space's egress rules. Any member's lock locks the shared computer; allowed sites add up. */
export function loadEgressRules(prisma: PrismaClient, spaceId: string): Promise<EgressRules> {
  return prisma.actionApprovalRule.findMany({
    where: { spaceId, matchKind: EGRESS_RULE_KIND },
    select: { effect: true, matchValue: true },
  });
}

export function egressLocked(rules: EgressRules): boolean {
  return rules.some((rule) => rule.effect === "block" && rule.matchValue === EGRESS_ALL_SITES);
}

export function egressPolicy(
  rules: EgressRules,
  credentials: SandboxNetworkPolicy["credentials"],
): SandboxNetworkPolicy {
  const hosts = (effect: string) =>
    [
      ...new Set(
        rules
          .filter((rule) => rule.effect === effect && rule.matchValue !== EGRESS_ALL_SITES)
          .map((rule) => rule.matchValue),
      ),
    ].sort();
  const locked = egressLocked(rules);
  return {
    ...(locked ? { allowHosts: hosts("always_allow") } : {}),
    denyHosts: hosts("block"),
    // Credentials are added at the edge only for a locked computer, which gets no shell secrets.
    credentials: locked ? credentials : [],
  };
}

const applied = new Map<string, string>();

/**
 * Send the policy to the provider when it changed for this computer. A locked policy that cannot
 * be applied stops computer use; an open one is best effort, since it allows no more than before.
 */
export async function applyComputerNetworkPolicy(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  policy: SandboxNetworkPolicy,
  context: AdapterContext,
): Promise<void> {
  const key = computer.providerRef || computer.id;
  // A digest, so credential values are not kept in memory beyond the call.
  const fingerprint = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const open = !policy.allowHosts && policy.denyHosts.length === 0;
  // A computer nothing was ever applied to is already open.
  if (applied.get(key) === fingerprint || (open && !applied.has(key))) return;
  if (!sandbox.setNetworkPolicy) {
    if (open) return;
    throw new Error("This computer cannot limit which sites it reaches.");
  }
  try {
    await sandbox.setNetworkPolicy(computer, policy, context);
    applied.set(key, fingerprint);
    getLogger().info("computer.network_policy", {
      locked: Boolean(policy.allowHosts),
      allowed: policy.allowHosts?.length ?? null,
      denied: policy.denyHosts.length,
      credentialHosts: policy.credentials.length,
    });
  } catch (error) {
    applied.delete(key);
    getLogger().warn("computer.network_policy_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!open) throw error;
  }
}
