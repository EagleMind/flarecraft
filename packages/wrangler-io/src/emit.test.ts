import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addNode,
  connect,
  emptySystem,
  mergeSystems,
  nodeId,
  type SystemModel,
} from "@flarecraft/model";
import { parseWranglerConfig } from "./parse.js";
import { emitEnvInterface, emitRepo, emitWranglerConfig } from "./emit.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

const load = (file: string) =>
  parseWranglerConfig(readFileSync(join(FIXTURES, file), "utf8"), {
    configPath: join(FIXTURES, file),
  });

/** The graph reduced to what actually has to survive a round trip. */
const signature = (system: SystemModel) => ({
  nodes: system.nodes
    .map((n) => `${n.id}|${n.kind}`)
    .sort(),
  edges: system.edges
    .map((e) => `${e.from}->${e.to}|${e.kind}|${e.bindingName ?? ""}`)
    .sort(),
});

const CORPUS = [
  "felt.wrangler.jsonc",
  "mymoney.wrangler.jsonc",
  "wassali.wrangler.jsonc",
  "flowrite-server.wrangler.toml",
  "fileaway.wrangler.jsonc",
  "newbismodel.wrangler.jsonc",
  "portfolio.wrangler.jsonc",
];

describe("model → config → model is lossless", () => {
  it.each(CORPUS)("%s survives a round trip", (file) => {
    const original = load(file).system;
    const worker = original.nodes.find((n) => n.kind === "worker")!;

    const emitted = emitWranglerConfig(original, worker, []);
    const reparsed = parseWranglerConfig(emitted, {
      configPath: `/out/${worker.name}/wrangler.jsonc`,
    });

    // A config the emitter produced must parse cleanly — if it does not, the
    // generated repo would not have deployed either.
    expect(reparsed.warnings.filter((w) => w.code === "malformed")).toHaveLength(0);
    expect(signature(reparsed.system)).toEqual(signature(original));
  });

  it("emits JSONC that still carries its reasoning", () => {
    const original = load("felt.wrangler.jsonc").system;
    const worker = original.nodes.find((n) => n.kind === "worker")!;
    const emitted = emitWranglerConfig(original, worker, []);

    expect(emitted).toContain("//");
    expect(emitted).toContain("compatibility_date");
    // Comments are the reason a plain JSON.parse would not do here.
    expect(() => JSON.parse(emitted)).toThrow();
  });

  it("passes through keys the exporter does not model", () => {
    const original = load("fileaway.wrangler.jsonc").system;
    const worker = original.nodes.find((n) => n.kind === "worker")!;
    const emitted = emitWranglerConfig(original, worker, []);
    // `upload_source_maps` and `account_id` are not modelled; dropping them
    // would silently change how the Worker deploys.
    expect(emitted).toContain("upload_source_maps");
    expect(emitted).toContain("account_id");
  });

  it("keeps a whole multi-Worker system intact, not just one config", () => {
    let combined = emptySystem("corpus", "Corpus");
    for (const file of CORPUS) combined = mergeSystems(combined, load(file).system);

    let rebuilt = emptySystem("rebuilt", "Rebuilt");
    for (const worker of combined.nodes.filter((n) => n.kind === "worker")) {
      const emitted = emitWranglerConfig(combined, worker, []);
      rebuilt = mergeSystems(
        rebuilt,
        parseWranglerConfig(emitted, {
          configPath: `/out/${worker.name}/wrangler.jsonc`,
        }).system,
      );
    }
    expect(signature(rebuilt)).toEqual(signature(combined));
  });
});

describe("emitting a designed system", () => {
  const designed = () => {
    let s = emptySystem("d", "Designed");
    const api = addNode(s, "worker", { x: 0, y: 0 }, "api");
    s = api.system;
    const db = addNode(s, "d1_database", { x: 0, y: 0 }, "orders");
    s = db.system;
    const queue = addNode(s, "queue", { x: 0, y: 0 }, "jobs");
    s = queue.system;

    s = connect(s, api.node.id, db.node.id, "DB").system;
    s = connect(s, api.node.id, queue.node.id, "JOBS").system;
    return { system: s, api: api.node };
  };

  it("marks ids that do not exist yet instead of inventing them", () => {
    const { system, api } = designed();
    const warnings: string[] = [];
    const emitted = emitWranglerConfig(system, api, warnings);

    expect(emitted).toContain("REPLACE_ME");
    expect(warnings.join(" ")).toContain("provision.sh");
  });

  it("writes a provision script for exactly the missing resources", () => {
    const { files } = emitRepo(designed().system);
    const script = files.find((f) => f.path === "provision.sh")!.contents;

    expect(script).toContain("wrangler d1 create");
    expect(script).toContain("wrangler queues create");
    // R2 was never in this system; the script must not invent work.
    expect(script).not.toContain("r2 bucket create");
  });

  it("lays out one directory per Worker plus a workspace file", () => {
    const { files } = emitRepo(designed().system);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("api/wrangler.jsonc");
    expect(paths).toContain("api/src/index.ts");
    expect(paths).toContain("api/src/env.ts");
    expect(paths).toContain("pnpm-workspace.yaml");
  });
});

