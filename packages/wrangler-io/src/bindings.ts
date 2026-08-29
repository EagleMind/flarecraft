import type { BindingType, NodeKind } from "@flarecraft/model";

/**
 * How to read each binding array out of a wrangler config.
 *
 * Table-driven because the shapes are nearly but not quite uniform — the field
 * holding the binding variable is `binding` almost everywhere, except Durable
 * Objects and rate limits where it is `name`, and the field holding the
 * resource's own name differs for every single primitive. Encoding that as data
 * keeps the parser a loop instead of twenty near-identical branches.
 */
export interface BindingExtractor {
  /** Config key, dotted for nested groups: `queues.producers`. */
  key: string;
  kind: NodeKind;
  bindingType: BindingType;
  /** Entry field holding the env variable name. Default `binding`. */
  bindingNameField?: string;
  /** Entry field holding the resource's human-readable name. */
  nameField?: string;
  /** Entry field holding the Cloudflare-side id. */
  idField?: string;
  /**
   * Entry field naming another Worker that defines this resource. Durable
   * Objects and Workflows can live in a different script, and getting this
   * wrong merges two unrelated classes that happen to share a name.
   */
  scriptField?: string;
  /** Singleton bindings (`ai`, `browser`) are objects, not arrays. */
  singleton?: boolean;
}

export const BINDING_EXTRACTORS: BindingExtractor[] = [
  {
    key: "kv_namespaces",
    kind: "kv_namespace",
    bindingType: "kv_namespaces",
    idField: "id",
  },
  {
    key: "d1_databases",
    kind: "d1_database",
    bindingType: "d1_databases",
    nameField: "database_name",
    idField: "database_id",
  },
  {
    key: "r2_buckets",
    kind: "r2_bucket",
    bindingType: "r2_buckets",
    nameField: "bucket_name",
  },
  {
    key: "vectorize",
    kind: "vectorize_index",
    bindingType: "vectorize",
    nameField: "index_name",
  },
  {
    key: "hyperdrive",
    kind: "hyperdrive",
    bindingType: "hyperdrive",
    idField: "id",
  },
  {
    key: "analytics_engine_datasets",
    kind: "analytics_engine_dataset",
    bindingType: "analytics_engine_datasets",
    nameField: "dataset",
  },
  {
    key: "secrets_store_secrets",
    kind: "secrets_store",
    bindingType: "secrets_store_secrets",
    nameField: "secret_name",
    idField: "store_id",
  },
  {
    key: "mtls_certificates",
    kind: "mtls_certificate",
    bindingType: "mtls_certificates",
    idField: "certificate_id",
  },
  {
    key: "dispatch_namespaces",
    kind: "dispatch_namespace",
    bindingType: "dispatch_namespaces",
    nameField: "namespace",
  },
  {
    key: "workflows",
    kind: "workflow",
    bindingType: "workflows",
    nameField: "name",
    scriptField: "script_name",
  },
  {
    key: "durable_objects.bindings",
    kind: "durable_object",
    bindingType: "durable_objects.bindings",
    bindingNameField: "name",
    nameField: "class_name",
    scriptField: "script_name",
  },
  {
    key: "queues.producers",
    kind: "queue",
    bindingType: "queues.producers",
    nameField: "queue",
  },
  {
    key: "containers",
    kind: "container",
    bindingType: "containers",
    nameField: "class_name",
  },
  {
    key: "ratelimits",
    kind: "ratelimit",
    bindingType: "ratelimits",
    bindingNameField: "name",
    idField: "namespace_id",
  },
  {
    key: "ai",
    kind: "ai",
    bindingType: "ai",
    singleton: true,
  },
  {
    key: "browser",
    kind: "browser",
    bindingType: "browser",
    singleton: true,
  },
  {
    key: "images",
    kind: "images",
    bindingType: "images",
    singleton: true,
  },
];

/** Resolve a dotted key against a config object. */
export function readPath(source: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && part in (acc as object)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, source);
}

/** Singleton bindings such as `ai` get a stable, shared node per account. */
export const SINGLETON_NAMES: Record<string, string> = {
  ai: "Workers AI",
  browser: "Browser Rendering",
  images: "Images",
};
