import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import {
  durableObjectId,
  edgeId,
  emptySystem,
  nodeId,
  upsertEdge,
  upsertNode,
  workerId,
  type Edge,
  type Node,
  type NodeKind,
  type SystemModel,
} from "@flarecraft/model";
import {
  isFallbackName,
  isPlaceholderId,
  resourceDisplayName,
  resourceKey,
} from "@flarecraft/catalog";
import {
  BINDING_EXTRACTORS,
  SINGLETON_NAMES,
  readPath,
  type BindingExtractor,
} from "./bindings.js";

export interface ParseWarning {
  code:
    | "missing-name"
    | "missing-main"
    | "missing-compatibility-date"
    | "malformed"
    | "unknown-environment";
  message: string;
  configPath?: string;
}

export interface ParseResult {
  system: SystemModel;
  warnings: ParseWarning[];
  /** Environments declared under `env.*`, so the UI can offer to switch. */
  environments: string[];
}

export interface ParseOptions {
  /** Used for provenance, for the inferred name fallback, and in warnings. */
  configPath?: string;
  format?: "jsonc" | "toml";
  /** Parse a named `env.<name>` overlay instead of the top-level config. */
  environment?: string;
}

type Dict = Record<string, unknown>;

const asDict = (v: unknown): Dict | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : undefined;

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * Parse a wrangler config into a single-Worker fragment of a SystemModel.
 *
 * The result is a fragment on purpose: a config knows about its own Worker and
 * everything that Worker points at, but nothing about who points back at it.
 * Callers fold fragments together with `mergeSystems` to get a whole account.
 */
export function parseWranglerConfig(
  text: string,
  options: ParseOptions = {},
): ParseResult {
  const warnings: ParseWarning[] = [];
  const configPath = options.configPath;
  const format = options.format ?? detectFormat(configPath, text);

  const parsed = parseConfigText(text, format, configPath, warnings);
  if (!parsed) {
    return { system: emptySystem("fragment", "unparsed"), warnings, environments: [] };
  }

  const environments = Object.keys(asDict(parsed["env"]) ?? {});
  const config = applyEnvironment(parsed, options.environment, warnings, configPath);

  if (options.environment && !environments.includes(options.environment)) {
    warnings.push({
      code: "unknown-environment",
      message: `No env.${options.environment} block in this config; parsed the top-level config instead.`,
      ...(configPath ? { configPath } : {}),
    });
  }

  const name = resolveWorkerName(config, options, warnings);
  const system = buildSystem(name, config, parsed, options, warnings);

  return { system, warnings, environments };
}

function detectFormat(
  configPath: string | undefined,
  text: string,
): "jsonc" | "toml" {
  if (configPath?.endsWith(".toml")) return "toml";
  if (configPath?.endsWith(".json") || configPath?.endsWith(".jsonc")) return "jsonc";
  // No usable extension: JSON configs start with a brace once comments and
  // whitespace are stripped, TOML never does.
  return text.replace(/^\s*(\/\/.*$|\/\*[\s\S]*?\*\/)?/gm, "").trimStart().startsWith("{")
    ? "jsonc"
    : "toml";
}

function parseConfigText(
  text: string,
  format: "jsonc" | "toml",
  configPath: string | undefined,
  warnings: ParseWarning[],
): Dict | undefined {
  try {
    if (format === "toml") {
      return asDict(parseToml(text));
    }
    // jsonc-parser rather than JSON.parse: every config in the wild carries
    // comments, and several carry trailing commas.
    const errors: ParseError[] = [];
    const value = parseJsonc(text, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0 && value === undefined) {
      warnings.push({
        code: "malformed",
        message: `Could not parse config (${errors.length} syntax error(s)).`,
        ...(configPath ? { configPath } : {}),
      });
      return undefined;
    }
    return asDict(value);
  } catch (error) {
    warnings.push({
      code: "malformed",
      message: `Could not parse config: ${(error as Error).message}`,
      ...(configPath ? { configPath } : {}),
    });
    return undefined;
  }
}

