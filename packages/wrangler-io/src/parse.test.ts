import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { durableObjectId, nodeId, workerId, findCycles } from "@flarecraft/model";
import { parseWranglerConfig } from "./parse.js";

/**
 * The corpus is eight real configs pulled off this machine rather than written
 * for the test. That is the point: every one of them does something a
 * hand-written fixture would not have thought of — comments in the middle of
 * arrays, a config with no `name`, a Durable Object class renamed across two
 * migration tags, an `env` overlay that redefines bindings.
 */
const FIXTURES = join(import.meta.dirname, "..", "fixtures");

const load = (file: string, environment?: string) =>
  parseWranglerConfig(readFileSync(join(FIXTURES, file), "utf8"), {
    configPath: join(FIXTURES, file),
    ...(environment ? { environment } : {}),
  });

const kinds = (result: ReturnType<typeof load>, kind: string) =>
  result.system.nodes.filter((n) => n.kind === kind);

describe("parses every config in the corpus without throwing", () => {
  const files = [
    "felt.wrangler.jsonc",
    "mymoney.wrangler.jsonc",
    "wassali.wrangler.jsonc",
    "flowrite-server.wrangler.jsonc",
    "flowrite-server.wrangler.toml",
    "fileaway.wrangler.jsonc",
    "newbismodel.wrangler.jsonc",
    "portfolio.wrangler.jsonc",
  ];

  it.each(files)("%s yields at least one Worker node", (file) => {
    const result = load(file);
    expect(kinds(result, "worker").length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.filter((w) => w.code === "malformed")).toHaveLength(0);
  });
});

describe("felt — comments, R2, Hyperdrive, cron, assets", () => {
  const result = load("felt.wrangler.jsonc");

  it("survives JSONC comments that JSON.parse would reject", () => {
    // The file has block comments between top-level keys and inside arrays.
    expect(result.warnings.filter((w) => w.code === "malformed")).toHaveLength(0);
    expect(result.system.nodes.find((n) => n.id === workerId("felt"))).toBeDefined();
  });

  it("finds the R2 bucket by bucket_name, not by binding", () => {
    const bucket = kinds(result, "r2_bucket")[0];
    expect(bucket?.name).toBe("felt-next-cache");
  });

  it("keys Hyperdrive on its id, since the config carries no readable name", () => {
    const hyperdrive = kinds(result, "hyperdrive")[0];
    expect(hyperdrive?.resourceId).toBe("fc900e22debf4cd29617db96bbeb2d54");
    expect(hyperdrive?.id).toContain("fc900e22debf4cd29617db96bbeb2d54");
  });

  it("turns the cron trigger into a node pointing at the Worker", () => {
    const cron = kinds(result, "cron")[0];
    expect(cron?.name).toBe("0 14 * * *");
    const edge = result.system.edges.find((e) => e.kind === "trigger");
    expect(edge?.to).toBe(workerId("felt"));
  });

  it("keeps assets as Worker config rather than a node", () => {
    expect(kinds(result, "external")).toHaveLength(0);
    expect(result.system.nodes.find((n) => n.id === workerId("felt"))?.worker?.assets)
      .toMatchObject({ binding: "ASSETS" });
  });

  it("preserves both compatibility flags", () => {
    const worker = result.system.nodes.find((n) => n.id === workerId("felt"));
    expect(worker?.worker?.compatibilityFlags).toEqual([
      "nodejs_compat",
      "global_fetch_strictly_public",
    ]);
  });
});

describe("mymoney — Durable Object renamed across migration tags", () => {
  const result = load("mymoney.wrangler.jsonc");

  it("models the class the binding actually points at", () => {
    const bound = result.system.nodes.find(
      (n) => n.id === durableObjectId("mymoney-api", "DataStore"),
    );
    expect(bound).toBeDefined();
    expect(bound?.scriptName).toBe("mymoney-api");
  });

  it("retires the pre-rename class instead of leaving a ghost node", () => {
    // v1 introduces ExpensesStore, v2 renames it to DataStore. Only one of
    // those classes exists today, and a canvas showing both would be wrong.
    const ghost = result.system.nodes.find(
      (n) => n.id === durableObjectId("mymoney-api", "ExpensesStore"),
    );
    expect(ghost).toBeUndefined();
    expect(kinds(result, "durable_object")).toHaveLength(1);
  });

  it("uses `name` as the binding variable for Durable Objects", () => {
    const edge = result.system.edges.find((e) => e.kind === "binding");
    expect(edge?.bindingName).toBe("DATA_STORE");
    expect(edge?.bindingType).toBe("durable_objects.bindings");
  });
});

