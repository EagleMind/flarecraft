import { PRIMITIVES } from "@flarecraft/catalog";
import type { Node } from "./nodes.js";
import type { SystemModel } from "./system.js";

/**
 * Sorting a scattered account into systems.
 *
 * A Cloudflare account has no notion of "these things belong together" — every
 * Worker and every resource sits in one flat list. But the graph does know:
 * things that share a database or a queue are one system, and things that share
 * nothing are not. So the default grouping is simply the graph's connected
 * components, which is right far more often than any naming convention would be.
 *
 * Groups are local metadata. Nothing here round-trips to Cloudflare.
 */

/**
 * Nodes that must not act as connectors when finding components.
 *
 * Workers AI, Browser Rendering, and Images are account-wide capabilities, not
 * shared state. Two entirely unrelated Workers that both hold `env.AI` would
 * otherwise collapse into one component — the single most likely way this
 * feature could produce a confidently wrong answer.
 */
const NON_CONNECTING = new Set(["ai", "browser", "images"]);

export interface Group {
  id: string;
  name: string;
}

const groupsOf = (system: SystemModel): Group[] => system.groups ?? [];

/**
 * Partition the graph into connected components, ignoring the connectors above.
 *
 * Only components containing at least one Worker become groups: a KV namespace
 * nobody binds is a finding for the linter, not a system of its own.
 */
export function suggestGroups(system: SystemModel): SystemModel {
  const connecting = new Set(
    system.nodes.filter((n) => !NON_CONNECTING.has(n.kind)).map((n) => n.id),
  );

  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };

  for (const edge of system.edges) {
    if (!connecting.has(edge.from) || !connecting.has(edge.to)) continue;
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }

  const seen = new Set<string>();
  const components: string[][] = [];

  for (const node of system.nodes) {
    if (seen.has(node.id) || !connecting.has(node.id)) continue;

    // Iterative rather than recursive: a large account is a wide graph, and a
    // deep chain should not be able to blow the stack.
    const component: string[] = [];
    const stack = [node.id];
    seen.add(node.id);

    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    components.push(component);
  }

  const groups: Group[] = [];
  const assignment = new Map<string, string>();

  components.forEach((component, index) => {
    const members = component
      .map((id) => system.nodes.find((n) => n.id === id))
      .filter((n): n is Node => Boolean(n));
    if (!members.some((n) => n.kind === "worker")) return;

    const id = `group-${index + 1}`;
    groups.push({ id, name: nameFor(system, members) });
    for (const member of members) assignment.set(member.id, id);
  });

  return {
    ...system,
    groups,
    nodes: system.nodes.map((n) => {
      const groupId = assignment.get(n.id);
      return groupId ? { ...n, groupId } : omitGroup(n);
    }),
  };
}

/**
 * Name a component after its busiest Worker.
 *
 * The Worker with the most connections is almost always the one the system is
 * "about" — the API in front of a database and a queue, rather than the
 * consumer hanging off the end of it.
 */
function nameFor(system: SystemModel, members: Node[]): string {
  const workers = members.filter((n) => n.kind === "worker");
  if (workers.length === 0) return "system";

  const degree = (id: string): number =>
    system.edges.filter((e) => e.from === id || e.to === id).length;

  return [...workers].sort((a, b) => degree(b.id) - degree(a.id) || a.name.localeCompare(b.name))[0]!
    .name;
}

/** Removing the key entirely, rather than setting it undefined. */
function omitGroup(node: Node): Node {
  if (node.groupId === undefined) return node;
  const { groupId: _drop, ...rest } = node;
  return rest;
}

export function assignToGroup(
  system: SystemModel,
  nodeIds: string[],
  groupId: string,
): SystemModel {
  const wanted = new Set(nodeIds);
  return {
    ...system,
    nodes: system.nodes.map((n) => (wanted.has(n.id) ? { ...n, groupId } : n)),
  };
}

/** Put a selection into a brand new group, and return the system plus its id. */
export function groupSelection(
  system: SystemModel,
  nodeIds: string[],
  name?: string,
): { system: SystemModel; group: Group } {
  const members = system.nodes.filter((n) => nodeIds.includes(n.id));
  const group: Group = {
    id: freshGroupId(groupsOf(system)),
    name: name ?? nameFor(system, members),
  };

  return {
    system: prune({
      ...assignToGroup(system, nodeIds, group.id),
      groups: [...groupsOf(system), group],
    }),
    group,
  };
}

/**
 * An id that cannot collide with an existing one.
 *
 * A timestamp is not enough: two groups created in the same millisecond — which
 * is entirely ordinary when the canvas creates several at once — would share an
 * id, and every operation keyed on that id would then affect both.
 */
function freshGroupId(existing: Group[]): string {
  const taken = new Set(existing.map((g) => g.id));
  let n = existing.length + 1;
  while (taken.has(`group-${n}`)) n += 1;
  return `group-${n}`;
}

export function removeFromGroup(system: SystemModel, nodeIds: string[]): SystemModel {
  const wanted = new Set(nodeIds);
  return prune({
    ...system,
    nodes: system.nodes.map((n) => (wanted.has(n.id) ? omitGroup(n) : n)),
  });
}

export function renameGroup(
  system: SystemModel,
  groupId: string,
  name: string,
): SystemModel {
  return {
    ...system,
    groups: groupsOf(system).map((g) => (g.id === groupId ? { ...g, name } : g)),
  };
}

export function mergeGroups(
  system: SystemModel,
  keepId: string,
  absorbId: string,
): SystemModel {
  return prune({
    ...system,
    nodes: system.nodes.map((n) =>
      n.groupId === absorbId ? { ...n, groupId: keepId } : n,
    ),
  });
}

/** Groups nothing belongs to any more are noise; drop them. */
function prune(system: SystemModel): SystemModel {
  const used = new Set(system.nodes.map((n) => n.groupId).filter(Boolean));
  return { ...system, groups: groupsOf(system).filter((g) => used.has(g.id)) };
}

export function groupMembers(system: SystemModel, groupId: string): Node[] {
  return system.nodes.filter((n) => n.groupId === groupId);
}

/**
 * What consolidating this group would need, from the model's point of view.
 *
 * Only Workers carry source on disk — a queue or a bucket has no folder — so
 * readiness is counted over Workers alone. `configPath` is present only when a
 * repo scan has been merged in, which is exactly the signal we want.
 */
export function groupReadiness(
  system: SystemModel,
  groupId: string,
): { workers: Node[]; located: Node[]; missing: Node[] } {
  const workers = groupMembers(system, groupId).filter((n) => n.kind === "worker");
  return {
    workers,
    located: workers.filter((n) => Boolean(n.configPath)),
    missing: workers.filter((n) => !n.configPath),
  };
}

/**
 * The group as a system in its own right.
 *
 * Edges are kept only when *both* endpoints are inside the group, so a
 * blueprint generated from this never describes a connection to something the
 * folder does not contain.
 */
export function subsystemForGroup(
  system: SystemModel,
  groupId: string,
  name?: string,
): SystemModel {
  const nodes = groupMembers(system, groupId);
  const ids = new Set(nodes.map((n) => n.id));
  const group = groupsOf(system).find((g) => g.id === groupId);

  return {
    ...system,
    name: name ?? group?.name ?? system.name,
    nodes,
    edges: system.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    groups: group ? [group] : [],
  };
}

/** Label for a node kind, used by the canvas chips. */
export const kindLabel = (kind: string): string =>
  PRIMITIVES[kind]?.label ?? kind;
