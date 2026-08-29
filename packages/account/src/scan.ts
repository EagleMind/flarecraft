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
import { isFallbackName, resourceDisplayName, resourceKey } from "@flarecraft/catalog";
import { CloudflareApiError, type CloudflareClient } from "./client.js";
import {
  API_BINDING_INDEX,
  NON_TOPOLOGY_BINDINGS,
} from "./api-bindings.js";

export interface ScanWarning {
  code: "endpoint-failed" | "unknown-binding" | "partial";
  message: string;
  detail?: string;
}

export interface AccountScanResult {
  system: SystemModel;
  warnings: ScanWarning[];
  /** Endpoints that answered, for showing the user what the scan actually saw. */
  covered: string[];
}

type Dict = Record<string, unknown>;

const asDict = (v: unknown): Dict | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : undefined;
const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * Standalone resource listings.
 *
 * Every entry is fetched independently and a failure on any one of them is a
 * warning, never a thrown error. A token scoped for Workers but not for
 * Vectorize is the normal case, not an exceptional one, and such a scan should
 * still produce a complete picture of everything it *could* read.
 *
 * VERIFICATION: paths are encoded from the public API and must be confirmed
 * against a live account before the scan is trusted for drift detection.
 */
interface ResourceSource {
  id: string;
  kind: NodeKind;
  path: (accountId: string) => string;
  nameField: string;
  idField?: string;
}

const RESOURCE_SOURCES: ResourceSource[] = [
  {
    id: "kv",
    kind: "kv_namespace",
    path: (a) => `/accounts/${a}/storage/kv/namespaces`,
    nameField: "title",
    idField: "id",
  },
  {
    id: "d1",
    kind: "d1_database",
    path: (a) => `/accounts/${a}/d1/database`,
    nameField: "name",
    idField: "uuid",
  },
  {
    id: "r2",
    kind: "r2_bucket",
    path: (a) => `/accounts/${a}/r2/buckets`,
    nameField: "name",
  },
  {
    id: "queues",
    kind: "queue",
    path: (a) => `/accounts/${a}/queues`,
    nameField: "queue_name",
    idField: "queue_id",
  },
  {
    id: "workflows",
    kind: "workflow",
    path: (a) => `/accounts/${a}/workflows`,
    nameField: "name",
    idField: "id",
  },
  {
    id: "vectorize",
    kind: "vectorize_index",
    path: (a) => `/accounts/${a}/vectorize/v2/indexes`,
    nameField: "name",
  },
  {
    id: "hyperdrive",
    kind: "hyperdrive",
    path: (a) => `/accounts/${a}/hyperdrive/configs`,
    nameField: "name",
    idField: "id",
  },
];

export async function scanAccount(
  client: CloudflareClient,
  accountId: string,
): Promise<AccountScanResult> {
  const warnings: ScanWarning[] = [];
  const covered: string[] = [];
  let system = emptySystem(`account:${accountId}`, `Cloudflare account ${accountId}`);
  system = { ...system, accountId, scannedAt: new Date().toISOString() };

  // Resources first: a queue listed here carries its real name, so the binding
  // pass below merges onto a node that is already correctly labelled rather
  // than creating one named after somebody's binding variable.
  for (const source of RESOURCE_SOURCES) {
    try {
      const items = await client.list<Dict>(source.path(accountId));
      covered.push(source.id);
      for (const item of items) {
        const name = asString(item[source.nameField]);
        const resourceId = source.idField ? asString(item[source.idField]) : undefined;
        system = upsertNode(system, {
          id: nodeId(source.kind, resourceKey(source.kind, name, resourceId)),
          kind: source.kind,
          name: resourceDisplayName(name, undefined, resourceId),
          ...(isFallbackName(name) ? { nameIsFallback: true } : {}),
          provenance: "account",
          ...(resourceId ? { resourceId } : {}),
          raw: item,
          meta: {},
        });
      }
    } catch (error) {
      warnings.push(describeFailure(source.id, error));
    }
  }

  const scripts = await listScripts(client, accountId, warnings);
  covered.push("workers");

  for (const script of scripts) {
    const name = asString(script["id"]) ?? asString(script["name"]);
    if (!name) continue;
    system = addWorker(system, name, script);
    system = await addWorkerBindings(client, accountId, name, system, warnings);
    system = await addSchedules(client, accountId, name, system, warnings);
  }

  system = await addRoutes(client, accountId, system, warnings, covered);

  return { system, warnings, covered };
}

