import { suggestBindingName } from "@flarecraft/catalog";
import { addNode, connect } from "./mutations.js";
import { edgeId } from "./ids.js";
import type { Edge } from "./edges.js";
import { outgoing, removeEdge, upsertEdge, type SystemModel } from "./system.js";

/**
 * Named topology refactors.
 *
 * The graph edit is the easy half and mostly obvious. The half worth having is
 * the deploy plan: these changes span several Workers, and doing them in the
 * wrong order breaks production in ways that look like someone else's bug.
 * Inserting a queue and deploying the producer first means messages pile up
 * with nothing draining them; renaming a Worker and deleting the old one first
 * means every caller 503s until the callers are redeployed.
 *
 * So every refactor returns the ordered plan alongside the new model, and every
 * step says why it sits where it does.
 */

export interface DeployStep {
  action: string;
  /** The command to run, where the step is a command. */
  command?: string;
  /** Why this step must happen at this point and not later. */
  why: string;
}

export interface RefactorResult {
  system: SystemModel;
  plan: DeployStep[];
  rejected?: string;
}

/**
 * Put a queue between two Workers that currently talk over a service binding.
 *
 * The usual reason: the call does not need a reply, and making it synchronous
 * ties the caller's latency and failure modes to the callee's.
 */
export function insertQueue(
  system: SystemModel,
  serviceEdgeId: string,
  queueName?: string,
): RefactorResult {
  const edge = system.edges.find((e) => e.id === serviceEdgeId);
  if (!edge || edge.kind !== "service") {
    return { system, plan: [], rejected: "That is not a service binding." };
  }

  const producer = system.nodes.find((n) => n.id === edge.from);
  const consumer = system.nodes.find((n) => n.id === edge.to);
  if (!producer || !consumer) {
    return { system, plan: [], rejected: "One end of that binding is missing." };
  }

  const name = queueName ?? `${consumer.name}-jobs`;
  let next = removeEdge(system, edge.id);

  const created = addNode(next, "queue", {
    x: (producer.position?.x ?? 0) + 260,
    y: producer.position?.y ?? 0,
  }, name);
  next = created.system;

  const produce = connect(next, producer.id, created.node.id, suggestBindingName(name));
  if (produce.rejected) return { system, plan: [], rejected: produce.rejected };
  next = produce.system;

  // The consumer edge carries a dead-letter queue from the start. Adding one
  // later means the window before you did is unrecoverable.
  const consumeEdge: Edge = {
    id: edgeId(created.node.id, consumer.id, "queue_consumer"),
    from: created.node.id,
    to: consumer.id,
    kind: "queue_consumer",
    bindingType: "queues.consumers",
    consumer: { maxBatchSize: 10, deadLetterQueue: `${name}-dlq` },
    meta: {},
  };
  next = upsertEdge(next, consumeEdge);

  const dlq = addNode(next, "queue", {
    x: (producer.position?.x ?? 0) + 260,
    y: (producer.position?.y ?? 0) + 140,
  }, `${name}-dlq`);
  next = dlq.system;

  return {
    system: next,
    plan: [
      {
        action: `Create the queue and its dead-letter queue`,
        command: `wrangler queues create ${name} && wrangler queues create ${name}-dlq`,
        why: "Both Workers reference the queue by name; neither will deploy until it exists.",
      },
      {
        action: `Deploy ${consumer.name} with the consumer configuration`,
        command: `wrangler deploy --config ${consumer.name}/wrangler.jsonc`,
        why: "The consumer must be draining before anything produces. Deploy it second and the queue simply sits empty; deploy it last and messages pile up behind a handler that does not exist yet.",
      },
      {
        action: `Deploy ${producer.name} with the queue binding, and the service binding removed`,
        command: `wrangler deploy --config ${producer.name}/wrangler.jsonc`,
        why: "Last, because this is the step that starts the traffic flowing.",
      },
      {
        action: `Move ${producer.name}'s call site from env.${edge.bindingName ?? "SERVICE"} to the queue send`,
        why: "The refactor changes the topology; the call in the code is still synchronous until someone changes it. Nothing here does that for you.",
      },
    ],
  };
}

/**
 * Rename a Worker.
 *
 * Innocuous-looking, and the one most likely to cause an outage: a Worker's
 * name is how every service binding finds it, and the name is also what the
 * platform keys the deployed script on.
 */
