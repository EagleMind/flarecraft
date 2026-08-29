import type { Edge, Node, SystemModel } from "@flarecraft/model";
import { PRIMITIVES } from "@flarecraft/catalog";
import type { Severity } from "./types.js";

/**
 * What is deployed versus what is written down.
 *
 * This is the comparison the Cloudflare dashboard cannot make, because it only
 * knows one of the two sides. It is also the one that catches the thing nobody
 * admits to: a binding added by hand during an incident, which then works fine
 * until the next deploy from a config that has never heard of it.
 *
 * One honest caveat runs through the whole file. A repo scan sees only the
 * repositories that happen to be on this machine, so "deployed but not in any
 * config" is frequently just a repo you have not cloned. That direction is
 * reported as information; the other direction, and disagreements about things
 * present on both sides, are where the real signal is.
 */

export type DriftKind =
  | "undeployed"
  | "untracked"
  | "binding-only-in-account"
  | "binding-only-in-repo"
  | "field-differs";

export interface DriftFinding {
  kind: DriftKind;
  severity: Severity;
  message: string;
  remedy?: string;
  nodeId?: string;
  edgeId?: string;
}

const label = (node: Node): string =>
  `${node.name} (${PRIMITIVES[node.kind]?.label ?? node.kind})`;

/** Edges are compared on meaning, not on the id, which encodes ordering too. */
const edgeKey = (edge: Edge): string =>
  `${edge.from}->${edge.to}|${edge.kind}|${edge.bindingName ?? ""}`;

const describeEdge = (edge: Edge, system: SystemModel): string => {
  const from = system.nodes.find((n) => n.id === edge.from);
  const to = system.nodes.find((n) => n.id === edge.to);
  const binding = edge.bindingName ? `env.${edge.bindingName}` : edge.kind;
  return `${from?.name ?? edge.from} → ${to?.name ?? edge.to} (${binding})`;
};

export function diffSystems(
  repo: SystemModel,
  account: SystemModel,
): DriftFinding[] {
  const findings: DriftFinding[] = [];

  const repoNodes = new Map(repo.nodes.map((n) => [n.id, n]));
  const accountNodes = new Map(account.nodes.map((n) => [n.id, n]));

  for (const [id, node] of repoNodes) {
    if (accountNodes.has(id)) continue;
    // Ingress nodes are frequently declared in config and configured elsewhere;
    // reporting every route as undeployed would drown the useful findings.
    if (PRIMITIVES[node.kind]?.category === "ingress") continue;

    findings.push({
      kind: "undeployed",
      severity: "warning",
      message: `${label(node)} is in a config but was not found in the account.`,
      remedy:
        node.kind === "worker"
          ? "Either it has never been deployed, or it deploys under a different name than its config declares."
          : "The config references it, so a deploy will fail until it exists. `provision.sh` in an export creates it.",
      nodeId: id,
    });
  }

  for (const [id, node] of accountNodes) {
    if (repoNodes.has(id)) continue;
    findings.push({
      kind: "untracked",
      severity: "info",
      message: `${label(node)} is deployed but no scanned config mentions it.`,
      remedy:
        "Either its repository is not on this machine, or nothing owns it any more — in which case a resource still costing money has outlived the Worker that used it.",
      nodeId: id,
    });
  }

  // Binding drift is only meaningful for Workers that exist on both sides.
  // Comparing edges of a Worker only one side knows about restates the node
  // finding once per binding.
  const shared = new Set(
    [...repoNodes.keys()].filter((id) => accountNodes.has(id)),
  );

  const repoEdges = new Map(repo.edges.map((e) => [edgeKey(e), e]));
  const accountEdges = new Map(account.edges.map((e) => [edgeKey(e), e]));

  for (const [key, edge] of accountEdges) {
    if (repoEdges.has(key)) continue;
    if (!shared.has(edge.from) || !shared.has(edge.to)) continue;

    findings.push({
      kind: "binding-only-in-account",
      severity: "error",
      message: `Deployed but not in config: ${describeEdge(edge, account)}.`,
      remedy:
        "This binding exists in production and nowhere in your configs. The next deploy removes it, and whatever depends on it stops working. Add it to the config, or delete it deliberately.",
      edgeId: edge.id,
    });
  }

  for (const [key, edge] of repoEdges) {
    if (accountEdges.has(key)) continue;
    if (!shared.has(edge.from) || !shared.has(edge.to)) continue;

    findings.push({
      kind: "binding-only-in-repo",
      severity: "warning",
      message: `In config but not deployed: ${describeEdge(edge, repo)}.`,
      remedy:
        "The config has moved ahead of production — usually just an undeployed change, which a deploy resolves.",
      edgeId: edge.id,
    });
  }

  for (const id of shared) {
    const local = repoNodes.get(id)!;
    const remote = accountNodes.get(id)!;
    if (local.kind !== "worker") continue;

    const localDate = local.worker?.compatibilityDate;
    const remoteDate = remote.worker?.compatibilityDate;
    // Only compare when both sides actually reported one; the account API does
    // not always include it, and a gap in the data is not a disagreement.
    if (localDate && remoteDate && localDate !== remoteDate) {
      findings.push({
        kind: "field-differs",
        severity: "warning",
        message: `${local.name} is pinned to ${localDate} in config but running ${remoteDate}.`,
        remedy:
          "The deployed Worker is on different runtime behaviour than the config describes. Deploy, or find out who changed it.",
        nodeId: id,
      });
    }
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}
