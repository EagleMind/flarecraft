import { z } from "zod";
import { QueueConsumerConfigSchema } from "./nodes.js";

/**
 * The structural role of an edge — what it means for the graph, as opposed to
 * which wrangler key it was written under. Lint rules and layout switch on this.
 *
 * - `binding`        Worker reaches out to a resource (KV, D1, R2, AI, a queue it produces to)
 * - `service`        Worker calls another Worker over a service binding / RPC
 * - `queue_consumer` Queue delivers into a Worker — note the direction is INTO the Worker
 * - `trigger`        A cron, route, domain, or email address causes a Worker to run
 * - `tail`           Worker's logs stream into another Worker
 */
export const EDGE_KINDS = [
  "binding",
  "service",
  "queue_consumer",
  "trigger",
  "tail",
] as const;

export const EdgeKindSchema = z.enum(EDGE_KINDS);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

/**
 * The wrangler config key this edge was read from, kept so the emitter can put
 * it back where it came from. `kind` is the semantics; `bindingType` is the syntax.
 */
export const BINDING_TYPES = [
  "kv_namespaces",
  "d1_databases",
  "r2_buckets",
  "queues.producers",
  "queues.consumers",
  "durable_objects.bindings",
  "services",
  "workflows",
  "vectorize",
  "hyperdrive",
  "analytics_engine_datasets",
  "ai",
  "browser",
  "images",
  "mtls_certificates",
  "dispatch_namespaces",
  "send_email",
  "ratelimits",
  "containers",
  "pipelines",
  "secrets_store_secrets",
  "tail_consumers",
  "triggers.crons",
  "routes",
] as const;

export const BindingTypeSchema = z.enum(BINDING_TYPES);
export type BindingType = z.infer<typeof BindingTypeSchema>;

export const EdgeSchema = z.object({
  id: z.string(),
  /** Source node id. For `queue_consumer` and `trigger` this is the queue/cron. */
  from: z.string(),
  /** Target node id. */
  to: z.string(),
  kind: EdgeKindSchema,
  bindingType: BindingTypeSchema.optional(),

  /**
   * The environment variable the binding is exposed as inside the Worker
   * (`env.ORDERS_QUEUE`). Absent for triggers, which have no binding name.
   */
  bindingName: z.string().optional(),

  /** Named RPC entrypoint on a service binding, when not the default export. */
  entrypoint: z.string().optional(),

  /** Populated on `queue_consumer` edges; feeds the batch-size lint rules. */
  consumer: QueueConsumerConfigSchema.optional(),

  /** Preserved verbatim for lossless emit, same contract as `Node.raw`. */
  raw: z.record(z.string(), z.unknown()).optional(),

  /**
   * Binding-entry fields edited on the canvas — `delivery_delay` on a queue
   * producer, `migrations_dir` on a D1 binding. Applied over `raw` at emit,
   * so a partial edit does not drop the fields it did not touch.
   *
   * These belong to the edge rather than the node because the same resource
   * bound by two Workers can legitimately carry different settings in each.
   */
  config: z.record(z.string(), z.unknown()).optional(),

  meta: z.record(z.string(), z.unknown()).default({}),
});
export type Edge = z.infer<typeof EdgeSchema>;