async function listScripts(
  client: CloudflareClient,
  accountId: string,
  warnings: ScanWarning[],
): Promise<Dict[]> {
  try {
    return await client.list<Dict>(`/accounts/${accountId}/workers/scripts`);
  } catch (error) {
    warnings.push(describeFailure("workers", error));
    return [];
  }
}

function addWorker(system: SystemModel, name: string, script: Dict): SystemModel {
  const worker: Node = {
    id: workerId(name),
    kind: "worker",
    name,
    provenance: "account",
    worker: {
      compatibilityFlags: Array.isArray(script["compatibility_flags"])
        ? (script["compatibility_flags"] as string[])
        : [],
      ...(asString(script["compatibility_date"])
        ? { compatibilityDate: asString(script["compatibility_date"])! }
        : {}),
      migrations: [],
      vars: {},
      environmentVars: {},
      secrets: [],
    },
    raw: script,
    meta: {
      ...(asString(script["modified_on"])
        ? { modifiedOn: asString(script["modified_on"]) }
        : {}),
    },
  };
  return upsertNode(system, worker);
}

async function addWorkerBindings(
  client: CloudflareClient,
  accountId: string,
  scriptName: string,
  system: SystemModel,
  warnings: ScanWarning[],
): Promise<SystemModel> {
  let settings: Dict | undefined;
  try {
    settings = await client.get<Dict>(
      `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
    );
  } catch (error) {
    warnings.push(describeFailure(`bindings:${scriptName}`, error));
    return system;
  }

  const bindings = Array.isArray(settings["bindings"])
    ? (settings["bindings"] as Dict[])
    : [];
  const from = workerId(scriptName);
  let out = system;

  for (const binding of bindings) {
    const type = asString(binding["type"]);
    if (!type || NON_TOPOLOGY_BINDINGS.has(type)) continue;

    const mapping = API_BINDING_INDEX.get(type);
    if (!mapping) {
      // Loud rather than silent: an unrecognised type means a missing edge, and
      // a topology tool that quietly drops edges is worse than useless.
      warnings.push({
        code: "unknown-binding",
        message: `Unrecognised binding type "${type}" on Worker "${scriptName}"; its edge is missing from the graph.`,
      });
      continue;
    }

    const bindingName = asString(binding["name"]);
    const resourceName = mapping.nameField
      ? asString(binding[mapping.nameField])
      : undefined;
    const resourceId = mapping.idField ? asString(binding[mapping.idField]) : undefined;
    const owningScript = mapping.scriptField
      ? (asString(binding[mapping.scriptField]) ?? scriptName)
      : undefined;

    const targetId =
      mapping.kind === "durable_object"
        ? durableObjectId(owningScript ?? scriptName, resourceName ?? "UnknownClass")
        : mapping.kind === "worker"
          ? workerId(resourceName ?? "unknown")
          : nodeId(mapping.kind, resourceKey(mapping.kind, resourceName, resourceId));

    out = upsertNode(out, {
      id: targetId,
      kind: mapping.kind,
      name: resourceDisplayName(resourceName, bindingName, resourceId),
      ...(isFallbackName(resourceName) ? { nameIsFallback: true } : {}),
      provenance: "account",
      ...(resourceId ? { resourceId } : {}),
      ...(owningScript && mapping.kind === "durable_object"
        ? { scriptName: owningScript }
        : {}),
      meta: {},
    });

    const kind: Edge["kind"] = mapping.edgeKind ?? "binding";
    out = upsertEdge(out, {
      id: edgeId(from, targetId, kind, bindingName),
      from,
      to: targetId,
      kind,
      bindingType: mapping.bindingType,
      ...(bindingName ? { bindingName } : {}),
      ...(asString(binding["entrypoint"])
        ? { entrypoint: asString(binding["entrypoint"])! }
        : {}),
      raw: binding,
      meta: {},
    });
  }

  return out;
}

async function addSchedules(
  client: CloudflareClient,
  accountId: string,
  scriptName: string,
  system: SystemModel,
  warnings: ScanWarning[],
): Promise<SystemModel> {
  let result: Dict | undefined;
  try {
    result = await client.get<Dict>(
      `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
    );
  } catch (error) {
    // Workers with no cron triggers are the common case and some accounts 404
    // here rather than returning an empty list; that is not worth a warning.
    if (error instanceof CloudflareApiError && error.status === 404) return system;
    warnings.push(describeFailure(`schedules:${scriptName}`, error));
    return system;
  }

  const schedules = Array.isArray(result["schedules"])
    ? (result["schedules"] as Dict[])
    : [];
  const to = workerId(scriptName);
  let out = system;

  for (const schedule of schedules) {
    const expression = asString(schedule["cron"]);
    if (!expression) continue;
    const cronNodeId = nodeId("cron", to, expression);
    out = upsertNode(out, {
      id: cronNodeId,
      kind: "cron",
      name: expression,
      provenance: "account",
      meta: { expression },
    });
    out = upsertEdge(out, {
      id: edgeId(cronNodeId, to, "trigger"),
      from: cronNodeId,
      to,
      kind: "trigger",
      bindingType: "triggers.crons",
      meta: {},
    });
  }
  return out;
}

