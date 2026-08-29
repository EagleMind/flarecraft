import { describe, expect, it } from "vitest";
import {
  durableObjectId,
  edgeId,
  emptySystem,
  nodeId,
  workerId,
  type Edge,
  type Node,
  type SystemModel,
} from "@flarecraft/model";
import { lint } from "./rules.js";

const worker = (name: string, overrides: Partial<Node> = {}): Node => ({
  id: workerId(name),
  kind: "worker",
  name,
  provenance: "repo",
  // A configPath marks this as something we parsed rather than something the
  // account API reported; several rules stay quiet without it, deliberately.
  configPath: `/repo/${name}/wrangler.jsonc`,
  worker: {
    compatibilityFlags: [],
    migrations: [],
    vars: {},
    secrets: [],
    environmentVars: {},
    compatibilityDate: new Date().toISOString().slice(0, 10),
    observability: { enabled: true },
  },
  meta: {},
  ...overrides,
});

const resource = (kind: Node["kind"], name: string): Node => ({
  id: nodeId(kind, name),
  kind,
  name,
  provenance: "repo",
  meta: {},
});

const bind = (from: string, to: string, bindingName: string): Edge => ({
  id: edgeId(from, to, "binding", bindingName),
  from,
  to,
  kind: "binding",
  bindingName,
  meta: {},
});

const system = (nodes: Node[], edges: Edge[] = []): SystemModel => ({
  ...emptySystem("t", "Test"),
  nodes,
  edges,
});

const rules = (findings: ReturnType<typeof lint>) => findings.map((f) => f.rule);
const find = (findings: ReturnType<typeof lint>, rule: string) =>
  findings.find((f) => f.rule === rule);

