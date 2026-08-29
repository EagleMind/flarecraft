import { PRIMITIVES } from "@flarecraft/catalog";
import type { Node } from "./nodes.js";
import { findCycles, type SystemModel } from "./system.js";

/**
 * What it takes to get a designed system running, in an order that works.
 *
 * Two things make this more than a list of commands. Resources have to exist
 * before any config referencing them will deploy, and several of them only
 * hand back their id at creation time. And Workers have to go out in dependency
 * order: a service binding cannot resolve a Worker that is not deployed yet, so
 * callees precede callers.
 *
 * Computed here rather than in the server so it can be tested without running
 * anything, and shown to the user before a single command executes.
 */

export type StepKind = "create-resource" | "deploy-worker";

export interface DeploymentStep {
  kind: StepKind;
  /** Node this step brings into existence. */
  nodeId: string;
  label: string;
  command: string;
  why: string;
  /**
   * True when the command prints an id that has to go back into a config
   * before anything referencing it will deploy.
   */
  yieldsId: boolean;
}

export interface DeploymentPlan {
  steps: DeploymentStep[];
  /** Reasons the system cannot be deployed as it stands. */
  blockers: string[];
}

/**
 * Workers in dependency order: a Worker appears after everything it calls.
 *
 * Kahn's algorithm over service edges. A cycle makes the ordering impossible,
 * which is reported as a blocker rather than resolved arbitrarily — there is no
 * correct order for a loop, and picking one silently would be a lie.
 */
export function deploymentOrder(system: SystemModel): Node[] {
  const workers = system.nodes.filter((n) => n.kind === "worker");
  const ids = new Set(workers.map((w) => w.id));

  // caller -> callee. A callee must be deployed first, so it has no
  // outstanding dependencies of its own once its callees are done.
  const dependsOn = new Map<string, Set<string>>();
  for (const worker of workers) dependsOn.set(worker.id, new Set());

  for (const edge of system.edges) {
    if (edge.kind !== "service") continue;
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    dependsOn.get(edge.from)?.add(edge.to);
  }

  const ordered: Node[] = [];
  const done = new Set<string>();

  // Deterministic: same system, same order, every time.
  const remaining = [...workers].sort((a, b) => a.name.localeCompare(b.name));

  while (remaining.length > 0) {
    const index = remaining.findIndex((worker) =>
      [...(dependsOn.get(worker.id) ?? [])].every((id) => done.has(id)),
    );
    // Everything left is in a cycle; emit alphabetically so the plan is still
    // shown, and let the blocker explain why it will not work.
    if (index === -1) {
      ordered.push(...remaining);
      break;
    }
    const [worker] = remaining.splice(index, 1);
    ordered.push(worker!);
    done.add(worker!.id);
  }

  return ordered;
}

export function planDeployment(system: SystemModel): DeploymentPlan {
  const blockers: string[] = [];
  const steps: DeploymentStep[] = [];

  for (const cycle of findCycles(system, new Set(["service" as const]))) {
    const names = cycle.map(
      (id) => system.nodes.find((n) => n.id === id)?.name ?? id,
    );
    blockers.push(
      `Service bindings loop (${names.join(" → ")}). There is no order that deploys these correctly — break the cycle first.`,
    );
  }

  // Resources first — but only ones that do not exist yet. Two signals say a
  // resource is already there: it carries a Cloudflare-side id, or it was read
  // back from the account in the first place. Without the second check, every
  // R2 bucket in a scanned system gets a create step, because R2 is keyed by
  // name and so has no id to go on.
  for (const node of system.nodes) {
    const spec = PRIMITIVES[node.kind];
    if (!spec?.createCommand) continue;
    if (node.resourceId || node.provenance === "account") continue;

    steps.push({
      kind: "create-resource",
      nodeId: node.id,
      label: `${spec.label} "${node.name}"`,
      command: `${spec.createCommand} ${JSON.stringify(node.name)}`,
      why: "Every config referencing it is invalid until it exists.",
      yieldsId: Boolean(spec.requiresResourceId),
    });
  }

  const order = deploymentOrder(system);
  for (const worker of order) {
    const callees = system.edges
      .filter((e) => e.kind === "service" && e.from === worker.id)
      .map((e) => system.nodes.find((n) => n.id === e.to)?.name)
      .filter((name): name is string => Boolean(name));

    steps.push({
      kind: "deploy-worker",
      nodeId: worker.id,
      label: worker.name,
      command: `wrangler deploy --config ${worker.name}/wrangler.jsonc`,
      why:
        callees.length > 0
          ? `Deployed after ${callees.join(", ")}, because a service binding cannot resolve a Worker that is not there yet.`
          : "Nothing depends on this one, so its position is free.",
      yieldsId: false,
    });
  }

  const consumers = system.edges.filter((e) => e.kind === "queue_consumer");
  for (const edge of consumers) {
    const consumer = system.nodes.find((n) => n.id === edge.to);
    const producers = system.edges.filter(
      (e) => e.to === edge.from && e.kind === "binding",
    );
    if (!consumer || producers.length === 0) continue;

    const producerIndex = Math.min(
      ...producers.map((p) =>
        order.findIndex((w) => w.id === p.from),
      ).filter((i) => i >= 0),
    );
    const consumerIndex = order.findIndex((w) => w.id === consumer.id);

    // Not fatal, but worth saying: a producer live before its consumer means
    // messages accumulate behind a handler that does not exist yet.
    if (consumerIndex > producerIndex && producerIndex >= 0) {
      blockers.push(
        `${consumer.name} consumes a queue that a Worker deployed before it produces into. Messages will queue up until the consumer is live — usually harmless, but it is not nothing.`,
      );
    }
  }

  if (system.nodes.filter((n) => n.kind === "worker").length === 0) {
    blockers.push("There are no Workers to deploy.");
  }

  return { steps, blockers };
}
