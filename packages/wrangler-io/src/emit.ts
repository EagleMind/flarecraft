import {
  outgoing,
  incoming,
  type Edge,
  type Node,
  type SystemModel,
} from "@flarecraft/model";
import { PLACEHOLDER_ID, PRIMITIVES, runtimeTypeFor } from "@flarecraft/catalog";
import { BINDING_EXTRACTORS } from "./bindings.js";

/**
 * Model → wrangler configs.
 *
 * Comments are emitted, not stripped. Every config in the corpus this parser
 * was built against carries its reasoning inline, and a generated file that
 * drops that convention reads as foreign the moment it lands in the repo.
 *
 * Values this exporter does not model are passed through from `Node.raw`,
 * which is what keeps model → config → model lossless without having to model
 * all of wrangler's surface area first.
 */

export interface EmittedFile {
  path: string;
  contents: string;
}

export interface EmitResult {
  files: EmittedFile[];
  /** Things the caller must resolve before any of this will deploy. */
  warnings: string[];
}

interface Section {
  key: string;
  value: unknown;
  comment?: string;
}

/** Keys the exporter owns. Anything else in `raw` is passed through untouched. */
const MANAGED_KEYS = new Set([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "observability",
  "assets",
  "vars",
  "migrations",
  "triggers",
  "routes",
  "route",
  "tail_consumers",
  "queues",
  "env",
  ...Object.values(PRIMITIVES)
    .map((p) => p.bindingKey?.split(".")[0])
    .filter((k): k is string => Boolean(k)),
  "services",
  "send_email",
]);

/**
 * Keys wrangler expects as a single object rather than an array.
 *
 * `ai`, `browser`, and `images` are one-per-Worker capabilities, so their
 * config value is `{ "binding": "AI" }`, not `[{ "binding": "AI" }]`. The
 * parser already knew this; emitting the array form produces a config that
 * wrangler rejects outright — caught by the dry run, not by any round trip,
 * because parsing our own wrong output happens to work.
 */
const SINGLETON_KEYS = new Set(
  BINDING_EXTRACTORS.filter((e) => e.singleton).map((e) => e.key),
);

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "worker";

