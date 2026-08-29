/**
 * The configurable surface of every primitive, taken from Cloudflare's wrangler
 * configuration reference rather than from memory.
 *
 * Two things this drives. The obvious one is the inline config panel: select a
 * node on the canvas and edit its real settings, instead of learning which of
 * wrangler's several hundred keys applies to the thing you clicked.
 *
 * The less obvious one is that every field carries a `help` line saying what it
 * is *for*. The reference tells you `max_batch_timeout` is a number; it does
 * not tell you that raising it trades latency for fewer invocations. That gap
 * is the whole reason a config panel beats reading the docs in another tab.
 */

export type FieldType = "string" | "number" | "boolean" | "enum" | "string[]";

export interface ConfigField {
  /** The wrangler key, exactly as it appears in the config file. */
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Allowed values, for `enum`. */
  options?: string[];
  placeholder?: string;
  /** What it does and when you would touch it. Shown under the input. */
  help: string;
  /** Cloudflare's default, stated so the empty state is not a mystery. */
  defaultHint?: string;
}

export interface ConfigSchema {
  /**
   * Fields on the binding entry — they live in the Worker's config and belong
   * to the *edge*, since the same resource bound by two Workers can carry
   * different settings in each.
   */
  binding: ConfigField[];
  /**
   * Fields describing the resource itself. Node-level: a bucket's jurisdiction
   * is a property of the bucket, not of anyone's binding to it.
   */
  resource: ConfigField[];
}

const BINDING_NAME: ConfigField = {
  key: "binding",
  label: "Binding variable",
  type: "string",
  required: true,
  placeholder: "MY_RESOURCE",
  help: "The name this appears under inside the Worker, as env.NAME. This is what your code will actually reference.",
};

