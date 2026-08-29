import { describe, expect, it } from "vitest";
import {
  DEFAULT_REQUIREMENTS,
  recommend,
  type Requirements,
} from "./decision.js";

const given = (overrides: Partial<Requirements> = {}): Requirements => ({
  ...DEFAULT_REQUIREMENTS,
  ...overrides,
});

const compute = (r: Requirements) => recommend(r).decisions[0]!;
const storage = (r: Requirements) => recommend(r).decisions[1]!;

const rejection = (
  decision: ReturnType<typeof compute>,
  kind: string,
): string | undefined =>
  decision.rejected.find((c) => c.kind === kind)?.disqualifiedBecause;

describe("choosing compute", () => {
  it("picks a Worker for an ordinary request handler", () => {
    expect(compute(given()).chosen?.kind).toBe("worker");
  });

  it("picks a Durable Object when writes must serialize, and says why the Worker lost", () => {
    const decision = compute(given({ serialization: "required" }));
    expect(decision.chosen?.kind).toBe("durable_object");
    // Naming the rejected alternative is the point of the whole exercise.
    expect(rejection(decision, "worker")).toContain("no identity between requests");
  });

  it("picks a Workflow for long multi-step work and explains the Worker's ceiling", () => {
    const decision = compute(given({ shape: "long-running", duration: "hours" }));
    expect(decision.chosen?.kind).toBe("workflow");
    expect(rejection(decision, "worker")).toContain("outlives a Worker invocation");
  });

  it("refuses a Workflow as a request handler", () => {
    expect(rejection(compute(given({ shape: "request" })), "workflow")).toContain(
      "not a request handler",
    );
  });

  it("only reaches for a Container when the runtime forces it", () => {
    expect(rejection(compute(given()), "container")).toContain("cost considerably more");
    expect(compute(given({ runtime: "native" })).chosen?.kind).toBe("container");
  });
});

describe("choosing storage", () => {
  it("rules KV out when a read must see its own write", () => {
    const decision = storage(
      given({ access: "key-lookup", consistency: "read-after-write" }),
    );
    expect(decision.chosen?.kind).not.toBe("kv_namespace");
    expect(rejection(decision, "kv_namespace")).toContain("eventually consistent");
  });

  it("picks KV when staleness is acceptable", () => {
    expect(
      storage(given({ access: "key-lookup", consistency: "eventual-ok" })).chosen?.kind,
    ).toBe("kv_namespace");
  });

  it("prefers Hyperdrive over D1 when a database already exists", () => {
    const decision = storage(
      given({ access: "relational", existingDatabase: "postgres-or-mysql" }),
    );
    expect(decision.chosen?.kind).toBe("hyperdrive");
    expect(rejection(decision, "d1_database")).toContain("split the same data");
  });

  it("rejects D1 for per-entity write throughput, naming the real reason", () => {
    const decision = storage(
      given({
        access: "relational",
        cardinality: "per-entity",
        serialization: "required",
      }),
    );
    // A single D1 database serializes writes globally, which is the trap.
    expect(rejection(decision, "d1_database")).toContain("serializes writes globally");
    expect(decision.chosen?.kind).toBe("durable_object");
  });

  it("sends blobs to R2 and says why not KV", () => {
    const decision = storage(given({ access: "blob" }));
    expect(decision.chosen?.kind).toBe("r2_bucket");
    expect(rejection(decision, "kv_namespace")).toContain("capped");
  });

  it("skips the storage question entirely when nothing is stored", () => {
    expect(storage(given({ access: "none" })).chosen).toBeUndefined();
  });
});

describe("the proposed topology", () => {
  it("puts a Worker in front of a Workflow, which cannot be reached directly", () => {
    const { topology } = recommend(given({ shape: "long-running", duration: "hours" }));
    expect(topology.nodes.some((n) => n.kind === "worker")).toBe(true);
    expect(topology.nodes.some((n) => n.kind === "workflow")).toBe(true);
  });

  it("points the queue into the Worker, not out of it", () => {
    const { topology } = recommend(given({ shape: "event" }));
    const edge = topology.edges.find((e) => e.from === "jobs");
    expect(edge?.to).toBe("api");
  });

  it("does not add a second storage node for Durable Object state", () => {
    const { topology } = recommend(
      given({
        serialization: "required",
        cardinality: "per-entity",
        access: "key-lookup",
        consistency: "read-after-write",
      }),
    );
    expect(topology.nodes.filter((n) => n.kind === "durable_object")).toHaveLength(1);
  });
});

describe("warnings", () => {
  it("flags the single-instance Durable Object bottleneck", () => {
    const { warnings } = recommend(
      given({ serialization: "required", cardinality: "single" }),
    );
    expect(warnings.join(" ")).toContain("global bottleneck");
  });

  it("warns that cron runs can overlap", () => {
    const { warnings } = recommend(given({ shape: "schedule", duration: "minutes" }));
    expect(warnings.join(" ")).toContain("overlapping");
  });

  it("insists on a dead-letter queue", () => {
    expect(recommend(given({ shape: "event" })).warnings.join(" ")).toContain(
      "dead-letter queue",
    );
  });
});