export function renameWorker(
  system: SystemModel,
  workerNodeId: string,
  newName: string,
): RefactorResult {
  const worker = system.nodes.find((n) => n.id === workerNodeId);
  if (!worker || worker.kind !== "worker") {
    return { system, plan: [], rejected: "That is not a Worker." };
  }
  if (system.nodes.some((n) => n.kind === "worker" && n.name === newName)) {
    return { system, plan: [], rejected: `A Worker called ${newName} already exists.` };
  }

  const oldName = worker.name;
  const callers = system.edges
    .filter((e) => e.to === workerNodeId && (e.kind === "service" || e.kind === "tail"))
    .map((e) => system.nodes.find((n) => n.id === e.from))
    .filter((n): n is NonNullable<typeof n> => Boolean(n));

  const next: SystemModel = {
    ...system,
    nodes: system.nodes.map((n) =>
      n.id === workerNodeId
        ? { ...n, name: newName, nameIsFallback: false }
        : // Durable Object classes record the script that defines them.
          n.scriptName === oldName
          ? { ...n, scriptName: newName }
          : n,
    ),
  };

  const plan: DeployStep[] = [
    {
      action: `Deploy the Worker under its new name, ${newName}`,
      command: `wrangler deploy --config ${newName}/wrangler.jsonc`,
      why: "Both names exist on the account at this point. That overlap is the whole point — it is what makes the change reversible.",
    },
  ];

  if (callers.length > 0) {
    plan.push({
      action: `Update and deploy the ${callers.length} Worker(s) that bind to it: ${callers
        .map((c) => c.name)
        .join(", ")}`,
      command: callers
        .map((c) => `wrangler deploy --config ${c.name}/wrangler.jsonc`)
        .join("\n"),
      why: `Every service binding names ${oldName} as a string. Until each caller is redeployed it is still resolving the old name — which is fine, because the old name is still there.`,
    });
  }

  plan.push({
    action: `Delete the old Worker`,
    command: `wrangler delete --name ${oldName}`,
    why: `Last, and only once no caller resolves it. Deleting first is the version of this refactor that takes production down.`,
  });

  if (worker.worker?.migrations?.length) {
    plan.push({
      action: "Check the Durable Object migrations before deploying",
      why: `${oldName} defines Durable Object classes. The renamed script keeps its migration history, but a DO namespace is keyed on the script — confirm against the docs that this rename preserves your objects before running any of this on data you care about.`,
    });
  }

  return { system: next, plan };
}

/**
 * Pull some of a Worker's bindings out into a new Worker behind a service call.
 *
 * The usual reason: one Worker has accumulated two jobs, and the bindings make
 * that obvious before the code does.
 */
export function extractWorker(
  system: SystemModel,
  workerNodeId: string,
  edgeIds: string[],
  newName: string,
): RefactorResult {
  const source = system.nodes.find((n) => n.id === workerNodeId);
  if (!source || source.kind !== "worker") {
    return { system, plan: [], rejected: "That is not a Worker." };
  }
  if (system.nodes.some((n) => n.kind === "worker" && n.name === newName)) {
    return { system, plan: [], rejected: `A Worker called ${newName} already exists.` };
  }

  const moving = outgoing(system, workerNodeId).filter((e) => edgeIds.includes(e.id));
  if (moving.length === 0) {
    return { system, plan: [], rejected: "Select at least one binding to move." };
  }

  const created = addNode(system, "worker", {
    x: (source.position?.x ?? 0) + 300,
    y: (source.position?.y ?? 0) + 160,
  }, newName);
  let next = created.system;

  for (const edge of moving) {
    next = removeEdge(next, edge.id);
    const moved = connect(next, created.node.id, edge.to, edge.bindingName);
    if (moved.rejected) return { system, plan: [], rejected: moved.rejected };
    next = moved.system;
  }

  const link = connect(next, workerNodeId, created.node.id, suggestBindingName(newName));
  if (link.rejected) return { system, plan: [], rejected: link.rejected };
  next = link.system;

  return {
    system: next,
    plan: [
      {
        action: `Deploy ${newName} with the moved bindings`,
        command: `wrangler deploy --config ${newName}/wrangler.jsonc`,
        why: "A service binding cannot resolve a Worker that has not been deployed, so the target has to exist before anything points at it.",
      },
      {
        action: `Deploy ${source.name} with the service binding and without the moved bindings`,
        command: `wrangler deploy --config ${source.name}/wrangler.jsonc`,
        why: "Second. Between the two deploys the moved resources are bound by both Workers, which is harmless — dropping them from the source first would leave a window where nothing can reach them.",
      },
      {
        action: `Move the corresponding code out of ${source.name} and behind env.${suggestBindingName(newName)}`,
        why: "The bindings have moved; the logic has not. Until it does, the source Worker holds a binding it no longer uses and the new Worker has bindings nothing calls.",
      },
    ],
  };
}