describe("the generated Env interface", () => {
  it("types each binding by what it actually is at runtime", () => {
    const original = load("flowrite-server.wrangler.toml").system;
    const worker = original.nodes.find((n) => n.kind === "worker")!;
    const env = emitEnvInterface(original, worker);

    expect(env).toContain("DB: D1Database;");
    expect(env).toContain("BUCKET: R2Bucket;");
    expect(env).toContain("DOC_ROOM: DurableObjectNamespace;");
  });

  it("includes vars and the assets binding", () => {
    const original = load("newbismodel.wrangler.jsonc").system;
    const worker = original.nodes.find((n) => n.kind === "worker")!;
    const env = emitEnvInterface(original, worker);

    expect(env).toContain("HYPERDRIVE: Hyperdrive;");
    expect(env).toContain("SITE_URL: string;");
    expect(env).toContain("ASSETS: Fetcher;");
  });
});

describe("the generated handler", () => {
  /** The handler follows `main`, so it is found by directory, not by filename. */
  const handlerFile = (system: SystemModel, dir: string) =>
    emitRepo(system).files.find(
      (f) =>
        f.path.startsWith(`${dir}/`) &&
        f.path.endsWith(".ts") &&
        !f.path.endsWith("env.ts"),
    )!;
  const handlerFor = (system: SystemModel, dir: string) =>
    handlerFile(system, dir).contents;

  it("writes the stub at the path `main` points to", () => {
    // newbismodel declares main: "src/worker.ts". A stub at src/index.ts would
    // sit next to an entry point that does not exist.
    const system = load("newbismodel.wrangler.jsonc").system;
    expect(handlerFile(system, "vols-maghreb").path).toBe(
      "vols-maghreb/src/worker.ts",
    );
  });

  it("adds a scheduled handler only when a cron points at the Worker", () => {
    const withCron = load("newbismodel.wrangler.jsonc").system;
    expect(handlerFor(withCron, "vols-maghreb")).toContain("async scheduled(");

    const withoutCron = load("portfolio.wrangler.jsonc").system;
    // An empty scheduled() that silently does nothing is worse than none.
    expect(handlerFor(withoutCron, "hassen-portfolio")).not.toContain("scheduled(");
  });

  it("adds a queue handler when the Worker consumes a queue", () => {
    const config = JSON.stringify({
      name: "processor",
      main: "src/index.ts",
      compatibility_date: "2026-01-01",
      queues: { consumers: [{ queue: "jobs", dead_letter_queue: "dlq" }] },
    });
    const system = parseWranglerConfig(config, { configPath: "/p/wrangler.json" }).system;
    const handler = handlerFor(system, "processor");
    expect(handler).toContain("async queue(");
    expect(handler).toContain("message.ack()");
  });
});

describe("queue producer and consumer round-trip together", () => {
  it("keeps both directions on one queue", () => {
    const config = JSON.stringify({
      name: "gateway",
      main: "src/index.ts",
      compatibility_date: "2026-01-01",
      queues: {
        producers: [{ binding: "JOBS", queue: "jobs" }],
        consumers: [{ queue: "jobs", max_batch_size: 25, dead_letter_queue: "dlq" }],
      },
    });
    const original = parseWranglerConfig(config, { configPath: "/g/wrangler.json" })
      .system;
    const worker = original.nodes.find((n) => n.kind === "worker")!;

    const reparsed = parseWranglerConfig(
      emitWranglerConfig(original, worker, []),
      { configPath: "/out/gateway/wrangler.jsonc" },
    ).system;

    expect(signature(reparsed)).toEqual(signature(original));
    const consumer = reparsed.edges.find((e) => e.kind === "queue_consumer");
    expect(consumer?.consumer?.maxBatchSize).toBe(25);
    expect(consumer?.from).toBe(nodeId("queue", "jobs"));
  });
});

describe("routes", () => {
  const withRoute = (route: unknown) =>
    parseWranglerConfig(
      JSON.stringify({
        name: "api",
        main: "src/index.ts",
        compatibility_date: "2026-01-01",
        routes: [route],
      }),
      { configPath: "/r/wrangler.json" },
    ).system;

  it("emits a bare string when no zone is known", () => {
    const system = withRoute("orders.example.com/*");
    const worker = system.nodes.find((n) => n.kind === "worker")!;
    const emitted = emitWranglerConfig(system, worker, []);
    // wrangler rejects `{ pattern }` alone — a route object must also carry
    // zone_id or zone_name, and the string form sidesteps that entirely.
    expect(emitted).toContain('"routes": [\n    "orders.example.com/*"\n  ]');
    expect(emitted).not.toContain('"pattern"');
  });

  it("keeps the object form when the zone is known", () => {
    const system = withRoute({ pattern: "a.example.com/*", zone_name: "example.com" });
    const worker = system.nodes.find((n) => n.kind === "worker")!;
    expect(emitWranglerConfig(system, worker, [])).toContain('"zone_name"');
  });

  it("round-trips either form", () => {
    for (const route of [
      "orders.example.com/*",
      { pattern: "a.example.com/*", zone_name: "example.com" },
    ]) {
      const original = withRoute(route);
      const worker = original.nodes.find((n) => n.kind === "worker")!;
      const reparsed = parseWranglerConfig(
        emitWranglerConfig(original, worker, []),
        { configPath: "/out/api/wrangler.jsonc" },
      ).system;
      expect(signature(reparsed)).toEqual(signature(original));
    }
  });
});