describe("flowrite/server — the awkward pair", () => {
  it("warns rather than failing when a config has no name", () => {
    const result = load("flowrite-server.wrangler.jsonc");
    expect(result.warnings.map((w) => w.code)).toContain("missing-name");
    // It still produces a node, so a fragment config does not silently vanish
    // from the topology.
    expect(kinds(result, "worker")).toHaveLength(1);
  });

  it("parses the TOML sibling with full fidelity", () => {
    const result = load("flowrite-server.wrangler.toml");
    expect(kinds(result, "worker")[0]?.name).toBe("flowrite-api");
    expect(kinds(result, "d1_database")[0]?.name).toBe("flowrite-db");
    expect(kinds(result, "r2_bucket")[0]?.name).toBe("flowrite");
    expect(kinds(result, "durable_object")[0]?.name).toBe("DocRoom");
  });

  it("keys D1 on database_id so a repo parse and an account scan agree", () => {
    const result = load("flowrite-server.wrangler.toml");
    expect(kinds(result, "d1_database")[0]?.id).toBe(
      nodeId("d1_database", "c0bef087-fad4-497e-a093-8a93efa9d055"),
    );
  });
});

describe("fileaway — environment overlays", () => {
  it("reports the environments a config declares", () => {
    expect(load("fileaway.wrangler.jsonc").environments).toEqual(["production"]);
  });

  it("keys KV on its namespace id, the only stable field a config gives", () => {
    const kv = kinds(load("fileaway.wrangler.jsonc"), "kv_namespace")[0];
    expect(kv?.resourceId).toBe("608c81fbd7314d9693789480cfcd7e5e");
    // No namespace title exists in the config, so the binding variable is the
    // best display name available until an account scan supplies the real one.
    expect(kv?.name).toBe("LINK_CACHE");
  });

  it("collects vars from environment overlays without switching to them", () => {
    // A default parse must still see what production declares, or a lint rule
    // can never find a secret that only exists in the production block.
    const worker = kinds(load("fileaway.wrangler.jsonc"), "worker")[0];
    expect(
      Object.keys(worker?.worker?.environmentVars?.["production"] ?? {}),
    ).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("suffixes the Worker name when parsing a named environment", () => {
    const result = load("fileaway.wrangler.jsonc", "production");
    expect(kinds(result, "worker")[0]?.name).toBe("fileaway-upload-worker-production");
    expect(kinds(result, "worker")[0]?.worker?.environment).toBe("production");
  });

  it("takes the environment's bindings rather than merging them", () => {
    // wrangler replaces binding arrays in an env block; a deep merge here would
    // invent a second KV namespace that does not exist at runtime.
    expect(kinds(load("fileaway.wrangler.jsonc", "production"), "kv_namespace")).toHaveLength(1);
  });
});

describe("newbismodel — the busiest config in the corpus", () => {
  const result = load("newbismodel.wrangler.jsonc");

  it("reads all four cron expressions past their trailing comments", () => {
    expect(kinds(result, "cron").map((n) => n.name)).toEqual([
      "0 3 * * *",
      "20 3 * * *",
      "0 4 * * *",
      "0 7 1 * *",
    ]);
  });

  it("models the Workflow as its own node", () => {
    const workflow = kinds(result, "workflow")[0];
    expect(workflow?.name).toBe("price-ingest");
    const edge = result.system.edges.find((e) => e.bindingType === "workflows");
    expect(edge?.bindingName).toBe("PRICE_INGEST");
  });

  it("wires every trigger into the same Worker", () => {
    const triggers = result.system.edges.filter((e) => e.kind === "trigger");
    expect(triggers).toHaveLength(4);
    expect(new Set(triggers.map((e) => e.to))).toEqual(
      new Set([workerId("vols-maghreb")]),
    );
  });
});

describe("wassali and portfolio — assets-only Workers", () => {
  it("produces a lone Worker with no outgoing edges", () => {
    const result = load("wassali.wrangler.jsonc");
    expect(kinds(result, "worker")[0]?.name).toBe("tunilines");
    expect(result.system.edges).toHaveLength(0);
  });

  it("keeps run_worker_first, which decides whether the Worker runs at all", () => {
    const result = load("portfolio.wrangler.jsonc");
    expect(kinds(result, "worker")[0]?.worker?.assets).toMatchObject({
      run_worker_first: true,
    });
  });
});

describe("edges the corpus does not exercise", () => {
  const config = JSON.stringify({
    name: "gateway",
    main: "src/index.ts",
    compatibility_date: "2026-01-01",
    services: [
      { binding: "AUTH", service: "auth-api" },
      { binding: "BILLING", service: "billing-api", entrypoint: "InternalRPC" },
    ],
    queues: {
      producers: [{ binding: "JOBS", queue: "jobs" }],
      consumers: [
        { queue: "jobs", max_batch_size: 50, dead_letter_queue: "jobs-dlq" },
      ],
    },
    tail_consumers: [{ service: "log-sink" }],
  });

  const result = parseWranglerConfig(config, { configPath: "/tmp/wrangler.json" });

  it("creates service edges and the Worker nodes they name", () => {
    const services = result.system.edges.filter((e) => e.kind === "service");
    expect(services).toHaveLength(2);
    expect(services.find((e) => e.bindingName === "BILLING")?.entrypoint).toBe(
      "InternalRPC",
    );
    expect(result.system.nodes.find((n) => n.id === workerId("auth-api"))).toBeDefined();
  });

  it("points producer and consumer edges in opposite directions on one queue", () => {
    const queue = nodeId("queue", "jobs");
    const producer = result.system.edges.find(
      (e) => e.bindingType === "queues.producers",
    );
    const consumer = result.system.edges.find((e) => e.kind === "queue_consumer");
    expect(producer?.from).toBe(workerId("gateway"));
    expect(producer?.to).toBe(queue);
    expect(consumer?.from).toBe(queue);
    expect(consumer?.to).toBe(workerId("gateway"));
  });

  it("captures consumer settings the batch-size rule needs", () => {
    const consumer = result.system.edges.find((e) => e.kind === "queue_consumer");
    expect(consumer?.consumer).toMatchObject({
      maxBatchSize: 50,
      deadLetterQueue: "jobs-dlq",
    });
    expect(result.system.nodes.find((n) => n.id === nodeId("queue", "jobs-dlq")))
      .toBeDefined();
  });

  it("records tail consumers as their own edge kind", () => {
    expect(result.system.edges.filter((e) => e.kind === "tail")).toHaveLength(1);
  });
});

describe("service binding cycles", () => {
  it("finds a loop the dashboard could never show you", () => {
    const a = parseWranglerConfig(
      JSON.stringify({ name: "a", services: [{ binding: "B", service: "b" }] }),
      {},
    );
    const b = parseWranglerConfig(
      JSON.stringify({ name: "b", services: [{ binding: "A", service: "a" }] }),
      {},
    );

    const merged = {
      ...a.system,
      nodes: [...a.system.nodes, ...b.system.nodes],
      edges: [...a.system.edges, ...b.system.edges],
    };

    const cycles = findCycles(merged, new Set(["service" as const]));
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toContain(workerId("a"));
    expect(cycles[0]).toContain(workerId("b"));
  });

  it("does not flag a plain chain", () => {
    const a = parseWranglerConfig(
      JSON.stringify({ name: "a", services: [{ binding: "B", service: "b" }] }),
      {},
    );
    expect(findCycles(a.system, new Set(["service" as const]))).toHaveLength(0);
  });
});
