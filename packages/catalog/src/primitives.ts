/**
 * Structured metadata for every Cloudflare primitive flarecraft can draw.
 *
 * This file is the single grounding source for three separate features, which
 * is the whole reason it exists as data rather than being spread across the UI:
 *   1. canvas rendering  — category drives palette grouping and node styling
 *   2. emit              — `bindingKey` says which wrangler key to write under
 *   3. design assist     — `chooseWhen` / `avoidWhen` are fed to the model so it
 *                          cannot invent primitives or misstate their tradeoffs
 */

export type PrimitiveCategory =
  | "compute"
  | "storage"
  | "messaging"
  | "ingress"
  | "service"
  | "external";

export type ConsistencyModel =
  | "strong"
  | "eventual"
  | "serialized-per-object"
  | "none";

export interface PrimitiveSpec {
  kind: string;
  label: string;
  category: PrimitiveCategory;
  /** One line, shown in the palette and on hover. */
  summary: string;
  /** wrangler config key this is declared under, when it is a binding target. */
  bindingKey?: string;
  /** Does this need a Cloudflare-side id before its config is valid? */
  requiresResourceId: boolean;
  /** The `wrangler ... create` command that provisions it, for provision.sh. */
  createCommand?: string;
  consistency: ConsistencyModel;
  chooseWhen: string[];
  avoidWhen: string[];
  /** Primitives solving a similar problem — drives "we rejected X because". */
  alternatives: string[];
  docs: string;
}