/**
 * Overlay a named environment onto the top-level config.
 *
 * Shallow override, deliberately. wrangler does not inherit binding arrays into
 * environments — an `env.staging` that declares `kv_namespaces` replaces the
 * top-level list rather than extending it — so a deep merge would invent
 * bindings that will not exist at runtime.
 */
function applyEnvironment(
  parsed: Dict,
  environment: string | undefined,
  _warnings: ParseWarning[],
  _configPath: string | undefined,
): Dict {
  const { env: _env, ...base } = parsed;
  if (!environment) return base;
  const overlay = asDict(asDict(parsed["env"])?.[environment]);
  if (!overlay) return base;
  return { ...base, ...overlay };
}

function resolveWorkerName(
  config: Dict,
  options: ParseOptions,
  warnings: ParseWarning[],
): string {
  const declared = asString(config["name"]);
  if (declared) {
    // wrangler appends the environment to the script name unless the env block
    // overrides `name` outright, which the spread above has already handled.
    return options.environment && !asString(config["name"])?.endsWith(options.environment)
      ? `${declared}-${options.environment}`
      : declared;
  }

  // Real configs in the wild are sometimes fragments — a `wrangler.jsonc`
  // holding only `observability` next to a `wrangler.toml` that holds the rest.
  // Infer from the directory so the node still renders, and say so loudly.
  const inferred = inferNameFromPath(options.configPath);
  warnings.push({
    code: "missing-name",
    message: `No "name" field; inferred "${inferred}" from the config's directory. This config is probably a fragment or an override.`,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  });
  return inferred;
}

function inferNameFromPath(configPath: string | undefined): string {
  if (!configPath) return "unnamed-worker";
  const parts = configPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 2] ?? "unnamed-worker";
}