export const CONFIG_SCHEMAS: Record<string, ConfigSchema> = {
  kv_namespace: {
    binding: [
      BINDING_NAME,
      {
        key: "id",
        label: "Namespace ID",
        type: "string",
        required: true,
        placeholder: "0123456789abcdef0123456789abcdef",
        help: "Returned by `wrangler kv namespace create`. A KV config carries no readable title, which is why this id is the only stable way to identify the namespace.",
      },
      {
        key: "preview_id",
        label: "Preview namespace ID",
        type: "string",
        help: "A separate namespace used by `wrangler dev`, so local runs cannot write over production data.",
      },
    ],
    resource: [],
  },

  d1_database: {
    binding: [
      BINDING_NAME,
      {
        key: "database_name",
        label: "Database name",
        type: "string",
        required: true,
        help: "The human-readable name you created the database with.",
      },
      {
        key: "database_id",
        label: "Database ID",
        type: "string",
        required: true,
        help: "Returned by `wrangler d1 create`. This is what actually binds; the name is for you.",
      },
      {
        key: "preview_database_id",
        label: "Preview database ID",
        type: "string",
        help: "Used by `wrangler dev` instead of the real database.",
      },
      {
        key: "migrations_dir",
        label: "Migrations directory",
        type: "string",
        placeholder: "migrations",
        help: "Where `wrangler d1 migrations` looks for SQL files.",
        defaultHint: "migrations",
      },
      {
        key: "migrations_pattern",
        label: "Migrations pattern",
        type: "string",
        help: "Glob for migration filenames, when they do not follow the default naming.",
      },
    ],
    resource: [],
  },

  r2_bucket: {
    binding: [
      BINDING_NAME,
      {
        key: "bucket_name",
        label: "Bucket name",
        type: "string",
        required: true,
        help: "R2 buckets are identified by name; there is no separate id to paste.",
      },
      {
        key: "preview_bucket_name",
        label: "Preview bucket",
        type: "string",
        help: "Bucket used by `wrangler dev`, so local runs do not write into production objects.",
      },
      {
        key: "jurisdiction",
        label: "Jurisdiction",
        type: "string",
        placeholder: "eu",
        help: "Restricts where objects are stored, for data residency requirements. Set at bucket creation and must match here.",
      },
    ],
    resource: [],
  },

  queue: {
    binding: [
      BINDING_NAME,
      {
        key: "queue",
        label: "Queue name",
        type: "string",
        required: true,
        help: "The queue this Worker sends messages to.",
      },
      {
        key: "delivery_delay",
        label: "Delivery delay (seconds)",
        type: "number",
        help: "Hold every message this long before a consumer can see it. Useful when the thing you are queuing needs time to become consistent elsewhere first.",
      },
    ],
    resource: [],
  },

  durable_object: {
    binding: [
      {
        key: "name",
        label: "Binding variable",
        type: "string",
        required: true,
        placeholder: "MY_OBJECT",
        help: "Durable Objects use `name` rather than `binding` for the env variable. Same idea, different key.",
      },
      {
        key: "class_name",
        label: "Class name",
        type: "string",
        required: true,
        help: "The exported class implementing the object. Must be introduced by a migration before it will deploy.",
      },
      {
        key: "script_name",
        label: "Defining script",
        type: "string",
        help: "Set only when the class lives in a different Worker. Leave empty when this Worker defines it.",
      },
      {
        key: "environment",
        label: "Environment",
        type: "string",
        help: "Environment of the defining script, when binding across environments.",
      },
    ],
    resource: [],
  },

  worker: {
    binding: [
      BINDING_NAME,
      {
        key: "service",
        label: "Service name",
        type: "string",
        required: true,
        help: "The Worker being called. Resolved by name at deploy, so renaming the target breaks this until it is redeployed.",
      },
      {
        key: "entrypoint",
        label: "RPC entrypoint",
        type: "string",
        help: "A named WorkerEntrypoint class on the target. Leave empty to call its default export.",
      },
    ],
    resource: [],
  },

  workflow: {
    binding: [
      BINDING_NAME,
      {
        key: "name",
        label: "Workflow name",
        type: "string",
        required: true,
        help: "Identifies the workflow within the account.",
      },
      {
        key: "class_name",
        label: "Class name",
        type: "string",
        required: true,
        help: "The exported WorkflowEntrypoint class.",
      },
      {
        key: "script_name",
        label: "Defining script",
        type: "string",
        help: "Set only when the workflow lives in another Worker.",
      },
    ],
    resource: [],
  },

  vectorize_index: {
    binding: [
      BINDING_NAME,
      {
        key: "index_name",
        label: "Index name",
        type: "string",
        required: true,
        help: "The Vectorize index to query. Its dimensions and metric are fixed at creation.",
      },
    ],
    resource: [],
  },

  hyperdrive: {
    binding: [
      BINDING_NAME,
      {
        key: "id",
        label: "Hyperdrive ID",
        type: "string",
        required: true,
        help: "Returned by `wrangler hyperdrive create`. The connection string lives in Hyperdrive, not here — which is the point.",
      },
      {
        key: "localConnectionString",
        label: "Local connection string",
        type: "string",
        help: "Used only by `wrangler dev`. Never used in production, but it is still a credential in a committed file — prefer an environment variable.",
      },
    ],
    resource: [],
  },

  analytics_engine_dataset: {
    binding: [
      BINDING_NAME,
      {
        key: "dataset",
        label: "Dataset name",
        type: "string",
        help: "Where the events land. Defaults to the binding name if left empty.",
      },
    ],
    resource: [],
  },

  ai: { binding: [BINDING_NAME], resource: [] },
  browser: { binding: [BINDING_NAME], resource: [] },
  images: { binding: [BINDING_NAME], resource: [] },

  mtls_certificate: {
    binding: [
      BINDING_NAME,
      {
        key: "certificate_id",
        label: "Certificate ID",
        type: "string",
        required: true,
        help: "The uploaded client certificate presented on outbound fetches.",
      },
    ],
    resource: [],
  },

  dispatch_namespace: {
    binding: [
      BINDING_NAME,
      {
        key: "namespace",
        label: "Namespace",
        type: "string",
        required: true,
        help: "The Workers for Platforms namespace holding user-deployed Workers.",
      },
    ],
    resource: [],
  },

  secrets_store: {
    binding: [
      BINDING_NAME,
      {
        key: "store_id",
        label: "Store ID",
        type: "string",
        required: true,
        help: "The secrets store holding the value.",
      },
      {
        key: "secret_name",
        label: "Secret name",
        type: "string",
        required: true,
        help: "Which secret in the store this binding exposes.",
      },
    ],
    resource: [],
  },

  container: {
    binding: [
      {
        key: "class_name",
        label: "Class name",
        type: "string",
        required: true,
        help: "The Durable Object class that fronts the container.",
      },
      {
        key: "image",
        label: "Image",
        type: "string",
        required: true,
        placeholder: "./Dockerfile",
        help: "A Dockerfile path or a registry image reference.",
      },
      {
        key: "instance_type",
        label: "Instance type",
        type: "string",
        help: "Size of each container instance. Larger costs more per second of run time.",
      },
      {
        key: "max_instances",
        label: "Max instances",
        type: "number",
        help: "Upper bound on concurrent containers — the main lever on how much this can cost you.",
      },
    ],
    resource: [],
  },

  ratelimit: {
    binding: [
      {
        key: "name",
        label: "Binding variable",
        type: "string",
        required: true,
        help: "Rate limits use `name` rather than `binding`.",
      },
      {
        key: "namespace_id",
        label: "Namespace ID",
        type: "string",
        required: true,
        help: "Distinguishes this limiter from others in the account.",
      },
    ],
    resource: [],
  },

  route: {
    binding: [],
    resource: [
      {
        key: "pattern",
        label: "Pattern",
        type: "string",
        required: true,
        placeholder: "example.com/api/*",
        help: "URL pattern that dispatches to this Worker. Must be on a zone in your account.",
      },
      {
        key: "zone_name",
        label: "Zone",
        type: "string",
        help: "The domain this route belongs to, when it cannot be inferred from the pattern.",
      },
    ],
  },

  custom_domain: {
    binding: [],
    resource: [
      {
        key: "pattern",
        label: "Hostname",
        type: "string",
        required: true,
        placeholder: "api.example.com",
        help: "The Worker owns this whole hostname, and Cloudflare manages its certificate.",
      },
    ],
  },

  cron: {
    binding: [],
    resource: [
      {
        key: "cron",
        label: "Schedule",
        type: "string",
        required: true,
        placeholder: "0 3 * * *",
        help: "Standard cron expression, always UTC. Nothing prevents runs from overlapping if one takes longer than its interval.",
      },
    ],
  },

  external: { binding: [], resource: [] },
  email_route: { binding: [], resource: [] },
};

