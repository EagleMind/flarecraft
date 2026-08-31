import { z } from "zod";

/**
 * Every distinct thing that can appear on the canvas.
 *
 * Deliberately NOT included: `assets`, `version_metadata`, `vars`. Those are
 * properties of a Worker rather than things a Worker talks to, and drawing them
 * as nodes turns every diagram into noise. They live in `WorkerConfig` instead.
 */
export const NODE_KINDS = [
  // compute
  "worker",
  "durable_object",
  "workflow",
  "container",
  // storage
  "kv_namespace",
  "d1_database",
  "r2_bucket",
  "vectorize_index",
  "hyperdrive",
  "analytics_engine_dataset",
  "secrets_store",
  // messaging
  "queue",
  // ingress — things that cause a Worker to run
  "route",
  "custom_domain",
  "cron",
  "email_route",
  // platform services the Worker calls out to
  "ai",
  "browser",
  "images",
  "dispatch_namespace",
  "mtls_certificate",
  "ratelimit",
  // anything outside Cloudflare: a Postgres box, a third-party API
  "external",
] as const;

export const NodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof NodeKindSchema>;

/**
 * Where this node came from. Drives the drift diff in Phase 7: a node present
 * with provenance "account" but absent from "repo" is deployed-but-untracked.
 */
export const ProvenanceSchema = z.enum(["account", "repo", "design"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const PositionSchema = z.object({ x: z.number(), y: z.number() });
export type Position = z.infer<typeof PositionSchema>;

/** Durable Object migration entries, preserved so class renames survive a round-trip. */
export const MigrationSchema = z.object({
  tag: z.string(),
  new_classes: z.array(z.string()).optional(),
  new_sqlite_classes: z.array(z.string()).optional(),
  renamed_classes: z
    .array(z.object({ from: z.string(), to: z.string() }))
    .optional(),
  deleted_classes: z.array(z.string()).optional(),
});
export type Migration = z.infer<typeof MigrationSchema>;

export const AssetsConfigSchema = z.object({
  binding: z.string().optional(),
  directory: z.string().optional(),
  not_found_handling: z.string().optional(),
  run_worker_first: z.union([z.boolean(), z.array(z.string())]).optional(),
});

export const ObservabilityConfigSchema = z.object({
  enabled: z.boolean().optional(),
  head_sampling_rate: z.number().optional(),
  logs: z.record(z.string(), z.unknown()).optional(),
  traces: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The Worker-specific settings we model explicitly. Anything else in the source
 * config is preserved verbatim on `BaseNode.raw` — see the note there.
 */
export const WorkerConfigSchema = z.object({
  main: z.string().optional(),
  compatibilityDate: z.string().optional(),
  compatibilityFlags: z.array(z.string()).default([]),
  observability: ObservabilityConfigSchema.optional(),
  assets: AssetsConfigSchema.optional(),
  migrations: z.array(MigrationSchema).default([]),
  vars: z.record(z.string(), z.unknown()).default({}),
  /**
   * vars declared under `env.<name>`, kept so lint rules can see them.
   *
   * Without this a secret in `env.production.vars` is invisible to every rule,
   * which is exactly backwards: the production overlay is the one that matters.
   */
  environmentVars: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .default({}),
  /** Declared secret names. Values are never read, stored, or transmitted. */
  secrets: z.array(z.string()).default([]),
  placement: z.record(z.string(), z.unknown()).optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
  workersDev: z.boolean().optional(),
  /** Config-file environment this Worker was defined under, e.g. `env.staging`. */
  environment: z.string().optional(),
});
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

/** Queue consumer settings, needed by the batch-size × subrequest lint rule. */
export const QueueConsumerConfigSchema = z.object({
  maxBatchSize: z.number().optional(),
  maxBatchTimeout: z.number().optional(),
  maxRetries: z.number().optional(),
  maxConcurrency: z.number().optional(),
  deadLetterQueue: z.string().optional(),
  retryDelay: z.number().optional(),
});
export type QueueConsumerConfig = z.infer<typeof QueueConsumerConfigSchema>;

export const NodeSchema = z.object({
  /** Stable and derivable from kind + identity — see `nodeId()` in ids.ts. */
  id: z.string(),
  kind: NodeKindSchema,
  /** Display name: the Worker name, bucket name, DO class name, cron expression. */
  name: z.string(),
  /**
   * True when `name` is a stand-in (usually the binding variable) because the
   * source had no real title. Merge precedence uses this so a config parse
   * cannot overwrite a resource title the account scan already resolved.
   */
  nameIsFallback: z.boolean().optional(),
  provenance: ProvenanceSchema,
  position: PositionSchema.optional(),

  /** Cloudflare-side identifier where one exists: D1 database_id, KV namespace id. */
  resourceId: z.string().optional(),
  /** Absolute path of the wrangler config this came from, when parsed from disk. */
  configPath: z.string().optional(),

  worker: WorkerConfigSchema.optional(),
  /** For `durable_object` nodes: the Worker script that defines the class. */
  scriptName: z.string().optional(),

  /**
   * The untouched source config object. The emitter writes back what it
   * understands from the typed fields and passes everything else through from
   * here, which is what makes the model → config → model round-trip lossless
   * without having to model all of wrangler's surface area up front.
   */
  raw: z.record(z.string(), z.unknown()).optional(),

  /**
   * The group this element belongs to, when the canvas has organised it.
   *
   * Local metadata only: Cloudflare has no concept of a group, so this never
   * round-trips to the account. It exists so a scattered account can be sorted
   * into systems before those systems are pulled into folders.
   */
  groupId: z.string().optional(),

  /**
   * Resource-level settings edited on the canvas — a route's pattern, a cron
   * expression. Kept apart from `raw` so an edit is distinguishable from what
   * was parsed, and so a re-scan cannot silently revert it.
   */
  config: z.record(z.string(), z.unknown()).optional(),

  meta: z.record(z.string(), z.unknown()).default({}),
});
export type Node = z.infer<typeof NodeSchema>;

const COMPUTE_KINDS = new Set<NodeKind>([
  "worker",
  "durable_object",
  "workflow",
  "container",
]);
const INGRESS_KINDS = new Set<NodeKind>([
  "route",
  "custom_domain",
  "cron",
  "email_route",
]);
const STORAGE_KINDS = new Set<NodeKind>([
  "kv_namespace",
  "d1_database",
  "r2_bucket",
  "vectorize_index",
  "hyperdrive",
  "analytics_engine_dataset",
  "secrets_store",
]);

export const isCompute = (k: NodeKind): boolean => COMPUTE_KINDS.has(k);
export const isIngress = (k: NodeKind): boolean => INGRESS_KINDS.has(k);
export const isStorage = (k: NodeKind): boolean => STORAGE_KINDS.has(k);
