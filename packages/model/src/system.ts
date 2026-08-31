import { z } from "zod";
import { NodeSchema, type Node } from "./nodes.js";
import { EdgeSchema, type Edge } from "./edges.js";

export const SystemModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Cloudflare account this system belongs to, when known. */
  accountId: z.string().optional(),
  nodes: z.array(NodeSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
  /**
   * Named groups over the nodes. Optional so every existing construction site
   * keeps working untouched — read it as `system.groups ?? []`.
   */
  groups: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .optional(),
  scannedAt: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type SystemModel = z.infer<typeof SystemModelSchema>;

export function emptySystem(id: string, name: string): SystemModel {
  return { id, name, nodes: [], edges: [], meta: {} };
}

/**
 * Operations are pure and return a new model. The canvas undo stack replays
 * over immutable snapshots, so nothing here may mutate its input.
 */

export function upsertNode(system: SystemModel, node: Node): SystemModel {
  const existing = system.nodes.findIndex((n) => n.id === node.id);
  if (existing === -1) {
    return { ...system, nodes: [...system.nodes, node] };
  }
  const nodes = [...system.nodes];
  nodes[existing] = mergeNode(nodes[existing]!, node);
  return { ...system, nodes };
}

/**
 * Merging matters when two importers see the same resource. The account scan
 * knows the real `resourceId`; the repo parse knows the `configPath` and the
 * author's comments. Neither is complete, so later values win field by field
 * rather than replacing the node wholesale — except position, which is the
 * user's and must never be clobbered by a re-scan.
 */
function mergeNode(existing: Node, incoming: Node): Node {
  // A real title always beats a stand-in, whichever importer ran first. Without
  // this, scanning an account after parsing configs would relabel every KV
  // namespace with somebody's binding variable, and vice versa.
  const keepExistingName = incoming.nameIsFallback === true && !existing.nameIsFallback;

  return {
    ...existing,
    ...incoming,
    name: keepExistingName ? existing.name : incoming.name,
    nameIsFallback: keepExistingName
      ? existing.nameIsFallback
      : incoming.nameIsFallback,
    position: existing.position ?? incoming.position,
    worker:
      existing.worker || incoming.worker
        ? { ...existing.worker, ...incoming.worker } as Node["worker"]
        : undefined,
    raw: { ...existing.raw, ...incoming.raw },
    meta: { ...existing.meta, ...incoming.meta },
  };
}

export function removeNode(system: SystemModel, nodeId: string): SystemModel {
  return {
    ...system,
    nodes: system.nodes.filter((n) => n.id !== nodeId),
    // Dropping a node must drop its edges too, or the model develops dangling
    // references that every consumer would have to defend against.
    edges: system.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
  };
}

export function upsertEdge(system: SystemModel, edge: Edge): SystemModel {
  const existing = system.edges.findIndex((e) => e.id === edge.id);
  if (existing === -1) {
    return { ...system, edges: [...system.edges, edge] };
  }
  const edges = [...system.edges];
  edges[existing] = { ...edges[existing]!, ...edge };
  return { ...system, edges };
}

export function removeEdge(system: SystemModel, edgeId: string): SystemModel {
  return { ...system, edges: system.edges.filter((e) => e.id !== edgeId) };
}

export function getNode(system: SystemModel, id: string): Node | undefined {
  return system.nodes.find((n) => n.id === id);
}

export function outgoing(system: SystemModel, nodeId: string): Edge[] {
  return system.edges.filter((e) => e.from === nodeId);
}

export function incoming(system: SystemModel, nodeId: string): Edge[] {
  return system.edges.filter((e) => e.to === nodeId);
}

/** Edges whose endpoints do not both exist. Surfaced by the dangling-binding rule. */
export function danglingEdges(system: SystemModel): Edge[] {
  const ids = new Set(system.nodes.map((n) => n.id));
  return system.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
}

/**
 * Nodes nothing points at and which point at nothing — created but never wired
 * up. On a scanned account this is usually a resource left behind by a deleted
 * Worker, which costs money and nobody notices.
 */
export function orphanNodes(system: SystemModel): Node[] {
  const connected = new Set<string>();
  for (const e of system.edges) {
    connected.add(e.from);
    connected.add(e.to);
  }
  return system.nodes.filter((n) => !connected.has(n.id));
}

/**
 * Cycles restricted to a set of edge kinds. Service-binding cycles are the
 * interesting case: A calls B calls A recurses until it trips the subrequest
 * limit, and nothing in the Cloudflare dashboard will ever tell you it exists.
 *
 * Returns each cycle as the list of node ids in traversal order.
 */
export function findCycles(
  system: SystemModel,
  kinds: ReadonlySet<Edge["kind"]>,
): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const e of system.edges) {
    if (!kinds.has(e.kind)) continue;
    const list = adjacency.get(e.from) ?? [];
    list.push(e.to);
    adjacency.set(e.from, list);
  }

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    seen.add(id);
    onStack.add(id);
    stack.push(id);

    for (const next of adjacency.get(id) ?? []) {
      if (onStack.has(next)) {
        // Slice from where the cycle opened, so the reported path is the loop
        // itself and not the walk that led into it.
        const start = stack.indexOf(next);
        if (start !== -1) cycles.push([...stack.slice(start), next]);
      } else if (!seen.has(next)) {
        visit(next);
      }
    }

    stack.pop();
    onStack.delete(id);
  };

  for (const node of system.nodes) {
    if (!seen.has(node.id)) visit(node.id);
  }
  return dedupeCycles(cycles);
}

/** A→B→A and B→A→B are the same loop; report it once. */
function dedupeCycles(cycles: string[][]): string[][] {
  const out: string[][] = [];
  const keys = new Set<string>();
  for (const cycle of cycles) {
    const key = [...new Set(cycle)].sort().join("|");
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(cycle);
  }
  return out;
}

/** Fold one model into another. Used to combine per-config parses into a system. */
export function mergeSystems(
  base: SystemModel,
  incoming: SystemModel,
): SystemModel {
  let out = base;
  for (const node of incoming.nodes) out = upsertNode(out, node);
  for (const edge of incoming.edges) out = upsertEdge(out, edge);
  return out;
}