function buildSystem(
  name: string,
  config: Dict,
  original: Dict,
  options: ParseOptions,
  warnings: ParseWarning[],
): SystemModel {
  const id = workerId(name);
  let system = emptySystem(`fragment:${name}`, name);

  if (!asString(config["main"]) && !asDict(config["assets"])) {
    warnings.push({
      code: "missing-main",
      message: `Worker "${name}" declares neither "main" nor "assets".`,
      ...(options.configPath ? { configPath: options.configPath } : {}),
    });
  }
  if (!asString(config["compatibility_date"])) {
    warnings.push({
      code: "missing-compatibility-date",
      message: `Worker "${name}" has no compatibility_date; runtime behaviour will drift as the platform changes.`,
      ...(options.configPath ? { configPath: options.configPath } : {}),
    });
  }

  const worker: Node = {
    id,
    kind: "worker",
    name,
    provenance: "repo",
    ...(options.configPath ? { configPath: options.configPath } : {}),
    worker: {
      ...(asString(config["main"]) ? { main: asString(config["main"])! } : {}),
      ...(asString(config["compatibility_date"])
        ? { compatibilityDate: asString(config["compatibility_date"])! }
        : {}),
      compatibilityFlags: asArray(config["compatibility_flags"]).filter(
        (f): f is string => typeof f === "string",
      ),
      ...(asDict(config["observability"])
        ? { observability: asDict(config["observability"])! }
        : {}),
      ...(asDict(config["assets"]) ? { assets: asDict(config["assets"])! } : {}),
      migrations: asArray(config["migrations"]) as never[],
      vars: asDict(config["vars"]) ?? {},
      environmentVars: collectEnvironmentVars(original),
      secrets: [],
      ...(asDict(config["placement"]) ? { placement: asDict(config["placement"])! } : {}),
      ...(asDict(config["limits"]) ? { limits: asDict(config["limits"])! } : {}),
      ...(typeof config["workers_dev"] === "boolean"
        ? { workersDev: config["workers_dev"] }
        : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    },
    raw: original,
    meta: {},
  };

  system = upsertNode(system, worker);

  for (const extractor of BINDING_EXTRACTORS) {
    system = extractBindings(system, config, extractor, id, name);
  }

  system = extractServices(system, config, id);
  system = extractSendEmail(system, config, id);
  system = extractDurableObjectClasses(system, config, name);
  system = extractQueueConsumers(system, config, id);
  system = extractCrons(system, config, id);
  system = extractRoutes(system, config, id);
  system = extractTailConsumers(system, config, id);

  return system;
}

/**
 * `vars` from every `env.<name>` block.
 *
 * Read from the untouched config rather than the environment-resolved one, so
 * a single parse of the default config still sees what production declares.
 */
function collectEnvironmentVars(original: Dict): Record<string, Dict> {
  const environments = asDict(original["env"]);
  if (!environments) return {};

  const out: Record<string, Dict> = {};
  for (const [name, block] of Object.entries(environments)) {
    const vars = asDict(asDict(block)?.["vars"]);
    if (vars) out[name] = vars;
  }
  return out;
}

function extractBindings(
  system: SystemModel,
  config: Dict,
  extractor: BindingExtractor,
  workerNodeId: string,
  workerName: string,
): SystemModel {
  const raw = readPath(config, extractor.key);
  if (raw === undefined || raw === null) return system;

  const entries = extractor.singleton
    ? [asDict(raw) ?? {}]
    : asArray(raw).map((e) => asDict(e) ?? {});

  let out = system;
  for (const entry of entries) {
    const bindingName = asString(entry[extractor.bindingNameField ?? "binding"]);
    const resourceName = extractor.nameField
      ? asString(entry[extractor.nameField])
      : SINGLETON_NAMES[extractor.key];
    // A placeholder is not an id: reading it back as one would make a resource
    // that has never been created look like it already exists.
    const rawId = extractor.idField ? asString(entry[extractor.idField]) : undefined;
    const resourceId = isPlaceholderId(rawId) ? undefined : rawId;

    // A Durable Object class defined in another script belongs to that script,
    // not to this one — otherwise two Workers binding the same shared class
    // would each create their own copy of the node.
    const owningScript = extractor.scriptField
      ? (asString(entry[extractor.scriptField]) ?? workerName)
      : undefined;

    const targetId =
      extractor.kind === "durable_object"
        ? durableObjectId(owningScript ?? workerName, resourceName ?? "UnknownClass")
        : nodeId(extractor.kind, resourceKey(extractor.kind, resourceName, resourceId));

    const target: Node = {
      id: targetId,
      kind: extractor.kind,
      name: resourceDisplayName(resourceName, bindingName, resourceId),
      ...(isFallbackName(resourceName) ? { nameIsFallback: true } : {}),
      provenance: "repo",
      ...(resourceId ? { resourceId } : {}),
      ...(owningScript && extractor.kind === "durable_object"
        ? { scriptName: owningScript }
        : {}),
      raw: entry,
      meta: {},
    };
    out = upsertNode(out, target);

    const kind: Edge["kind"] = "binding";
    const edge: Edge = {
      id: edgeId(workerNodeId, targetId, kind, bindingName),
      from: workerNodeId,
      to: targetId,
      kind,
      bindingType: extractor.bindingType,
      ...(bindingName ? { bindingName } : {}),
      raw: entry,
      meta: {},
    };
    out = upsertEdge(out, edge);
  }
  return out;
}

/**
 * Service bindings — Worker calling Worker.
 *
 * Kept out of the table-driven path because the edge kind differs (`service`,
 * not `binding`) and the target is a Worker node rather than a resource. This
 * is the edge the whole topology hangs on: it is the only one that can form a
 * cycle, and it is the one the dashboard makes hardest to see.
 */
function extractServices(
  system: SystemModel,
  config: Dict,
  workerNodeId: string,
): SystemModel {
  let out = system;
  for (const raw of asArray(config["services"])) {
    const entry = asDict(raw);
    const service = asString(entry?.["service"]);
    if (!entry || !service) continue;

    const targetId = workerId(service);
    out = upsertNode(out, {
      id: targetId,
      kind: "worker",
      name: service,
      provenance: "repo",
      meta: {},
    });

    const bindingName = asString(entry["binding"]);
    const entrypoint = asString(entry["entrypoint"]);
    out = upsertEdge(out, {
      id: edgeId(workerNodeId, targetId, "service", bindingName),
      from: workerNodeId,
      to: targetId,
      kind: "service",
      bindingType: "services",
      ...(bindingName ? { bindingName } : {}),
      ...(entrypoint ? { entrypoint } : {}),
      raw: entry,
      meta: {},
    });
  }
  return out;
}

/**
 * `send_email` bindings. Outbound mail leaves Cloudflare, so it is modelled as
 * an external dependency — either the specific allowed destination, or one
 * shared node when the binding permits sending anywhere.
 */
function extractSendEmail(
  system: SystemModel,
  config: Dict,
  workerNodeId: string,
): SystemModel {
  let out = system;
  for (const raw of asArray(config["send_email"])) {
    const entry = asDict(raw);
    if (!entry) continue;

    const destination =
      asString(entry["destination_address"]) ??
      asString(entry["allowed_destination_addresses"]) ??
      "email (any destination)";
    const targetId = nodeId("external", `email:${destination}`);

    out = upsertNode(out, {
      id: targetId,
      kind: "external",
      name: destination,
      provenance: "repo",
      raw: entry,
      meta: { transport: "email" },
    });

    const bindingName = asString(entry["name"]);
    out = upsertEdge(out, {
      id: edgeId(workerNodeId, targetId, "binding", bindingName),
      from: workerNodeId,
      to: targetId,
      kind: "binding",
      bindingType: "send_email",
      ...(bindingName ? { bindingName } : {}),
      raw: entry,
      meta: {},
    });
  }
  return out;
}

/**
 * Durable Object classes introduced by `migrations` but never bound.
 *
 * They are still part of the system — `mymoney` renames a class across two
 * migration tags — and a class that exists with no binding pointing at it is
 * exactly the kind of thing worth seeing on the canvas.
 */
function extractDurableObjectClasses(
  system: SystemModel,
  config: Dict,
  workerName: string,
): SystemModel {
  let out = system;
  for (const raw of asArray(config["migrations"])) {
    const migration = asDict(raw);
    if (!migration) continue;

    const introduced = [
      ...asArray(migration["new_classes"]),
      ...asArray(migration["new_sqlite_classes"]),
    ].filter((c): c is string => typeof c === "string");

    const renames = asArray(migration["renamed_classes"])
      .map((r) => asDict(r))
      .flatMap((r) => {
        const from = asString(r?.["from"]);
        const to = asString(r?.["to"]);
        return from && to ? [{ from, to }] : [];
      });
    const renamedTo = renames.map((r) => r.to);

    // Migrations replay in order, so a class renamed away in a later tag must
    // stop existing — `mymoney` introduces ExpensesStore in v1 and renames it
    // to DataStore in v2, and only DataStore is real today.
    const deleted = new Set([
      ...asArray(migration["deleted_classes"]).filter(
        (c): c is string => typeof c === "string",
      ),
      ...renames.map((r) => r.from),
    ]);

    for (const className of [...introduced, ...renamedTo]) {
      if (deleted.has(className)) continue;
      const id = durableObjectId(workerName, className);
      out = upsertNode(out, {
        id,
        kind: "durable_object",
        name: className,
        provenance: "repo",
        scriptName: workerName,
        meta: { fromMigration: true },
      });
    }

    // A class deleted by a later migration should not linger on the canvas.
    for (const className of deleted) {
      const id = durableObjectId(workerName, className);
      out = { ...out, nodes: out.nodes.filter((n) => n.id !== id) };
    }
  }
  return out;
}

function extractQueueConsumers(
  system: SystemModel,
  config: Dict,
  workerNodeId: string,
): SystemModel {
  let out = system;
  for (const raw of asArray(readPath(config, "queues.consumers"))) {
    const entry = asDict(raw);
    const queueName = asString(entry?.["queue"]);
    if (!entry || !queueName) continue;

    const queueNodeId = nodeId("queue", queueName);
    out = upsertNode(out, {
      id: queueNodeId,
      kind: "queue",
      name: queueName,
      provenance: "repo",
      meta: {},
    });

    // Direction matters: the queue pushes into the Worker. The producer edge
    // for the same queue points the other way, and a queue commonly has both.
    const kind: Edge["kind"] = "queue_consumer";
    out = upsertEdge(out, {
      id: edgeId(queueNodeId, workerNodeId, kind),
      from: queueNodeId,
      to: workerNodeId,
      kind,
      bindingType: "queues.consumers",
      consumer: {
        ...(typeof entry["max_batch_size"] === "number"
          ? { maxBatchSize: entry["max_batch_size"] }
          : {}),
        ...(typeof entry["max_batch_timeout"] === "number"
          ? { maxBatchTimeout: entry["max_batch_timeout"] }
          : {}),
        ...(typeof entry["max_retries"] === "number"
          ? { maxRetries: entry["max_retries"] }
          : {}),
        ...(typeof entry["max_concurrency"] === "number"
          ? { maxConcurrency: entry["max_concurrency"] }
          : {}),
        ...(asString(entry["dead_letter_queue"])
          ? { deadLetterQueue: asString(entry["dead_letter_queue"])! }
          : {}),
        ...(typeof entry["retry_delay"] === "number"
          ? { retryDelay: entry["retry_delay"] }
          : {}),
      },
      raw: entry,
      meta: {},
    });

    // The dead-letter queue is a real node too; the "queue has no DLQ" rule
    // needs to be able to tell a missing one from an unmodelled one.
    const dlq = asString(entry["dead_letter_queue"]);
    if (dlq) {
      out = upsertNode(out, {
        id: nodeId("queue", dlq),
        kind: "queue",
        name: dlq,
        provenance: "repo",
        meta: { deadLetter: true },
      });
    }
  }
  return out;
}

function extractCrons(
  system: SystemModel,
  config: Dict,
  workerNodeId: string,
): SystemModel {
  let out = system;
  for (const raw of asArray(readPath(config, "triggers.crons"))) {
    const expression = asString(raw);
    if (!expression) continue;

    // Keyed by (Worker, expression): two Workers on the same schedule are two
    // triggers, but the collision rule still wants to find them by expression.
    const cronNodeId = nodeId("cron", workerNodeId, expression);
    out = upsertNode(out, {
      id: cronNodeId,
      kind: "cron",
      name: expression,
      provenance: "repo",
      meta: { expression },
    });
    out = upsertEdge(out, {
      id: edgeId(cronNodeId, workerNodeId, "trigger"),
      from: cronNodeId,
      to: workerNodeId,
      kind: "trigger",
      bindingType: "triggers.crons",
      meta: {},
    });
  }
  return out;
}

function extractRoutes(
  system: SystemModel,
  config: Dict,
  workerNodeId: string,
): SystemModel {
  let out = system;
  const declared = [
    ...asArray(config["routes"]),
    ...(config["route"] !== undefined ? [config["route"]] : []),
  ];

  for (const raw of declared) {
    const asObject = asDict(raw);
    const pattern = asString(raw) ?? asString(asObject?.["pattern"]);
    if (!pattern) continue;

    const isCustomDomain = asObject?.["custom_domain"] === true;
    const kind: NodeKind = isCustomDomain ? "custom_domain" : "route";
    const routeNodeId = nodeId(kind, pattern);

    out = upsertNode(out, {
      id: routeNodeId,
      kind,
      name: pattern,
      provenance: "repo",
      ...(asObject ? { raw: asObject } : {}),
      meta: {},
    });
    out = upsertEdge(out, {
      id: edgeId(routeNodeId, workerNodeId, "trigger"),
      from: routeNodeId,
      to: workerNodeId,
      kind: "trigger",
      bindingType: "routes",
      meta: {},
    });
  }
  return out;
}

function extractTailConsumers(
  system: SystemModel,
  config: Dict,
  workerNodeId: string,
): SystemModel {
  let out = system;
  for (const raw of asArray(config["tail_consumers"])) {
    const service = asString(asDict(raw)?.["service"]);
    if (!service) continue;

    const targetId = workerId(service);
    out = upsertNode(out, {
      id: targetId,
      kind: "worker",
      name: service,
      provenance: "repo",
      meta: {},
    });
    out = upsertEdge(out, {
      id: edgeId(workerNodeId, targetId, "tail"),
      from: workerNodeId,
      to: targetId,
      kind: "tail",
      bindingType: "tail_consumers",
      meta: {},
    });
  }
  return out;
}