/**
 * Routes live on zones, not on the account, so this needs a second listing and
 * a request per zone. Zones the token cannot read are skipped individually.
 */
async function addRoutes(
  client: CloudflareClient,
  accountId: string,
  system: SystemModel,
  warnings: ScanWarning[],
  covered: string[],
): Promise<SystemModel> {
  let out = system;

  try {
    const domains = await client.list<Dict>(`/accounts/${accountId}/workers/domains`);
    covered.push("domains");
    for (const domain of domains) {
      const hostname = asString(domain["hostname"]);
      const service = asString(domain["service"]);
      if (!hostname || !service) continue;
      const id = nodeId("custom_domain", hostname);
      out = upsertNode(out, {
        id,
        kind: "custom_domain",
        name: hostname,
        provenance: "account",
        raw: domain,
        meta: {},
      });
      out = upsertEdge(out, {
        id: edgeId(id, workerId(service), "trigger"),
        from: id,
        to: workerId(service),
        kind: "trigger",
        meta: {},
      });
    }
  } catch (error) {
    warnings.push(describeFailure("domains", error));
  }

  try {
    const zones = await client.list<Dict>("/zones", { "account.id": accountId });
    covered.push("zones");
    for (const zone of zones) {
      const zoneId = asString(zone["id"]);
      if (!zoneId) continue;
      try {
        const routes = await client.list<Dict>(`/zones/${zoneId}/workers/routes`);
        for (const route of routes) {
          const pattern = asString(route["pattern"]);
          const script = asString(route["script"]);
          if (!pattern || !script) continue;
          const id = nodeId("route", pattern);
          out = upsertNode(out, {
            id,
            kind: "route",
            name: pattern,
            provenance: "account",
            raw: route,
            meta: { zoneId },
          });
          out = upsertEdge(out, {
            id: edgeId(id, workerId(script), "trigger"),
            from: id,
            to: workerId(script),
            kind: "trigger",
            bindingType: "routes",
            meta: {},
          });
        }
      } catch (error) {
        warnings.push(describeFailure(`routes:${asString(zone["name"]) ?? zoneId}`, error));
      }
    }
  } catch (error) {
    warnings.push(describeFailure("zones", error));
  }

  return out;
}

function describeFailure(endpoint: string, error: unknown): ScanWarning {
  if (error instanceof CloudflareApiError) {
    const scoped = error.status === 403 || error.status === 401;
    return {
      code: "endpoint-failed",
      message: scoped
        ? `The API token is not scoped to read ${endpoint}; that part of the topology is missing.`
        : `Could not read ${endpoint}: ${error.message}`,
      detail: `HTTP ${error.status} ${error.path}`,
    };
  }
  return {
    code: "endpoint-failed",
    message: `Could not read ${endpoint}: ${(error as Error).message}`,
  };
}
