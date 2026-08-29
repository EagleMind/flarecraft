import { describe, expect, it } from "vitest";
import { addNode, connect } from "./mutations.js";
import { emptySystem, type SystemModel } from "./system.js";
import { extractWorker, insertQueue, renameWorker } from "./refactors.js";
import { durableObjectId } from "./ids.js";

function build() {
  let system: SystemModel = emptySystem("t", "T");
  const place = (kind: Parameters<typeof addNode>[1], name: string) => {
    const result = addNode(system, kind, { x: 0, y: 0 }, name);
    system = result.system;
    return result.node;
  };

  const api = place("worker", "api");
  const billing = place("worker", "billing");
  const kv = place("kv_namespace", "cache");
  const d1 = place("d1_database", "ledger");

  const link = (fromId: string, toId: string, binding?: string) => {
    const result = connect(system, fromId, toId, binding);
    if (result.rejected) throw new Error(result.rejected);
    system = result.system;
    return result.edge!;
  };

  const service = link(api.id, billing.id, "BILLING");
  const cacheEdge = link(api.id, kv.id, "CACHE");
  const ledgerEdge = link(api.id, d1.id, "LEDGER");

  return { system, api, billing, kv, d1, service, cacheEdge, ledgerEdge };
}

describe("inserting a queue between two Workers", () => {
  it("replaces the service call with a producer and a consumer", () => {
    const { system, service, api, billing } = build();
    const result = insertQueue(system, service.id, "billing-jobs");

    expect(result.rejected).toBeUndefined();
    expect(result.system.edges.find((e) => e.id === service.id)).toBeUndefined();

    const producer = result.system.edges.find(
      (e) => e.from === api.id && e.bindingName === "BILLING_JOBS",
    );
    const consumer = result.system.edges.find((e) => e.kind === "queue_consumer");
    expect(producer).toBeDefined();
    expect(consumer?.to).toBe(billing.id);
  });

  it("gives the queue a dead-letter queue from the start", () => {
    const { system, service } = build();
    const result = insertQueue(system, service.id, "billing-jobs");

    // Adding a DLQ later leaves the window before you did unrecoverable.
    const consumer = result.system.edges.find((e) => e.kind === "queue_consumer");
    expect(consumer?.consumer?.deadLetterQueue).toBe("billing-jobs-dlq");
    expect(
      result.system.nodes.filter((n) => n.kind === "queue").map((n) => n.name).sort(),
    ).toEqual(["billing-jobs", "billing-jobs-dlq"]);
  });

  it("deploys the consumer before the producer", () => {
    const { system, service } = build();
    const plan = insertQueue(system, service.id, "billing-jobs").plan;

    const queueStep = plan.findIndex((s) => s.command?.includes("queues create"));
    const consumerStep = plan.findIndex((s) => s.action.includes("Deploy billing"));
    const producerStep = plan.findIndex((s) => s.action.includes("Deploy api"));

    // Producer first means messages pile up behind a handler that is not there.
    expect(queueStep).toBeLessThan(consumerStep);
    expect(consumerStep).toBeLessThan(producerStep);
    expect(plan[consumerStep]?.why).toContain("draining");
  });

  it("says out loud that the call site is still synchronous", () => {
    const { system, service } = build();
    const plan = insertQueue(system, service.id, "billing-jobs").plan;
    expect(plan[plan.length - 1]?.action).toContain("call site");
  });

  it("refuses an edge that is not a service binding", () => {
    const { system, cacheEdge } = build();
    expect(insertQueue(system, cacheEdge.id).rejected).toContain("not a service binding");
  });
});

