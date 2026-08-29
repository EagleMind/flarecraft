import {
  danglingEdges,
  findCycles,
  orphanNodes,
  type Edge,
  type Node,
  type SystemModel,
} from "@flarecraft/model";
import { canAssertLimit, limitFor, LIMITS, PRIMITIVES } from "@flarecraft/catalog";
import type { Finding, Rule, RuleContext } from "./types.js";

const workers = (system: SystemModel): Node[] =>
  system.nodes.filter((n) => n.kind === "worker");

const label = (node: Node | undefined, fallback: string): string =>
  node?.name ?? fallback;

/**
 * Service bindings that loop.
 *
 * The dashboard cannot show you this at all: it stores bindings in one
 * direction, so nothing in the UI can tell you that B eventually calls A back.
 * At runtime the loop recurses until it trips the subrequest ceiling.
 */
const serviceCycles: Rule = {
  id: "service-binding-cycle",
  title: "Service bindings form a loop",
  run: ({ system }) => {
    const cycles = findCycles(system, new Set<Edge["kind"]>(["service"]));
    return cycles.map((cycle) => {
      const names = cycle.map((id) => label(system.nodes.find((n) => n.id === id), id));
      return {
        rule: "service-binding-cycle",
        severity: "error" as const,
        message: `Service bindings loop: ${names.join(" → ")}.`,
        remedy:
          "A request entering this loop recurses until it exhausts the subrequest limit. Break the cycle, or move the shared work into a queue so the call does not have to return.",
        nodeId: cycle[0] ?? "",
        docs: "https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/",
      };
    });
  },
};

/**
 * A queue consumer that batches heavily and then makes a call per message.
 *
 * This is arithmetic the platform will do for you at 3am: `max_batch_size`
 * messages, each costing at least one subrequest through the consumer's own
 * bindings, against a hard per-invocation ceiling.
 */
const queueBatchSubrequests: Rule = {
  id: "queue-batch-subrequests",
  title: "Queue batch size exceeds the subrequest budget",
  run: ({ system, plan }) => {
    const ceiling = limitFor("subrequests", plan);
    if (!ceiling) return [];

    const findings: Finding[] = [];
    for (const edge of system.edges) {
      if (edge.kind !== "queue_consumer") continue;
      const batch = edge.consumer?.maxBatchSize;
      if (!batch) continue;

      // Each binding the consumer holds is at least one call per message.
      const perMessage = system.edges.filter(
        (e) => e.from === edge.to && e.kind !== "trigger",
      ).length;
      if (perMessage === 0) continue;

      const estimate = batch * perMessage;
      if (estimate <= ceiling) continue;

      const consumer = system.nodes.find((n) => n.id === edge.to);
      findings.push({
        rule: "queue-batch-subrequests",
        severity: canAssertLimit("subrequests") ? "error" : "warning",
        message: `${label(consumer, edge.to)} batches up to ${batch} messages and holds ${perMessage} binding(s) — roughly ${estimate} subrequests against a ceiling of ${ceiling}.`,
        remedy: `Lower max_batch_size to ${Math.max(1, Math.floor(ceiling / perMessage))} or below, or fan the per-message work out to another Worker.`,
        edgeId: edge.id,
        docs: LIMITS["subrequests"]?.docs ?? "",
      });
    }
    return findings;
  },
};

/** A queue with no dead-letter path silently drops poison messages. */
const missingDeadLetterQueue: Rule = {
  id: "queue-no-dlq",
  title: "Queue has no dead-letter queue",
  run: ({ system }) =>
    system.edges
      .filter((e) => e.kind === "queue_consumer" && !e.consumer?.deadLetterQueue)
      .map((edge) => {
        const queue = system.nodes.find((n) => n.id === edge.from);
        return {
          rule: "queue-no-dlq",
          severity: "warning" as const,
          message: `${label(queue, edge.from)} has no dead-letter queue.`,
          remedy:
            "A message that fails every retry is dropped and nobody finds out. Set dead_letter_queue on the consumer so failures are inspectable.",
          nodeId: edge.from,
          edgeId: edge.id,
          docs: "https://developers.cloudflare.com/queues/configuration/dead-letter-queues/",
        };
      }),
};

/**
 * A Durable Object class bound but never introduced by a migration.
 *
 * This is a deploy-time failure, not a runtime one — wrangler refuses the
 * upload. It is worth catching on the canvas because the binding looks
 * perfectly correct right up until you try to ship it.
 */
