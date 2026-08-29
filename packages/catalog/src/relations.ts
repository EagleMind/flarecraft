/**
 * Which edges are legal between which node kinds.
 *
 * This is what makes the canvas better than the dashboard rather than merely
 * prettier: React Flow's `isValidConnection` reads this table, so an
 * architecture that cannot exist on Cloudflare cannot be drawn in the first
 * place. You physically cannot wire a KV namespace into a queue.
 *
 * The asymmetry below is real and worth stating plainly: only Workers originate
 * bindings. A Durable Object or Workflow runs inside a Worker's script and
 * shares its env, so its bindings belong to the defining Worker and DO/Workflow
 * nodes have no outgoing edges of their own. Ingress nodes and queues push
 * INTO Workers, which is why their edges point the way they do.
 */

export type EdgeKind =
  | "binding"
  | "service"
  | "queue_consumer"
  | "trigger"
  | "tail";

export interface Relation {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Does drawing this edge require naming a binding variable? */
  needsBindingName: boolean;
}

/** Everything a Worker can hold a binding to. */
const BINDABLE_TARGETS = [
  "kv_namespace",
  "d1_database",
  "r2_bucket",
  "vectorize_index",
  "hyperdrive",
  "analytics_engine_dataset",
  "secrets_store",
  "queue",
  "durable_object",
  "workflow",
  "container",
  "ai",
  "browser",
  "images",
  "dispatch_namespace",
  "mtls_certificate",
  "ratelimit",
] as const;

const INGRESS_KINDS = ["route", "custom_domain", "cron", "email_route"] as const;

export const RELATIONS: Relation[] = [
  ...BINDABLE_TARGETS.map((to) => ({
    from: "worker",
    to,
    kind: "binding" as const,
    needsBindingName: true,
  })),

  // Worker-to-Worker: a service binding is a call, a tail consumer is a log stream.
  { from: "worker", to: "worker", kind: "service", needsBindingName: true },
  { from: "worker", to: "worker", kind: "tail", needsBindingName: false },

  // A Worker may fetch anything outside Cloudflare; no binding is involved.
  { from: "worker", to: "external", kind: "binding", needsBindingName: false },

  // Delivery INTO a Worker. Note this is a separate edge from the producer
  // binding above — one queue commonly has both, pointing opposite directions.
  { from: "queue", to: "worker", kind: "queue_consumer", needsBindingName: false },

  ...INGRESS_KINDS.map((from) => ({
    from,
    to: "worker",
    kind: "trigger" as const,
    needsBindingName: false,
  })),
];

const RELATION_INDEX = new Map<string, Relation[]>();
for (const r of RELATIONS) {
  const key = `${r.from}->${r.to}`;
  const list = RELATION_INDEX.get(key) ?? [];
  list.push(r);
  RELATION_INDEX.set(key, list);
}

/** Every legal edge between two kinds. Empty means the connection is illegal. */
export function relationsBetween(fromKind: string, toKind: string): Relation[] {
  return RELATION_INDEX.get(`${fromKind}->${toKind}`) ?? [];
}

export function canConnect(fromKind: string, toKind: string): boolean {
  return relationsBetween(fromKind, toKind).length > 0;
}

/**
 * The default edge kind when the user draws a connection. Where two kinds are
 * possible (Worker → Worker is both `service` and `tail`) the first wins and
 * the inspector lets them switch — tail consumers are much rarer than RPC.
 */
export function defaultRelation(
  fromKind: string,
  toKind: string,
): Relation | undefined {
  return relationsBetween(fromKind, toKind)[0];
}

/** Palette filtering: what can this node legally connect to? */
export function legalTargets(fromKind: string): string[] {
  return [...new Set(RELATIONS.filter((r) => r.from === fromKind).map((r) => r.to))];
}

/**
 * Derive a binding variable name from a resource name, matching the convention
 * every Cloudflare example uses: `order-events` becomes `ORDER_EVENTS`.
 */
export function suggestBindingName(resourceName: string): string {
  return (
    resourceName
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toUpperCase()
      .replace(/^_+|_+$/g, "")
      .replace(/_{2,}/g, "_") || "BINDING"
  );
}