describe("renaming a Worker", () => {
  it("deletes the old name last, after every caller has moved", () => {
    const { system, billing } = build();
    const plan = renameWorker(system, billing.id, "payments").plan;

    const deploy = plan.findIndex((s) => s.action.includes("new name"));
    const callers = plan.findIndex((s) => s.action.includes("bind to it"));
    const remove = plan.findIndex((s) => s.action.includes("Delete"));

    expect(deploy).toBeLessThan(callers);
    expect(callers).toBeLessThan(remove);
    // Deleting first is the version of this that takes production down.
    expect(plan[remove]?.why).toContain("takes production down");
  });

  it("names the callers that have to be redeployed", () => {
    const { system, billing } = build();
    const plan = renameWorker(system, billing.id, "payments").plan;
    expect(plan.find((s) => s.action.includes("bind to it"))?.action).toContain("api");
  });

  it("follows the rename through Durable Object ownership", () => {
    let { system, billing } = build();
    const cls = addNode(system, "durable_object", { x: 0, y: 0 }, "Ledger");
    system = {
      ...cls.system,
      nodes: cls.system.nodes.map((n) =>
        n.id === cls.node.id ? { ...n, scriptName: "billing" } : n,
      ),
    };

    const result = renameWorker(system, billing.id, "payments");
    const moved = result.system.nodes.find((n) => n.kind === "durable_object");
    expect(moved?.scriptName).toBe("payments");
  });

  it("warns about Durable Object migrations rather than pretending it is routine", () => {
    let { system, billing } = build();
    system = {
      ...system,
      nodes: system.nodes.map((n) =>
        n.id === billing.id && n.worker
          ? {
              ...n,
              worker: {
                ...n.worker,
                migrations: [{ tag: "v1", new_sqlite_classes: ["Ledger"] }],
              },
            }
          : n,
      ),
    };

    const plan = renameWorker(system, billing.id, "payments").plan;
    expect(plan.some((s) => s.action.includes("migrations"))).toBe(true);
  });

  it("refuses a name already taken", () => {
    const { system, billing } = build();
    expect(renameWorker(system, billing.id, "api").rejected).toContain("already exists");
  });

  it("leaves node ids alone so edges survive", () => {
    const { system, billing } = build();
    const result = renameWorker(system, billing.id, "payments");
    expect(result.system.nodes.find((n) => n.id === billing.id)?.name).toBe("payments");
    expect(result.system.edges).toHaveLength(system.edges.length);
  });
});

describe("extracting a Worker", () => {
  it("moves the chosen bindings and links the two with a service call", () => {
    const { system, api, cacheEdge, kv } = build();
    const result = extractWorker(system, api.id, [cacheEdge.id], "cache-api");

    expect(result.rejected).toBeUndefined();
    const created = result.system.nodes.find((n) => n.name === "cache-api")!;
    expect(
      result.system.edges.find((e) => e.from === created.id && e.to === kv.id),
    ).toBeDefined();
    // The source no longer holds it.
    expect(
      result.system.edges.find((e) => e.from === api.id && e.to === kv.id),
    ).toBeUndefined();
    expect(
      result.system.edges.find(
        (e) => e.from === api.id && e.to === created.id && e.kind === "service",
      ),
    ).toBeDefined();
  });

  it("deploys the new Worker before the one that will call it", () => {
    const { system, api, cacheEdge } = build();
    const plan = extractWorker(system, api.id, [cacheEdge.id], "cache-api").plan;

    expect(plan[0]?.action).toContain("Deploy cache-api");
    expect(plan[1]?.action).toContain("Deploy api");
    expect(plan[0]?.why).toContain("cannot resolve a Worker that has not been deployed");
  });

  it("leaves the code move as an explicit step", () => {
    const { system, api, cacheEdge } = build();
    const plan = extractWorker(system, api.id, [cacheEdge.id], "cache-api").plan;
    expect(plan[plan.length - 1]?.action).toContain("Move the corresponding code");
  });

  it("refuses when nothing was selected", () => {
    const { system, api } = build();
    expect(extractWorker(system, api.id, [], "cache-api").rejected).toContain(
      "at least one binding",
    );
  });

  it("refuses a name already taken", () => {
    const { system, api, cacheEdge } = build();
    expect(
      extractWorker(system, api.id, [cacheEdge.id], "billing").rejected,
    ).toContain("already exists");
  });
});

describe("durableObjectId stays consistent after a rename", () => {
  it("produces the id the renamed script would derive", () => {
    expect(durableObjectId("payments", "Ledger")).toBe(
      "durable_object:payments:Ledger",
    );
  });
});