const durableObjectWithoutMigration: Rule = {
  id: "durable-object-no-migration",
  title: "Durable Object class has no migration",
  run: ({ system }) => {
    const findings: Finding[] = [];

    for (const node of system.nodes) {
      if (node.kind !== "durable_object" || !node.scriptName) continue;
      // Only classes defined by a Worker we can actually see: a class owned by
      // a script outside this system carries its migration over there.
      const owner = system.nodes.find(
        (n) => n.kind === "worker" && n.name === node.scriptName,
      );
      if (!owner?.configPath) continue;

      const declared = (owner.worker?.migrations ?? []).some((migration) => {
        const introduced = [
          ...(migration.new_classes ?? []),
          ...(migration.new_sqlite_classes ?? []),
          ...(migration.renamed_classes ?? []).map((r) => r.to),
        ];
        return introduced.includes(node.name);
      });
      if (declared) continue;

      findings.push({
        rule: "durable-object-no-migration",
        severity: "error",
        message: `${node.name} is bound but no migration in ${owner.name} introduces it.`,
        remedy: `Add a migration with new_sqlite_classes: ["${node.name}"]. Without it wrangler will refuse the deploy.`,
        nodeId: node.id,
        docs: "https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/",
      });
    }
    return findings;
  },
};

/**
 * Credential-shaped values sitting in `vars`.
 *
 * `vars` are plaintext: they ship inside the deployed Worker and are readable
 * in the dashboard. This rule exists because the first real config corpus this
 * project was tested against contained a live API token in exactly this place.
 */
const CREDENTIAL_PREFIXES = [
  /^cfut_/i, // Cloudflare user token
  /^cfpat_/i, // Cloudflare PAT
  /^sk-ant-/i,
  /^sk-[A-Za-z0-9]{16,}/,
  /^gh[pousr]_/,
  /^xox[baprs]-/,
  /^AKIA[0-9A-Z]{12,}/,
  /^eyJ[A-Za-z0-9_-]{10,}\./, // a JWT
];

const SECRET_NAME = /(token|secret|key|password|passwd|credential|auth)/i;

/** Obvious stand-ins, so a template does not light the whole panel up red. */
const PLACEHOLDER = /(example|your[-_ ]?|xxx+|changeme|placeholder|redacted|<.*>|\.\.\.)/i;

const secretsInVars: Rule = {
  id: "credential-in-vars",
  title: "Credential-shaped value in vars",
  run: ({ system }) => {
    const findings: Finding[] = [];

    for (const worker of workers(system)) {
      // The default block, then every environment overlay. A token in
      // env.production.vars is the more dangerous case, not the lesser one.
      const scopes: [string, Record<string, unknown>][] = [
        ["vars", worker.worker?.vars ?? {}],
        ...Object.entries(worker.worker?.environmentVars ?? {}).map(
          ([env, vars]) => [`env.${env}.vars`, vars] as [string, Record<string, unknown>],
        ),
      ];

      for (const [scope, vars] of scopes) {
        for (const [name, raw] of Object.entries(vars)) {
          if (typeof raw !== "string" || PLACEHOLDER.test(raw)) continue;

          const looksLikeCredential = CREDENTIAL_PREFIXES.some((p) => p.test(raw));
          const namedLikeCredential = SECRET_NAME.test(name) && raw.length >= 20;
          if (!looksLikeCredential && !namedLikeCredential) continue;

          findings.push({
            rule: "credential-in-vars",
            severity: "error",
            message: `${worker.name} declares ${name} in ${scope}, and its value looks like a credential.`,
            remedy: `vars are plaintext — they deploy as-is and are readable in the dashboard. Move it with \`wrangler secret put ${name}\`, and rotate the current value, since anything committed should be treated as exposed.`,
            nodeId: worker.id,
            docs: "https://developers.cloudflare.com/workers/configuration/secrets/",
          });
        }
      }
    }
    return findings;
  },
};

/**
 * Two crons on the same schedule whose Workers write to the same resource.
 *
 * Cron runs are not mutually exclusive, and neither is a pair of them. Same
 * minute, same D1 table, no coordination.
 */
const cronCollision: Rule = {
  id: "cron-collision",
  title: "Crons collide on a shared resource",
  run: ({ system }) => {
    const findings: Finding[] = [];
    const byExpression = new Map<string, string[]>();

    for (const cron of system.nodes.filter((n) => n.kind === "cron")) {
      const targets = system.edges.filter((e) => e.from === cron.id).map((e) => e.to);
      const list = byExpression.get(cron.name) ?? [];
      list.push(...targets);
      byExpression.set(cron.name, list);
    }

    for (const [expression, targets] of byExpression) {
      if (targets.length < 2) continue;

      const shared = new Map<string, number>();
      for (const workerId of new Set(targets)) {
        for (const edge of system.edges.filter(
          (e) => e.from === workerId && e.kind === "binding",
        )) {
          shared.set(edge.to, (shared.get(edge.to) ?? 0) + 1);
        }
      }

      for (const [resourceId, count] of shared) {
        if (count < 2) continue;
        const resource = system.nodes.find((n) => n.id === resourceId);
        findings.push({
          rule: "cron-collision",
          severity: "warning",
          message: `Two Workers run on "${expression}" and both write to ${label(resource, resourceId)}.`,
          remedy:
            "Nothing serialises cron runs. Stagger the schedules, or coordinate through a Durable Object if the writes must not interleave.",
          nodeId: resourceId,
          docs: "https://developers.cloudflare.com/workers/configuration/cron-triggers/",
        });
      }
    }
    return findings;
  },
};