/** Top-level Worker settings, from the wrangler configuration reference. */
export const WORKER_FIELDS: ConfigField[] = [
  {
    key: "name",
    label: "Name",
    type: "string",
    required: true,
    help: "Alphanumeric and dashes, up to 255 characters. This is how service bindings find the Worker, so renaming it is a coordinated change.",
  },
  {
    key: "main",
    label: "Entry point",
    type: "string",
    placeholder: "src/index.ts",
    help: "Your handler file. Optional only for a Worker that serves nothing but static assets.",
  },
  {
    key: "compatibility_date",
    label: "Compatibility date",
    type: "string",
    required: true,
    placeholder: "YYYY-MM-DD",
    help: "Pins runtime behaviour. Leaving it stale means new fixes never reach you; bumping it is a change to test, not a chore to automate.",
  },
  {
    key: "compatibility_flags",
    label: "Compatibility flags",
    type: "string[]",
    placeholder: "nodejs_compat",
    help: "Opt into runtime features ahead of their compatibility date. `nodejs_compat` is the common one.",
  },
  {
    key: "workers_dev",
    label: "workers.dev subdomain",
    type: "boolean",
    help: "Serve this Worker on its workers.dev URL. Turn off once it has a real route, so there is no second public entry point you forgot about.",
    defaultHint: "true",
  },
  {
    key: "preview_urls",
    label: "Preview URLs",
    type: "boolean",
    help: "Per-version preview URLs for testing a deployment before promoting it.",
    defaultHint: "follows workers.dev",
  },
  {
    key: "logpush",
    label: "Logpush",
    type: "boolean",
    help: "Ship Worker logs to a configured Logpush destination.",
    defaultHint: "false",
  },
  {
    key: "keep_vars",
    label: "Keep dashboard vars",
    type: "boolean",
    help: "Leave variables set in the dashboard alone on deploy. Off by default, which means a deploy wipes them — the usual cause of a binding vanishing in production.",
    defaultHint: "false",
  },
  {
    key: "send_metrics",
    label: "Send metrics to Cloudflare",
    type: "boolean",
    help: "Share usage telemetry about wrangler itself.",
    defaultHint: "true",
  },
];