describe("credentials in vars", () => {
  it("catches a live Cloudflare token, the case that motivated the rule", () => {
    const result = lint(
      system([
        worker("api", {
          worker: {
            compatibilityFlags: [],
            migrations: [],
            secrets: [],
            environmentVars: {},
            vars: { CLOUDFLARE_API_TOKEN: "cfut_uJVxdIaVk4usonLup8gF13todnOwlAQZ4" },
            observability: { enabled: true },
            compatibilityDate: "2026-01-01",
          },
        }),
      ]),
    );
    const finding = find(result, "credential-in-vars");
    expect(finding?.severity).toBe("error");
    expect(finding?.remedy).toContain("wrangler secret put");
    // Anything committed should be treated as burned, not merely moved.
    expect(finding?.remedy).toContain("rotate");
  });

  it.each([
    ["sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa", "ANTHROPIC_KEY"],
    ["ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "GH"],
    ["xoxb-1234-5678-abcdefghijklmnop", "SLACK"],
    // Not AWS's documentation key: that one contains "EXAMPLE", which the
    // placeholder filter correctly skips.
    ["AKIAQYLPMN5HXQ3BR7WZ", "AWS_ID"],
  ])("recognises %s by its prefix", (value, name) => {
    const result = lint(
      system([
        worker("api", {
          worker: {
            compatibilityFlags: [],
            migrations: [],
            secrets: [],
            environmentVars: {},
            vars: { [name]: value },
            observability: { enabled: true },
            compatibilityDate: "2026-01-01",
          },
        }),
      ]),
    );
    expect(rules(result)).toContain("credential-in-vars");
  });

  it("catches a long opaque value under a secret-sounding name", () => {
    const result = lint(
      system([
        worker("api", {
          worker: {
            compatibilityFlags: [],
            migrations: [],
            secrets: [],
            environmentVars: {},
            vars: { SESSION_SECRET: "9f2c4a1e77b04d3e8a6f5c2b1d0e9a8f" },
            observability: { enabled: true },
            compatibilityDate: "2026-01-01",
          },
        }),
      ]),
    );
    expect(rules(result)).toContain("credential-in-vars");
  });

  it("catches a credential hiding in an environment overlay", () => {
    const result = lint(
      system([
        worker("api", {
          worker: {
            compatibilityFlags: [],
            migrations: [],
            secrets: [],
            vars: { UPSTREAM_BASE_URL: "https://app.example.com/api" },
            // The production overlay is the dangerous place for this, not the
            // lesser one — and it is invisible to a top-level-only scan.
            environmentVars: {
              production: { CLOUDFLARE_API_TOKEN: "cfut_uJVxdIaVk4usonLup8gF13todnO" },
            },
            observability: { enabled: true },
            compatibilityDate: "2026-01-01",
          },
        }),
      ]),
    );
    const finding = find(result, "credential-in-vars");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("env.production.vars");
  });

  it("stays quiet on ordinary configuration", () => {
    const result = lint(
      system([
        worker("api", {
          worker: {
            compatibilityFlags: [],
            migrations: [],
            secrets: [],
            environmentVars: {},
            vars: {
              UPSTREAM_BASE_URL: "https://app.example.com/api",
              LINK_CACHE_TTL_SECONDS: "30",
              PUBLIC_PATH_PREFIX: "/u",
            },
            observability: { enabled: true },
            compatibilityDate: "2026-01-01",
          },
        }),
      ]),
    );
    expect(rules(result)).not.toContain("credential-in-vars");
  });

  it("does not flag obvious placeholders", () => {
    const result = lint(
      system([
        worker("api", {
          worker: {
            compatibilityFlags: [],
            migrations: [],
            secrets: [],
            environmentVars: {},
            vars: {
              API_TOKEN: "your-token-here-replace-me",
              OTHER_SECRET: "<PASTE_YOUR_KEY>",
            },
            observability: { enabled: true },
            compatibilityDate: "2026-01-01",
          },
        }),
      ]),
    );
    expect(rules(result)).not.toContain("credential-in-vars");
  });
});

describe("service binding cycles", () => {
  it("reports a loop the dashboard cannot show", () => {
    const a = worker("a");
    const b = worker("b");
    const result = lint(
      system(
        [a, b],
        [
          { id: "1", from: a.id, to: b.id, kind: "service", bindingName: "B", meta: {} },
          { id: "2", from: b.id, to: a.id, kind: "service", bindingName: "A", meta: {} },
        ],
      ),
    );
    const finding = find(result, "service-binding-cycle");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("a");
    expect(finding?.message).toContain("b");
  });

  it("leaves a plain chain alone", () => {
    const a = worker("a");
    const b = worker("b");
    const result = lint(
      system(
        [a, b],
        [{ id: "1", from: a.id, to: b.id, kind: "service", bindingName: "B", meta: {} }],
      ),
    );
    expect(rules(result)).not.toContain("service-binding-cycle");
  });
});

describe("queue rules", () => {
  const consumerEdge = (
    queueId: string,
    workerNodeId: string,
    consumer: Edge["consumer"],
  ): Edge => ({
    id: "consume",
    from: queueId,
    to: workerNodeId,
    kind: "queue_consumer",
    ...(consumer ? { consumer } : {}),
    meta: {},
  });

  it("does the batch-size arithmetic against the subrequest ceiling", () => {
    const w = worker("processor");
    const queue = resource("queue", "jobs");
    const d1 = resource("d1_database", "orders");
    const kv = resource("kv_namespace", "cache");

    const result = lint(
      system(
        [w, queue, d1, kv],
        [
          consumerEdge(queue.id, w.id, { maxBatchSize: 100, deadLetterQueue: "dlq" }),
          bind(w.id, d1.id, "DB"),
          bind(w.id, kv.id, "CACHE"),
        ],
      ),
      { plan: "free" },
    );

    // 100 messages x 2 bindings = ~200 against a free-tier ceiling of 50.
    const finding = find(result, "queue-batch-subrequests");
    expect(finding?.message).toContain("200");
    expect(finding?.remedy).toContain("max_batch_size");
  });

  it("stays quiet when the batch fits", () => {
    const w = worker("processor");
    const queue = resource("queue", "jobs");
    const d1 = resource("d1_database", "orders");
    const result = lint(
      system(
        [w, queue, d1],
        [
          consumerEdge(queue.id, w.id, { maxBatchSize: 10, deadLetterQueue: "dlq" }),
          bind(w.id, d1.id, "DB"),
        ],
      ),
      { plan: "paid" },
    );
    expect(rules(result)).not.toContain("queue-batch-subrequests");
  });

  it("insists on a dead-letter queue", () => {
    const w = worker("processor");
    const queue = resource("queue", "jobs");
    const result = lint(
      system([w, queue], [consumerEdge(queue.id, w.id, { maxBatchSize: 10 })]),
    );
    expect(find(result, "queue-no-dlq")?.severity).toBe("warning");
  });
});

describe("durable object migrations", () => {
  it("catches a bound class that no migration introduces", () => {
    const w = worker("api");
    const cls: Node = {
      id: durableObjectId("api", "Room"),
      kind: "durable_object",
      name: "Room",
      scriptName: "api",
      provenance: "repo",
      meta: {},
    };
    const result = lint(system([w, cls], [bind(w.id, cls.id, "ROOM")]));
    const finding = find(result, "durable-object-no-migration");
    // wrangler refuses this at deploy time, so it is an error, not advice.
    expect(finding?.severity).toBe("error");
    expect(finding?.remedy).toContain("new_sqlite_classes");
  });

  it("accepts a class introduced by a migration", () => {
    const w = worker("api", {
      worker: {
        compatibilityFlags: [],
        migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
        vars: {},
        secrets: [],
        environmentVars: {},
        compatibilityDate: "2026-01-01",
        observability: { enabled: true },
      },
    });
    const cls: Node = {
      id: durableObjectId("api", "Room"),
      kind: "durable_object",
      name: "Room",
      scriptName: "api",
      provenance: "repo",
      meta: {},
    };
    const result = lint(system([w, cls], [bind(w.id, cls.id, "ROOM")]));
    expect(rules(result)).not.toContain("durable-object-no-migration");
  });

  it("accepts a class renamed into existence", () => {
    const w = worker("api", {
      worker: {
        compatibilityFlags: [],
        migrations: [
          { tag: "v1", new_sqlite_classes: ["Old"] },
          { tag: "v2", renamed_classes: [{ from: "Old", to: "Room" }] },
        ],
        vars: {},
        secrets: [],
        environmentVars: {},
        compatibilityDate: "2026-01-01",
        observability: { enabled: true },
      },
    });
    const cls: Node = {
      id: durableObjectId("api", "Room"),
      kind: "durable_object",
      name: "Room",
      scriptName: "api",
      provenance: "repo",
      meta: {},
    };
    expect(rules(lint(system([w, cls], [bind(w.id, cls.id, "ROOM")])))).not.toContain(
      "durable-object-no-migration",
    );
  });

  it("says nothing about a class owned by a script outside the system", () => {
    const w = worker("api");
    const cls: Node = {
      id: durableObjectId("other-service", "Room"),
      kind: "durable_object",
      name: "Room",
      scriptName: "other-service",
      provenance: "repo",
      meta: {},
    };
    // Its migration lives in a repo this scan never saw; claiming it is missing
    // would be a false positive.
    expect(rules(lint(system([w, cls], [bind(w.id, cls.id, "ROOM")])))).not.toContain(
      "durable-object-no-migration",
    );
  });
});

describe("cron collisions", () => {
  it("flags two Workers on one schedule writing the same resource", () => {
    const a = worker("fx");
    const b = worker("prices");
    const db = resource("d1_database", "ledger");
    const cronA: Node = {
      id: nodeId("cron", a.id, "0 3 * * *"),
      kind: "cron",
      name: "0 3 * * *",
      provenance: "repo",
      meta: {},
    };
    const cronB: Node = {
      id: nodeId("cron", b.id, "0 3 * * *"),
      kind: "cron",
      name: "0 3 * * *",
      provenance: "repo",
      meta: {},
    };

    const result = lint(
      system(
        [a, b, db, cronA, cronB],
        [
          { id: "ta", from: cronA.id, to: a.id, kind: "trigger", meta: {} },
          { id: "tb", from: cronB.id, to: b.id, kind: "trigger", meta: {} },
          bind(a.id, db.id, "DB"),
          bind(b.id, db.id, "DB"),
        ],
      ),
    );
    expect(find(result, "cron-collision")?.message).toContain("ledger");
  });

  it("does not flag different schedules", () => {
    const a = worker("fx");
    const b = worker("prices");
    const db = resource("d1_database", "ledger");
    const cronA: Node = {
      id: nodeId("cron", a.id, "0 3 * * *"),
      kind: "cron",
      name: "0 3 * * *",
      provenance: "repo",
      meta: {},
    };
    const cronB: Node = {
      id: nodeId("cron", b.id, "20 3 * * *"),
      kind: "cron",
      name: "20 3 * * *",
      provenance: "repo",
      meta: {},
    };
    const result = lint(
      system(
        [a, b, db, cronA, cronB],
        [
          { id: "ta", from: cronA.id, to: a.id, kind: "trigger", meta: {} },
          { id: "tb", from: cronB.id, to: b.id, kind: "trigger", meta: {} },
          bind(a.id, db.id, "DB"),
          bind(b.id, db.id, "DB"),
        ],
      ),
    );
    expect(rules(result)).not.toContain("cron-collision");
  });
});

describe("hygiene rules", () => {
  it("reports an unbound resource", () => {
    const result = lint(system([worker("api"), resource("r2_bucket", "leftovers")]));
    expect(find(result, "orphan-resource")?.message).toContain("leftovers");
  });

  it("does not call an ingress node an orphan", () => {
    const cron: Node = {
      id: nodeId("cron", "x", "0 3 * * *"),
      kind: "cron",
      name: "0 3 * * *",
      provenance: "repo",
      meta: {},
    };
    expect(rules(lint(system([cron])))).not.toContain("orphan-resource");
  });

  it("reports a missing compatibility date", () => {
    const w = worker("api", {
      worker: {
        compatibilityFlags: [],
        migrations: [],
        vars: {},
        secrets: [],
        environmentVars: {},
        observability: { enabled: true },
      },
    });
    expect(find(lint(system([w])), "compatibility-date")?.severity).toBe("warning");
  });

  it("stays silent about Workers it only saw through the account API", () => {
    // No configPath: the API does not always report these fields, and inventing
    // a finding from missing data is how a linter loses trust.
    const w = worker("api");
    const scanned: Node = { ...w, provenance: "account" };
    delete (scanned as { configPath?: string }).configPath;
    scanned.worker = { compatibilityFlags: [], migrations: [], vars: {}, secrets: [], environmentVars: {} };
    const result = lint(system([scanned]));
    expect(rules(result)).not.toContain("compatibility-date");
    expect(rules(result)).not.toContain("observability-off");
  });

  it("puts errors before warnings before info", () => {
    const a = worker("a");
    const b = worker("b");
    const result = lint(
      system(
        [a, b, resource("r2_bucket", "leftovers")],
        [
          { id: "1", from: a.id, to: b.id, kind: "service", bindingName: "B", meta: {} },
          { id: "2", from: b.id, to: a.id, kind: "service", bindingName: "A", meta: {} },
        ],
      ),
    );
    expect(result[0]?.severity).toBe("error");
    expect(result[result.length - 1]?.severity).toBe("info");
  });
});