/** Resources nothing points at. On a scanned account these are usually bills. */
const orphanedResources: Rule = {
  id: "orphan-resource",
  title: "Resource is not wired to anything",
  run: ({ system }) =>
    orphanNodes(system)
      .filter((n) => n.kind !== "worker" && PRIMITIVES[n.kind]?.category !== "ingress")
      .map((node) => ({
        rule: "orphan-resource",
        severity: "info" as const,
        message: `${node.name} (${PRIMITIVES[node.kind]?.label ?? node.kind}) is not bound to any Worker.`,
        remedy:
          "Either it is left over from a Worker that no longer exists — in which case it may still be costing money — or something binds it that this scan could not see.",
        nodeId: node.id,
      })),
};

/** An edge whose endpoints do not both exist. */
const danglingBindings: Rule = {
  id: "dangling-binding",
  title: "Binding points at something that does not exist",
  run: ({ system }) =>
    danglingEdges(system).map((edge) => ({
      rule: "dangling-binding",
      severity: "error" as const,
      message: `A ${edge.kind} edge references a node that is not in this system${
        edge.bindingName ? ` (env.${edge.bindingName})` : ""
      }.`,
      remedy:
        "Usually a service binding naming a Worker that was renamed or deleted. At runtime the binding is simply absent.",
      edgeId: edge.id,
    })),
};

const STALE_AFTER_DAYS = 365;

const compatibilityDate: Rule = {
  id: "compatibility-date",
  title: "Missing or stale compatibility date",
  run: ({ system }) => {
    const findings: Finding[] = [];
    const now = Date.now();

    for (const worker of workers(system)) {
      // Only Workers we parsed from config: the account API does not report a
      // compatibility date for every script, and inventing a finding from a
      // gap in the data is worse than staying quiet.
      if (!worker.configPath) continue;

      const date = worker.worker?.compatibilityDate;
      if (!date) {
        findings.push({
          rule: "compatibility-date",
          severity: "warning",
          message: `${worker.name} has no compatibility_date.`,
          remedy:
            "Runtime behaviour will drift as the platform changes, and the change will look like a bug in your code. Pin it.",
          nodeId: worker.id,
          docs: "https://developers.cloudflare.com/workers/configuration/compatibility-dates/",
        });
        continue;
      }

      const age = (now - Date.parse(date)) / 86_400_000;
      if (Number.isFinite(age) && age > STALE_AFTER_DAYS) {
        findings.push({
          rule: "compatibility-date",
          severity: "info",
          message: `${worker.name} is pinned to ${date}, over a year old.`,
          remedy:
            "Fixes and new runtime APIs are gated behind the date. Bump it and re-test.",
          nodeId: worker.id,
        });
      }
    }
    return findings;
  },
};

const observabilityOff: Rule = {
  id: "observability-off",
  title: "Observability is not enabled",
  run: ({ system }) =>
    workers(system)
      .filter((w) => w.configPath && w.worker?.observability?.enabled !== true)
      .map((worker) => ({
        rule: "observability-off",
        severity: "info" as const,
        message: `${worker.name} does not have observability enabled.`,
        remedy:
          "Without it there are no logs to look at when this Worker misbehaves in production.",
        nodeId: worker.id,
        docs: "https://developers.cloudflare.com/workers/observability/",
      })),
};

export const RULES: Rule[] = [
  serviceCycles,
  secretsInVars,
  durableObjectWithoutMigration,
  danglingBindings,
  queueBatchSubrequests,
  missingDeadLetterQueue,
  cronCollision,
  compatibilityDate,
  observabilityOff,
  orphanedResources,
];

const SEVERITY_ORDER: Record<Finding["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function lint(
  system: SystemModel,
  options: { plan?: RuleContext["plan"] } = {},
): Finding[] {
  const context: RuleContext = { system, plan: options.plan ?? "paid" };
  return RULES.flatMap((rule) => {
    try {
      return rule.run(context);
    } catch {
      // One broken rule must not take the whole panel down with it.
      return [];
    }
  }).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
