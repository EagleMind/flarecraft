import { canConnect, defaultRelation, suggestBindingName, PRIMITIVES } from "@flarecraft/catalog";
import { edgeId, nodeId } from "./ids.js";
import type { Node, NodeKind } from "./nodes.js";
import type { Edge } from "./edges.js";
import { upsertEdge, upsertNode, type SystemModel } from "./system.js";

/**
 * Canvas-side edits.
 *
 * Kept in the model package rather than the studio so that the design flow, the
 * agent-facing surface, and any future CLI all create nodes the same way — the
 * rules about what may connect to what are not UI concerns.
 */

export interface ConnectResult {
  system: SystemModel;
  edge?: Edge;
  rejected?: string;
}

/**
 * Names for newly placed nodes.
 *
 * Uniqueness is enforced against the whole system because a Cloudflare account
 * is a flat namespace per resource type — two queues named `jobs` are the same
 * queue, not two things that happen to share a label.
 */
export function uniqueName(system: SystemModel, kind: NodeKind): string {
  const base = (PRIMITIVES[kind]?.label ?? kind)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const taken = new Set(system.nodes.filter((n) => n.kind === kind).map((n) => n.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Place a new node.
 *
 * The id is fixed at creation and never re-derived from the name afterwards.
 * Deriving it live would look tidier, but renaming a node would then silently
 * change its identity and orphan every edge already attached to it.
 */
export function addNode(
  system: SystemModel,
  kind: NodeKind,
  position: { x: number; y: number },
  name = uniqueName(system, kind),
): { system: SystemModel; node: Node } {
  const node: Node = {
    id: nodeId(kind, `${name}-${Date.now().toString(36)}`),
    kind,
    name,
    provenance: "design",
    position,
    ...(kind === "worker"
      ? {
          worker: {
            compatibilityFlags: [],
            migrations: [],
            vars: {},
            environmentVars: {},
            secrets: [],
            // Today's date is the right default: a new Worker should start on
            // current runtime behaviour, not inherit someone else's old date.
            compatibilityDate: new Date().toISOString().slice(0, 10),
          },
        }
      : {}),
    meta: {},
  };
  return { system: upsertNode(system, node), node };
}

export function renameNode(
  system: SystemModel,
  id: string,
  name: string,
): SystemModel {
  return {
    ...system,
    nodes: system.nodes.map((n) => (n.id === id ? { ...n, name, nameIsFallback: false } : n)),
  };
}

export function patchWorker(
  system: SystemModel,
  id: string,
  patch: Partial<NonNullable<Node["worker"]>>,
): SystemModel {
  return {
    ...system,
    nodes: system.nodes.map((n) =>
      n.id === id && n.worker ? { ...n, worker: { ...n.worker, ...patch } } : n,
    ),
  };
}

/**
 * Connect two nodes, refusing anything the platform cannot express.
 *
 * The refusal is the feature. A canvas that lets you draw a KV namespace
 * producing into a queue is a drawing tool; one that refuses is a design tool,
 * because the diagram is then guaranteed to correspond to a real deployment.
 */
export function connect(
  system: SystemModel,
  fromId: string,
  toId: string,
  bindingName?: string,
): ConnectResult {
  const from = system.nodes.find((n) => n.id === fromId);
  const to = system.nodes.find((n) => n.id === toId);
  if (!from || !to) return { system, rejected: "One end of that connection does not exist." };
  if (fromId === toId) return { system, rejected: "A node cannot bind to itself." };

  if (!canConnect(from.kind, to.kind)) {
    const fromLabel = PRIMITIVES[from.kind]?.label ?? from.kind;
    const toLabel = PRIMITIVES[to.kind]?.label ?? to.kind;
    return {
      system,
      rejected: `A ${fromLabel} cannot connect to a ${toLabel} on Cloudflare.`,
    };
  }

  const relation = defaultRelation(from.kind, to.kind);
  if (!relation) return { system, rejected: "No legal relation between those nodes." };

  const name =
    bindingName ?? (relation.needsBindingName ? suggestBindingName(to.name) : undefined);

  const duplicate = system.edges.find(
    (e) => e.from === fromId && e.to === toId && e.kind === relation.kind,
  );
  if (duplicate) {
    return { system, rejected: `${from.name} already connects to ${to.name}.` };
  }

  // Two Workers may legitimately hold different bindings to the same resource,
  // but not two bindings under the same variable name.
  if (name && system.edges.some((e) => e.from === fromId && e.bindingName === name)) {
    return { system, rejected: `${from.name} already has a binding called ${name}.` };
  }

  const edge: Edge = {
    id: edgeId(fromId, toId, relation.kind, name),
    from: fromId,
    to: toId,
    kind: relation.kind,
    ...(name ? { bindingName: name } : {}),
    ...(PRIMITIVES[to.kind]?.bindingKey
      ? { bindingType: PRIMITIVES[to.kind]!.bindingKey as Edge["bindingType"] }
      : {}),
    meta: {},
  };

  return { system: upsertEdge(system, edge), edge };
}

export interface ProposedTopology {
  nodes: { kind: string; name: string }[];
  edges: { from: string; to: string; bindingName?: string }[];
}

export interface ApplyResult {
  system: SystemModel;
  added: string[];
  /** Edges that could not be created, with the reason. Never silently dropped. */
  rejected: string[];
}

/**
 * Drop a proposed subgraph onto an existing system.
 *
 * Nodes are matched by name against what is already there, so applying a
 * proposal that mentions an existing Worker extends it rather than creating a
 * second one with the same name. Edges run through the same `connect` used by
 * the canvas, which means a proposal cannot introduce an edge you would not
 * have been allowed to draw by hand.
 */
export function applyProposal(
  system: SystemModel,
  proposal: ProposedTopology,
  origin: { x: number; y: number } = { x: 0, y: 0 },
): ApplyResult {
  let out = system;
  const added: string[] = [];
  const rejected: string[] = [];
  const byName = new Map<string, string>();

  for (const existing of system.nodes) byName.set(existing.name, existing.id);

  proposal.nodes.forEach((proposed, index) => {
    const existingId = byName.get(proposed.name);
    if (existingId) return;

    // Staggered so a fresh proposal is readable before anyone hits re-layout.
    const position = {
      x: origin.x + (index % 3) * 260,
      y: origin.y + Math.floor(index / 3) * 120,
    };
    const result = addNode(out, proposed.kind as NodeKind, position, proposed.name);
    out = result.system;
    byName.set(proposed.name, result.node.id);
    added.push(proposed.name);
  });

  for (const edge of proposal.edges) {
    const fromId = byName.get(edge.from);
    const toId = byName.get(edge.to);
    if (!fromId || !toId) {
      rejected.push(`${edge.from} → ${edge.to}: one end is not in the proposal.`);
      continue;
    }
    const result = connect(out, fromId, toId, edge.bindingName || undefined);
    if (result.rejected) {
      rejected.push(`${edge.from} → ${edge.to}: ${result.rejected}`);
      continue;
    }
    out = result.system;
  }

  return { system: out, added, rejected };
}

/**
 * Edit a resource-level setting — a route pattern, a cron expression.
 *
 * Written to `config` rather than into `raw`, so an edit stays distinguishable
 * from what was parsed and a later re-scan cannot quietly revert it.
 */
export function patchNodeConfig(
  system: SystemModel,
  id: string,
  patch: Record<string, unknown>,
): SystemModel {
  return {
    ...system,
    nodes: system.nodes.map((n) =>
      n.id === id ? { ...n, config: prune({ ...n.config, ...patch }) } : n,
    ),
  };
}

/** Edit a binding-entry setting: delivery_delay, migrations_dir, and so on. */
export function patchEdgeConfig(
  system: SystemModel,
  id: string,
  patch: Record<string, unknown>,
): SystemModel {
  return {
    ...system,
    edges: system.edges.map((e) =>
      e.id === id ? { ...e, config: prune({ ...e.config, ...patch }) } : e,
    ),
  };
}

/** Edit the queue consumer settings carried on a queue_consumer edge. */
export function patchConsumer(
  system: SystemModel,
  id: string,
  patch: Record<string, unknown>,
): SystemModel {
  return {
    ...system,
    edges: system.edges.map((e) =>
      e.id === id
        ? { ...e, consumer: prune({ ...e.consumer, ...patch }) as Edge["consumer"] }
        : e,
    ),
  };
}

/**
 * Clearing a field means removing the key, not writing an empty string.
 * An emitted `"jurisdiction": ""` is not the same as an absent one.
 */
function prune(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || entry === "") continue;
    if (Array.isArray(entry) && entry.length === 0) continue;
    out[key] = entry;
  }
  return out;
}

export function renameBinding(
  system: SystemModel,
  edgeIdentifier: string,
  bindingName: string,
): SystemModel {
  return {
    ...system,
    edges: system.edges.map((e) =>
      e.id === edgeIdentifier ? { ...e, bindingName } : e,
    ),
  };
}