/** Render a JSONC document from ordered sections, so comments survive. */
function renderJsonc(sections: Section[]): string {
  const body = sections
    .map((section) => {
      const value = JSON.stringify(section.value, null, 2)
        .split("\n")
        .join("\n  ");
      const comment = section.comment
        ? `${section.comment
            .split("\n")
            .map((line) => `  // ${line}`)
            .join("\n")}\n`
        : "";
      return `${comment}  ${JSON.stringify(section.key)}: ${value}`;
    })
    .join(",\n\n");
  return `{\n${body}\n}\n`;
}

/**
 * Group a Worker's edges into the wrangler keys they were read from.
 *
 * `bindingType` on the edge is the syntax, `kind` is the semantics — this is
 * the one place the distinction pays off, because putting a binding back under
 * the wrong key produces a config that parses and then does nothing.
 */
function bindingEntries(
  system: SystemModel,
  worker: Node,
  warnings: string[],
): Map<string, unknown[]> {
  const groups = new Map<string, unknown[]>();
  const push = (key: string, entry: unknown): void => {
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  };

  for (const edge of outgoing(system, worker.id)) {
    const target = system.nodes.find((n) => n.id === edge.to);
    if (!target) continue;

    if (edge.kind === "tail") {
      push("tail_consumers", { service: target.name });
      continue;
    }
    if (edge.kind === "service") {
      push("services", {
        binding: edge.bindingName ?? "SERVICE",
        service: target.name,
        ...(edge.entrypoint ? { entrypoint: edge.entrypoint } : {}),
      });
      continue;
    }

    const key = edge.bindingType ?? PRIMITIVES[target.kind]?.bindingKey;
    if (!key) continue;

    // Round-tripping an edge we parsed is exact; a designed edge has to be
    // reconstructed from the primitive's shape. Canvas edits go over the top of
    // either, so editing one field does not drop the rest of the entry.
    const base = edge.raw ?? buildEntry(target, edge, warnings);
    const entry = base ? { ...base, ...edge.config } : undefined;
    if (entry) push(key, entry);
  }

  return groups;
}

function buildEntry(
  target: Node,
  edge: Edge,
  warnings: string[],
): Record<string, unknown> | undefined {
  const binding = edge.bindingName;

  switch (target.kind) {
    case "kv_namespace":
      return { binding, id: requireId(target, warnings, "KV namespace") };
    case "d1_database":
      return {
        binding,
        database_name: target.name,
        database_id: requireId(target, warnings, "D1 database"),
      };
    case "r2_bucket":
      return { binding, bucket_name: target.name };
    case "queue":
      return { binding, queue: target.name };
    case "durable_object":
      return {
        name: binding,
        class_name: target.name,
        ...(target.scriptName && target.scriptName !== edge.from.split(":")[1]
          ? { script_name: target.scriptName }
          : {}),
      };
    case "workflow":
      return { binding, name: target.name, class_name: pascal(target.name) };
    case "vectorize_index":
      return { binding, index_name: target.name };
    case "hyperdrive":
      return { binding, id: requireId(target, warnings, "Hyperdrive config") };
    case "analytics_engine_dataset":
      return { binding, dataset: target.name };
    case "ai":
    case "browser":
    case "images":
      return { binding };
    case "dispatch_namespace":
      return { binding, namespace: target.name };
    case "mtls_certificate":
      return {
        binding,
        certificate_id: requireId(target, warnings, "mTLS certificate"),
      };
    case "container":
      return { class_name: pascal(target.name), image: "./Dockerfile" };
    default:
      return { binding };
  }
}

/**
 * Resources whose id only exists after Cloudflare creates them.
 *
 * A placeholder is emitted rather than a guess, and the caller is told — a
 * config with an invented id fails at deploy with a confusing error, which is
 * worse than one that is obviously incomplete.
 */
function requireId(node: Node, warnings: string[], label: string): string {
  if (node.resourceId) return node.resourceId;
  warnings.push(
    `${label} "${node.name}" has no id yet — run provision.sh and paste the id into the config.`,
  );
  return PLACEHOLDER_ID;
}

const pascal = (name: string): string =>
  name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("") || "Entity";

export function emitWranglerConfig(
  system: SystemModel,
  worker: Node,
  warnings: string[],
): string {
  const config = worker.worker;
  const sections: Section[] = [
    { key: "$schema", value: "node_modules/wrangler/config-schema.json" },
    { key: "name", value: worker.name },
  ];

  // A designed Worker has no `main` yet, but the repo emitter writes a handler
  // at src/index.ts — the config has to point at it or wrangler rejects the
  // whole thing for having no entry point.
  if (config?.main) {
    sections.push({ key: "main", value: config.main });
  } else if (!config?.assets) {
    sections.push({ key: "main", value: "src/index.ts" });
  }
  sections.push({
    key: "compatibility_date",
    value: config?.compatibilityDate ?? new Date().toISOString().slice(0, 10),
    comment:
      "Pinned deliberately. Runtime behaviour is gated on this date, so bumping\nit is a change to test, not a chore to automate.",
  });

  if (config?.compatibilityFlags?.length) {
    sections.push({ key: "compatibility_flags", value: config.compatibilityFlags });
  }
  sections.push({
    key: "observability",
    value: config?.observability ?? { enabled: true },
    comment: "Without this there are no logs to read when this Worker misbehaves.",
  });
  if (config?.assets) sections.push({ key: "assets", value: config.assets });
  if (config?.vars && Object.keys(config.vars).length > 0) {
    sections.push({
      key: "vars",
      value: config.vars,
      comment:
        "Plaintext, and readable in the dashboard. Anything secret belongs in\n`wrangler secret put`, never here.",
    });
  }

  const groups = bindingEntries(system, worker, warnings);

  // Triggers come from edges pointing INTO this Worker.
  const triggers = incoming(system, worker.id);
  const crons = triggers
    .filter((e) => e.kind === "trigger")
    .map((e) => system.nodes.find((n) => n.id === e.from))
    .filter((n): n is Node => n?.kind === "cron")
    .map((n) => n.name);
  if (crons.length > 0) {
    sections.push({
      key: "triggers",
      value: { crons },
      comment:
        "Nothing prevents these runs from overlapping. If one can exceed its\ninterval, guard it.",
    });
  }

  const routes = triggers
    .map((e) => system.nodes.find((n) => n.id === e.from))
    .filter((n): n is Node => n?.kind === "route" || n?.kind === "custom_domain")
    .map((n) => {
      if (n.kind === "custom_domain") return { pattern: n.name, custom_domain: true };

      // wrangler rejects `{ pattern }` on its own — a route object must also
      // carry zone_id or zone_name. The bare string form has no such
      // requirement, so it is the right shape when the zone is unknown.
      const zone =
        (n.config?.["zone_name"] as string | undefined) ??
        (n.raw?.["zone_name"] as string | undefined) ??
        (n.raw?.["zone_id"] as string | undefined);
      if (!zone) return n.name;

      return n.raw?.["zone_id"] && !n.config?.["zone_name"]
        ? { pattern: n.name, zone_id: n.raw["zone_id"] }
        : { pattern: n.name, zone_name: zone };
    });
  if (routes.length > 0) sections.push({ key: "routes", value: routes });

  const consumers = triggers
    .filter((e) => e.kind === "queue_consumer")
    .map((edge) => {
      const queue = system.nodes.find((n) => n.id === edge.from);
      const settings = edge.consumer ?? {};
      return {
        queue: queue?.name ?? "unknown",
        ...(settings.maxBatchSize ? { max_batch_size: settings.maxBatchSize } : {}),
        ...(settings.maxBatchTimeout
          ? { max_batch_timeout: settings.maxBatchTimeout }
          : {}),
        ...(settings.maxRetries ? { max_retries: settings.maxRetries } : {}),
        ...(settings.maxConcurrency
          ? { max_concurrency: settings.maxConcurrency }
          : {}),
        ...(settings.deadLetterQueue
          ? { dead_letter_queue: settings.deadLetterQueue }
          : {}),
      };
    });

  const producers = groups.get("queues.producers");
  if (producers || consumers.length > 0) {
    sections.push({
      key: "queues",
      value: {
        ...(producers ? { producers } : {}),
        ...(consumers.length > 0 ? { consumers } : {}),
      },
    });
  }

  const durableObjects = groups.get("durable_objects.bindings");
  if (durableObjects) {
    sections.push({ key: "durable_objects", value: { bindings: durableObjects } });
  }

  for (const [key, entries] of groups) {
    if (key.includes(".")) continue; // already emitted above
    sections.push({
      key,
      value: SINGLETON_KEYS.has(key) ? (entries[0] ?? {}) : entries,
    });
  }

  if (config?.migrations?.length) {
    sections.push({
      key: "migrations",
      value: config.migrations,
      comment:
        "Migrations replay in order. Never edit a tag that has already shipped —\nadd a new one.",
    });
  }

  // Anything this exporter does not model, carried over verbatim.
  for (const [key, value] of Object.entries(worker.raw ?? {})) {
    if (MANAGED_KEYS.has(key)) continue;
    sections.push({ key, value });
  }

  return renderJsonc(sections);
}

/** The `Env` a Worker's handler receives, derived from its bindings. */
export function emitEnvInterface(system: SystemModel, worker: Node): string {
  const lines: string[] = [];

  for (const edge of outgoing(system, worker.id)) {
    if (!edge.bindingName || edge.kind === "tail") continue;
    const target = system.nodes.find((n) => n.id === edge.to);
    if (!target) continue;
    lines.push(
      `  ${edge.bindingName}: ${runtimeTypeFor(target.kind, edge.entrypoint)};`,
    );
  }

  for (const name of Object.keys(worker.worker?.vars ?? {})) {
    lines.push(`  ${name}: string;`);
  }
  if (worker.worker?.assets?.binding) {
    lines.push(`  ${worker.worker.assets.binding}: Fetcher;`);
  }

  return [
    "// Generated from the topology. Re-export after changing bindings.",
    "export interface Env {",
    ...(lines.length > 0 ? lines : ["  // No bindings yet."]),
    "}",
    "",
  ].join("\n");
}

/**
 * A stub handler with the entry points this Worker's topology implies.
 *
 * Only the handlers the graph actually calls for are stubbed: a Worker with no
 * cron trigger gets no `scheduled`, because an empty handler that silently does
 * nothing is worse than an absent one.
 */
function emitHandler(system: SystemModel, worker: Node): string {
  const inbound = incoming(system, worker.id);
  const hasQueue = inbound.some((e) => e.kind === "queue_consumer");
  const hasCron = inbound.some(
    (e) =>
      e.kind === "trigger" &&
      system.nodes.find((n) => n.id === e.from)?.kind === "cron",
  );

  const lines = [
    'import type { Env } from "./env.js";',
    "",
    "export default {",
    "  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {",
    `    return new Response(${JSON.stringify(`${worker.name} is running`)});`,
    "  },",
  ];

  if (hasQueue) {
    lines.push(
      "",
      "  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {",
      "    for (const message of batch.messages) {",
      "      // Ack explicitly so one poison message cannot retry the whole batch.",
      "      message.ack();",
      "    }",
      "  },",
    );
  }
  if (hasCron) {
    lines.push(
      "",
      "  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {",
      "    // Runs are not mutually exclusive; guard anything that must not overlap.",
      "  },",
    );
  }

  lines.push("} satisfies ExportedHandler<Env>;", "");
  return lines.join("\n");
}

/**
 * Commands that create the resources whose ids the configs need.
 *
 * This exists because of an ordering problem with no clean way around it: a
 * config referencing a D1 database is not valid until that database exists and
 * has handed back an id. Emitting a script the user runs keeps flarecraft
 * read-only against their account, which is the right default.
 */
function emitProvisionScript(system: SystemModel): string {
  const commands: string[] = [];

  for (const node of system.nodes) {
    const spec = PRIMITIVES[node.kind];
    if (!spec?.createCommand) continue;
    if (node.resourceId) continue; // already exists

    commands.push(`# ${spec.label}: ${node.name}`);
    commands.push(`${spec.createCommand} ${JSON.stringify(node.name)}`);
    if (spec.requiresResourceId) {
      commands.push(
        `#   ^ paste the returned id into the ${spec.bindingKey} entry that references it`,
      );
    }
    commands.push("");
  }

  if (commands.length === 0) {
    return "#!/usr/bin/env bash\n# Nothing to provision — every resource already has an id.\n";
  }

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Resources the emitted configs reference but which do not exist yet.",
    "# Several of these print an id that has to go back into a config before",
    "# `wrangler deploy` will accept it — the lines marked ^ below.",
    "",
    ...commands,
  ].join("\n");
}

