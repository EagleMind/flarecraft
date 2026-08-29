import type { BindingType, NodeKind } from "@flarecraft/model";

/**
 * Bindings as the API reports them, which is NOT the shape wrangler configs use.
 *
 * The config says `kv_namespaces: [{ binding, id }]`; the settings endpoint says
 * `{ type: "kv_namespace", name, namespace_id }`. Same resource, different field
 * names, different container. This second table is the cost of the account scan
 * and there is no way around it — but both tables land in the same SystemModel,
 * which is the entire point of having a model in the middle.
 *
 * VERIFICATION: these type strings are encoded from the Workers script-settings
 * API and have not yet been confirmed against a live account. Anything the scan
 * does not recognise is preserved as an `unknown-binding` warning rather than
 * dropped silently, so a wrong guess here shows up loudly instead of quietly
 * losing an edge.
 */
export interface ApiBindingMapping {
  /** `type` discriminator on the binding object. */
  apiType: string;
  kind: NodeKind;
  bindingType: BindingType;
  /** Field holding the resource's readable name. */
  nameField?: string;
  /** Field holding the Cloudflare-side id. */
  idField?: string;
  /** Field naming the script that defines the class (DO, Workflow). */
  scriptField?: string;
  /** Edge kind, when it is not a plain `binding`. */
  edgeKind?: "binding" | "service";
}

export const API_BINDINGS: ApiBindingMapping[] = [
  {
    apiType: "kv_namespace",
    kind: "kv_namespace",
    bindingType: "kv_namespaces",
    idField: "namespace_id",
  },
  {
    apiType: "d1",
    kind: "d1_database",
    bindingType: "d1_databases",
    nameField: "name",
    idField: "id",
  },
  {
    apiType: "r2_bucket",
    kind: "r2_bucket",
    bindingType: "r2_buckets",
    nameField: "bucket_name",
  },
  {
    apiType: "queue",
    kind: "queue",
    bindingType: "queues.producers",
    nameField: "queue_name",
  },
  {
    apiType: "durable_object_namespace",
    kind: "durable_object",
    bindingType: "durable_objects.bindings",
    nameField: "class_name",
    idField: "namespace_id",
    scriptField: "script_name",
  },
  {
    apiType: "service",
    kind: "worker",
    bindingType: "services",
    nameField: "service",
    edgeKind: "service",
  },
  {
    apiType: "workflow",
    kind: "workflow",
    bindingType: "workflows",
    nameField: "workflow_name",
    scriptField: "script_name",
  },
  {
    apiType: "vectorize",
    kind: "vectorize_index",
    bindingType: "vectorize",
    nameField: "index_name",
  },
  {
    apiType: "hyperdrive",
    kind: "hyperdrive",
    bindingType: "hyperdrive",
    idField: "id",
  },
  {
    apiType: "analytics_engine",
    kind: "analytics_engine_dataset",
    bindingType: "analytics_engine_datasets",
    nameField: "dataset",
  },
  { apiType: "ai", kind: "ai", bindingType: "ai" },
  { apiType: "browser_rendering", kind: "browser", bindingType: "browser" },
  { apiType: "browser", kind: "browser", bindingType: "browser" },
  { apiType: "images", kind: "images", bindingType: "images" },
  {
    apiType: "mtls_certificate",
    kind: "mtls_certificate",
    bindingType: "mtls_certificates",
    idField: "certificate_id",
  },
  {
    apiType: "dispatch_namespace",
    kind: "dispatch_namespace",
    bindingType: "dispatch_namespaces",
    nameField: "namespace",
  },
  {
    apiType: "ratelimit",
    kind: "ratelimit",
    bindingType: "ratelimits",
    idField: "namespace_id",
  },
  {
    apiType: "secrets_store_secret",
    kind: "secrets_store",
    bindingType: "secrets_store_secrets",
    nameField: "secret_name",
    idField: "store_id",
  },
];

export const API_BINDING_INDEX = new Map(
  API_BINDINGS.map((b) => [b.apiType, b]),
);

/**
 * Binding types that carry no topology and must not become nodes. Modelling a
 * plaintext var as a node would bury the actual architecture under noise.
 */
export const NON_TOPOLOGY_BINDINGS = new Set([
  "plain_text",
  "json",
  "secret_text",
  "secret_key",
  "wasm_module",
  "text_blob",
  "data_blob",
  "version_metadata",
  "assets",
  "inherit",
]);