/** `observability`, split out because it nests. */
export const OBSERVABILITY_FIELDS: ConfigField[] = [
  {
    key: "enabled",
    label: "Enabled",
    type: "boolean",
    help: "Without this there are no logs to read when the Worker misbehaves in production.",
    defaultHint: "false",
  },
  {
    key: "head_sampling_rate",
    label: "Sampling rate",
    type: "number",
    placeholder: "1",
    help: "Fraction of invocations logged, from 0 to 1. Lower it on very high traffic to control cost; 1 keeps everything.",
    defaultHint: "1",
  },
];

/** `limits`. */
export const LIMITS_FIELDS: ConfigField[] = [
  {
    key: "cpu_ms",
    label: "CPU limit (ms)",
    type: "number",
    help: "Caps CPU time per invocation. A runaway loop hits this instead of billing you for it.",
  },
];

/** `placement`. */
export const PLACEMENT_FIELDS: ConfigField[] = [
  {
    key: "mode",
    label: "Placement mode",
    type: "enum",
    options: ["off", "smart"],
    help: "`smart` runs the Worker near its backend rather than near the user — worth it when most of the request time is talking to a database in one region.",
    defaultHint: "off",
  },
];

/** Queue consumer settings, which live on the consuming Worker's config. */
export const QUEUE_CONSUMER_FIELDS: ConfigField[] = [
  {
    key: "max_batch_size",
    label: "Max batch size",
    type: "number",
    help: "Messages delivered per invocation. Higher means fewer invocations, but each one has the same subrequest budget to spend across the whole batch.",
    defaultHint: "10",
  },
  {
    key: "max_batch_timeout",
    label: "Max batch timeout (s)",
    type: "number",
    help: "How long to wait for a batch to fill before delivering a short one. Raising it trades latency for fewer invocations.",
    defaultHint: "5",
  },
  {
    key: "max_retries",
    label: "Max retries",
    type: "number",
    help: "Attempts before a message is sent to the dead-letter queue, or dropped if there is not one.",
    defaultHint: "3",
  },
  {
    key: "max_concurrency",
    label: "Max concurrency",
    type: "number",
    help: "Ceiling on consumer invocations running at once. Use it to protect a downstream that cannot take the parallelism.",
  },
  {
    key: "dead_letter_queue",
    label: "Dead-letter queue",
    type: "string",
    help: "Where exhausted messages go. Without one they are dropped silently, and you find out from the absence of an effect.",
  },
  {
    key: "retry_delay",
    label: "Retry delay (s)",
    type: "number",
    help: "Wait before redelivering a failed message, so a struggling downstream gets room to recover.",
  },
];

/** `assets`, for Workers that serve static files. */
export const ASSETS_FIELDS: ConfigField[] = [
  {
    key: "directory",
    label: "Directory",
    type: "string",
    placeholder: "./dist",
    help: "Folder of built static files to upload.",
  },
  {
    key: "binding",
    label: "Binding variable",
    type: "string",
    placeholder: "ASSETS",
    help: "Exposes ASSETS.fetch() to the Worker. Without it the Worker cannot serve the files itself.",
  },
  {
    key: "not_found_handling",
    label: "Not found handling",
    type: "enum",
    options: ["none", "single-page-application", "404-page"],
    help: "`single-page-application` serves index.html for unmatched paths, which is what a client-side router needs.",
    defaultHint: "none",
  },
  {
    key: "html_handling",
    label: "HTML handling",
    type: "enum",
    options: [
      "auto-trailing-slash",
      "force-trailing-slash",
      "drop-trailing-slash",
      "none",
    ],
    help: "How .html extensions and trailing slashes are normalised in URLs.",
    defaultHint: "auto-trailing-slash",
  },
  {
    key: "run_worker_first",
    label: "Run Worker first",
    type: "boolean",
    help: "Without this, a matching asset is served straight from the edge and your Worker never runs — so its headers and auth checks never apply.",
    defaultHint: "false",
  },
];

export function configSchemaFor(kind: string): ConfigSchema {
  return CONFIG_SCHEMAS[kind] ?? { binding: [], resource: [] };
}