export const PRIMITIVES: Record<string, PrimitiveSpec> = {
  worker: {
    kind: "worker",
    label: "Worker",
    category: "compute",
    summary: "Stateless request handler running on the edge.",
    requiresResourceId: false,
    consistency: "none",
    chooseWhen: [
      "Handling HTTP requests",
      "Stateless transformation or routing",
    ],
    avoidWhen: [
      "You need to coordinate concurrent writers — a Worker has no identity between requests",
      "Work must outlive the request lifetime",
    ],
    alternatives: ["durable_object", "workflow", "container"],
    docs: "https://developers.cloudflare.com/workers/",
  },

  durable_object: {
    kind: "durable_object",
    label: "Durable Object",
    category: "compute",
    summary:
      "Single-threaded stateful actor, addressable by id, with its own SQLite.",
    bindingKey: "durable_objects.bindings",
    requiresResourceId: false,
    consistency: "serialized-per-object",
    chooseWhen: [
      "Writes to one entity must be serialized (bookings, counters, game rooms)",
      "You need a coordination point with a stable address",
      "WebSocket connections need somewhere to live",
    ],
    avoidWhen: [
      "There is only ever one instance — that makes it a global bottleneck, since every request serializes through a single object",
      "Data is read far more than written and staleness is acceptable; KV is cheaper",
    ],
    alternatives: ["kv_namespace", "d1_database"],
    docs: "https://developers.cloudflare.com/durable-objects/",
  },

  workflow: {
    kind: "workflow",
    label: "Workflow",
    category: "compute",
    summary: "Durable multi-step execution that survives failures and restarts.",
    bindingKey: "workflows",
    requiresResourceId: false,
    consistency: "strong",
    chooseWhen: [
      "A multi-step process must complete even if steps fail hours apart",
      "You need retries and state checkpointing between steps",
    ],
    avoidWhen: [
      "The work is a single fast step — orchestration overhead is not free",
    ],
    alternatives: ["queue", "cron"],
    docs: "https://developers.cloudflare.com/workflows/",
  },

  container: {
    kind: "container",
    label: "Container",
    category: "compute",
    summary: "Full container runtime for work that cannot run on workerd.",
    bindingKey: "containers",
    requiresResourceId: false,
    consistency: "none",
    chooseWhen: [
      "You need a native binary, a real filesystem, or an unsupported runtime",
      "Long-running compute that exceeds Worker CPU limits",
    ],
    avoidWhen: [
      "The work runs fine on workerd — containers cost far more and start slower",
    ],
    alternatives: ["worker"],
    docs: "https://developers.cloudflare.com/containers/",
  },

  kv_namespace: {
    kind: "kv_namespace",
    label: "KV Namespace",
    category: "storage",
    summary: "Eventually consistent global key-value store, read-optimized.",
    bindingKey: "kv_namespaces",
    requiresResourceId: true,
    createCommand: "wrangler kv namespace create",
    consistency: "eventual",
    chooseWhen: [
      "Read-heavy config, feature flags, cached content",
      "Global low-latency reads matter more than write freshness",
    ],
    avoidWhen: [
      "You need read-after-write consistency — writes take time to propagate globally",
      "You are using it to coordinate concurrent writers; it cannot do that safely",
    ],
    alternatives: ["d1_database", "durable_object", "r2_bucket"],
    docs: "https://developers.cloudflare.com/kv/",
  },

  d1_database: {
    kind: "d1_database",
    label: "D1 Database",
    category: "storage",
    summary: "Serverless SQLite with SQL queries and read replication.",
    bindingKey: "d1_databases",
    requiresResourceId: true,
    createCommand: "wrangler d1 create",
    consistency: "strong",
    chooseWhen: [
      "Relational queries, joins, aggregate reporting",
      "One shared dataset queried many different ways",
    ],
    avoidWhen: [
      "Per-entity write throughput is high — a single database serializes writes",
      "Queries scan unindexed columns; D1 bills rows read, so a full scan is charged on every request",
    ],
    alternatives: ["durable_object", "kv_namespace", "hyperdrive"],
    docs: "https://developers.cloudflare.com/d1/",
  },

  r2_bucket: {
    kind: "r2_bucket",
    label: "R2 Bucket",
    category: "storage",
    summary: "S3-compatible object storage with no egress fees.",
    bindingKey: "r2_buckets",
    requiresResourceId: false,
    createCommand: "wrangler r2 bucket create",
    consistency: "strong",
    chooseWhen: [
      "Files, images, video, backups, large blobs",
      "Serving user uploads",
    ],
    avoidWhen: [
      "Values are small and read constantly — KV is cheaper and faster for that",
    ],
    alternatives: ["kv_namespace"],
    docs: "https://developers.cloudflare.com/r2/",
  },

  vectorize_index: {
    kind: "vectorize_index",
    label: "Vectorize Index",
    category: "storage",
    summary: "Vector database for embeddings and similarity search.",
    bindingKey: "vectorize",
    requiresResourceId: false,
    createCommand: "wrangler vectorize create",
    consistency: "eventual",
    chooseWhen: ["Semantic search, RAG retrieval, recommendations"],
    avoidWhen: ["Exact-match lookup would do — that is a KV or D1 job"],
    alternatives: ["d1_database"],
    docs: "https://developers.cloudflare.com/vectorize/",
  },

  hyperdrive: {
    kind: "hyperdrive",
    label: "Hyperdrive",
    category: "storage",
    summary:
      "Connection pooling and caching in front of an external SQL database.",
    bindingKey: "hyperdrive",
    requiresResourceId: true,
    createCommand: "wrangler hyperdrive create",
    consistency: "strong",
    chooseWhen: [
      "You already have Postgres or MySQL elsewhere and need it reachable from Workers",
      "Connection exhaustion from many isolates is the problem",
    ],
    avoidWhen: ["Greenfield storage with no existing database to reach"],
    alternatives: ["d1_database"],
    docs: "https://developers.cloudflare.com/hyperdrive/",
  },

  analytics_engine_dataset: {
    kind: "analytics_engine_dataset",
    label: "Analytics Engine",
    category: "storage",
    summary: "High-cardinality time-series event writes, queried with SQL.",
    bindingKey: "analytics_engine_datasets",
    requiresResourceId: false,
    consistency: "eventual",
    chooseWhen: ["Custom metrics and per-event telemetry at high volume"],
    avoidWhen: ["You need to read individual records back transactionally"],
    alternatives: ["d1_database"],
    docs: "https://developers.cloudflare.com/analytics/analytics-engine/",
  },

  secrets_store: {
    kind: "secrets_store",
    label: "Secrets Store",
    category: "storage",
    summary: "Account-level secret storage bound into Workers.",
    bindingKey: "secrets_store_secrets",
    requiresResourceId: true,
    consistency: "strong",
    chooseWhen: ["A secret is shared across several Workers"],
    avoidWhen: [
      "The secret belongs to exactly one Worker — a plain secret is simpler",
    ],
    alternatives: [],
    docs: "https://developers.cloudflare.com/secrets-store/",
  },

  queue: {
    kind: "queue",
    label: "Queue",
    category: "messaging",
    summary: "Guaranteed-delivery message queue with batching and retries.",
    bindingKey: "queues.producers",
    requiresResourceId: false,
    createCommand: "wrangler queues create",
    consistency: "eventual",
    chooseWhen: [
      "Decoupling a slow job from the request that triggered it",
      "Smoothing bursts, or you need retry with a dead-letter path",
    ],
    avoidWhen: [
      "The caller needs the result — that is a service binding, not a queue",
      "Steps must run in guaranteed order with checkpointing; use a Workflow",
    ],
    alternatives: ["workflow", "worker"],
    docs: "https://developers.cloudflare.com/queues/",
  },

  route: {
    kind: "route",
    label: "Route",
    category: "ingress",
    summary: "URL pattern on a zone that dispatches to a Worker.",
    bindingKey: "routes",
    requiresResourceId: false,
    consistency: "none",
    chooseWhen: [
      "Attaching a Worker to a path on a domain already on Cloudflare",
    ],
    avoidWhen: [],
    alternatives: ["custom_domain"],
    docs: "https://developers.cloudflare.com/workers/configuration/routing/routes/",
  },

  custom_domain: {
    kind: "custom_domain",
    label: "Custom Domain",
    category: "ingress",
    summary: "Whole hostname pointed at a Worker, with certificates managed.",
    requiresResourceId: false,
    consistency: "none",
    chooseWhen: ["The Worker owns the entire hostname"],
    avoidWhen: ["You only want part of an existing site's path space"],
    alternatives: ["route"],
    docs: "https://developers.cloudflare.com/workers/configuration/routing/custom-domains/",
  },

  cron: {
    kind: "cron",
    label: "Cron Trigger",
    category: "ingress",
    summary: "Scheduled invocation of a Worker's scheduled() handler.",
    bindingKey: "triggers.crons",
    requiresResourceId: false,
    consistency: "none",
    chooseWhen: ["Periodic maintenance, digests, polling an external system"],
    avoidWhen: [
      "The job may run longer than its interval — nothing prevents overlapping runs",
    ],
    alternatives: ["workflow", "queue"],
    docs: "https://developers.cloudflare.com/workers/configuration/cron-triggers/",
  },

  email_route: {
    kind: "email_route",
    label: "Email Route",
    category: "ingress",
    summary: "Inbound address routed into a Worker's email() handler.",
    requiresResourceId: false,
    consistency: "none",
    chooseWhen: ["Processing inbound mail programmatically"],
    avoidWhen: [],
    alternatives: [],
    docs: "https://developers.cloudflare.com/email-routing/",
  },

  ai: {
    kind: "ai",
    label: "Workers AI",
    category: "service",
    summary: "Inference on Cloudflare-hosted models.",
    bindingKey: "ai",
    requiresResourceId: false,
    consistency: "none",
    chooseWhen: ["Inference close to the request, without managing a provider"],
    avoidWhen: ["You need a specific frontier model not in the catalog"],
    alternatives: ["external"],
    docs: "https://developers.cloudflare.com/workers-ai/",
  },

  browser: {
    kind: "browser",
    label: "Browser Rendering",
    category: "service",
    summary: "Headless Chromium driven from a Worker.",
    bindingKey: "browser",
    requiresResourceId: false,
    consistency: "none",
    chooseWhen: ["Screenshots, PDF generation, scraping pages that need JS"],
    avoidWhen: ["A plain fetch would get the same data — this is far pricier"],
    alternatives: ["external"],
    docs: "https://developers.cloudflare.com/browser-rendering/",
  },

  images: {
    kind: "images",
    label: "Images",
    category: "service",
    summary: "Image transformation and optimization binding.",
    bindingKey: "images",
    requiresResourceId: false,
    consistency: "none",
    chooseWhen: ["Resizing or reformatting images on the fly"],
    avoidWhen: [],
    alternatives: ["r2_bucket"],
    docs: "https://developers.cloudflare.com/images/",
  },

  dispatch_namespace: {
    kind: "dispatch_namespace",
    label: "Dispatch Namespace",
    category: "service",
    summary: "Workers for Platforms container holding user-deployed Workers.",
    bindingKey: "dispatch_namespaces",
    requiresResourceId: false,
    consistency: "none",
    chooseWhen: ["You run other people's code as isolated Workers"],
    avoidWhen: [
      "Single-tenant applications — this is the multi-tenant primitive",
    ],
    alternatives: [],
    docs: "https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/",
  },

  mtls_certificate: {
    kind: "mtls_certificate",
    label: "mTLS Certificate",
    category: "service",
    summary: "Client certificate presented on outbound fetches.",
    bindingKey: "mtls_certificates",
    requiresResourceId: true,
    consistency: "none",
    chooseWhen: ["An upstream requires mutual TLS"],
    avoidWhen: [],
    alternatives: [],
    docs: "https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/",
  },

  ratelimit: {
    kind: "ratelimit",
    label: "Rate Limit",
    category: "service",
    summary: "Per-key rate limiter available inside the Worker.",
    bindingKey: "ratelimits",
    requiresResourceId: false,
    consistency: "eventual",
    chooseWhen: ["Throttling abusive callers cheaply, without a Durable Object"],
    avoidWhen: ["Limits must be exact — this is approximate and per-location"],
    alternatives: ["durable_object"],
    docs: "https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/",
  },

  external: {
    kind: "external",
    label: "External Service",
    category: "external",
    summary: "Anything outside Cloudflare: a third-party API, your own origin.",
    requiresResourceId: false,
    consistency: "none",
    chooseWhen: ["Documenting a dependency the topology genuinely has"],
    avoidWhen: [],
    alternatives: [],
    docs: "",
  },
};

export function primitive(kind: string): PrimitiveSpec | undefined {
  return PRIMITIVES[kind];
}

/** Reverse lookup used by the parser: wrangler config key → node kind. */
export const BINDING_KEY_TO_KIND: Record<string, string> = Object.fromEntries(
  Object.values(PRIMITIVES)
    .filter(
      (p): p is PrimitiveSpec & { bindingKey: string } => Boolean(p.bindingKey),
    )
    .map((p) => [p.bindingKey, p.kind]),
);