/**
 * Where the stub handler goes.
 *
 * It follows `main` rather than always landing at src/index.ts, so the emitted
 * tree is self-consistent: a config preserved from a scan points at
 * `src/worker.ts`, and a stub at `src/index.ts` beside it would be a file
 * nothing loads next to an entry point that does not exist.
 */
function entryPath(worker: Node): { handler: string; env: string } {
  const main = worker.worker?.main?.replace(/^\.\//, "");
  if (!main || worker.worker?.assets && !worker.worker?.main) {
    return { handler: "src/index.ts", env: "src/env.ts" };
  }
  const dir = main.includes("/") ? main.slice(0, main.lastIndexOf("/")) : ".";
  return { handler: main, env: dir === "." ? "env.ts" : `${dir}/env.ts` };
}

export function emitRepo(system: SystemModel): EmitResult {
  const warnings: string[] = [];
  const files: EmittedFile[] = [];
  const workers = system.nodes.filter((n) => n.kind === "worker");

  for (const worker of workers) {
    const dir = slug(worker.name);
    const entry = entryPath(worker);

    files.push({
      path: `${dir}/wrangler.jsonc`,
      contents: emitWranglerConfig(system, worker, warnings),
    });
    files.push({
      path: `${dir}/${entry.env}`,
      contents: emitEnvInterface(system, worker),
    });
    // An assets-only Worker has no entry point at all, and inventing one would
    // change how it deploys.
    if (worker.worker?.main || !worker.worker?.assets) {
      files.push({
        path: `${dir}/${entry.handler}`,
        contents: emitHandler(system, worker),
      });
    }
  }

  files.push({
    path: "pnpm-workspace.yaml",
    contents: `packages:\n${workers.map((w) => `  - "${slug(w.name)}"`).join("\n")}\n`,
  });
  files.push({ path: "provision.sh", contents: emitProvisionScript(system) });

  if (workers.length === 0) warnings.push("This system has no Workers to emit.");

  return { files, warnings: [...new Set(warnings)] };
}
