/**
 * The TypeScript type each binding has inside a Worker.
 *
 * Kept beside the rest of the catalog rather than in the emitter because it is
 * the same kind of fact as `bindingKey`: a property of the primitive, not of
 * how one particular exporter chooses to write it out.
 *
 * These names come from `@cloudflare/workers-types`, which a generated repo
 * depends on — the emitted `Env` is only useful if it typechecks against the
 * real ambient types.
 */
export const RUNTIME_TYPES: Record<string, string> = {
  kv_namespace: "KVNamespace",
  d1_database: "D1Database",
  r2_bucket: "R2Bucket",
  queue: "Queue",
  durable_object: "DurableObjectNamespace",
  workflow: "Workflow",
  vectorize_index: "VectorizeIndex",
  hyperdrive: "Hyperdrive",
  analytics_engine_dataset: "AnalyticsEngineDataset",
  secrets_store: "SecretsStoreSecret",
  ai: "Ai",
  browser: "Fetcher",
  images: "ImagesBinding",
  dispatch_namespace: "DispatchNamespace",
  mtls_certificate: "Fetcher",
  ratelimit: "RateLimit",
  container: "DurableObjectNamespace",
  // A service binding is a Fetcher unless it names an RPC entrypoint, in which
  // case the emitter widens it — see `envTypeFor`.
  worker: "Fetcher",
  external: "Fetcher",
};

export function runtimeTypeFor(kind: string, entrypoint?: string): string {
  if (kind === "worker" && entrypoint) {
    // The real type is Service<typeof Entrypoint>, but that needs an import
    // from the target Worker's source, which a generated stub cannot have yet.
    return `Service<${entrypoint}>`;
  }
  return RUNTIME_TYPES[kind] ?? "unknown";
}
