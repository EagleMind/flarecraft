import { describe, expect, it } from "vitest";
import { addNode, connect, renameNode, uniqueName } from "./mutations.js";
import { emptySystem, type SystemModel } from "./system.js";

const base = () => emptySystem("test", "Test system");

function withNodes(...kinds: Parameters<typeof addNode>[1][]) {
  let system: SystemModel = base();
  const ids: string[] = [];
  for (const kind of kinds) {
    const result = addNode(system, kind, { x: 0, y: 0 });
    system = result.system;
    ids.push(result.node.id);
  }
  return { system, ids };
}

describe("placing nodes", () => {
  it("gives a new Worker today's compatibility date", () => {
    const { node } = addNode(base(), "worker", { x: 0, y: 0 });
    // A new Worker should start on current runtime behaviour rather than
    // silently inheriting whatever date the last example used.
    expect(node.worker?.compatibilityDate).toBe(new Date().toISOString().slice(0, 10));
  });

  it("does not reuse a name already taken by the same kind", () => {
    const first = addNode(base(), "queue", { x: 0, y: 0 });
    expect(first.node.name).toBe("queue");
    expect(uniqueName(first.system, "queue")).toBe("queue-2");
  });

  it("lets different kinds share a name, since namespaces are per-type", () => {
    const { system } = addNode(base(), "queue", { x: 0, y: 0 });
    expect(uniqueName(system, "r2-bucket" as never)).not.toBe("queue-2");
  });

  it("keeps a node's id stable across a rename", () => {
    const { system, node } = addNode(base(), "worker", { x: 0, y: 0 });
    const renamed = renameNode(system, node.id, "checkout-api");
    // Re-deriving the id from the name would orphan every edge already
    // attached to this node the moment somebody renamed it.
    expect(renamed.nodes[0]?.id).toBe(node.id);
    expect(renamed.nodes[0]?.name).toBe("checkout-api");
  });
});

describe("connection rules", () => {
  it("lets a Worker bind to a queue and names the binding after it", () => {
    const { system, ids } = withNodes("worker", "queue");
    const result = connect(system, ids[0]!, ids[1]!);
    expect(result.rejected).toBeUndefined();
    expect(result.edge?.kind).toBe("binding");
    expect(result.edge?.bindingName).toBe("QUEUE");
  });

  it("refuses an edge the platform cannot express, and says why", () => {
    const { system, ids } = withNodes("kv_namespace", "queue");
    const result = connect(system, ids[0]!, ids[1]!);
    // This is the whole point of the canvas: a KV namespace has no outbound
    // edges at all, so this arrangement cannot be drawn.
    expect(result.rejected).toContain("cannot connect");
    expect(result.system.edges).toHaveLength(0);
  });

  it("routes queue delivery into the Worker, not out of it", () => {
    const { system, ids } = withNodes("queue", "worker");
    const result = connect(system, ids[0]!, ids[1]!);
    expect(result.edge?.kind).toBe("queue_consumer");
    expect(result.edge?.from).toBe(ids[0]);
    expect(result.edge?.to).toBe(ids[1]);
  });

  it("makes Worker-to-Worker a service binding", () => {
    const { system, ids } = withNodes("worker", "worker");
    expect(connect(system, ids[0]!, ids[1]!).edge?.kind).toBe("service");
  });

  it("refuses a self-binding", () => {
    const { system, ids } = withNodes("worker");
    expect(connect(system, ids[0]!, ids[0]!).rejected).toContain("itself");
  });

  it("refuses a duplicate edge between the same pair", () => {
    const { system, ids } = withNodes("worker", "d1_database");
    const first = connect(system, ids[0]!, ids[1]!);
    const second = connect(first.system, ids[0]!, ids[1]!);
    expect(second.rejected).toContain("already connects");
  });

  it("refuses two bindings on one Worker sharing a variable name", () => {
    const { system, ids } = withNodes("worker", "kv_namespace", "kv_namespace");
    const first = connect(system, ids[0]!, ids[1]!, "CACHE");
    const second = connect(first.system, ids[0]!, ids[2]!, "CACHE");
    // `env.CACHE` can only mean one thing inside a Worker.
    expect(second.rejected).toContain("already has a binding called CACHE");
  });

  it("allows two Workers to bind the same resource", () => {
    const { system, ids } = withNodes("worker", "worker", "r2_bucket");
    const first = connect(system, ids[0]!, ids[2]!);
    const second = connect(first.system, ids[1]!, ids[2]!);
    expect(second.rejected).toBeUndefined();
    expect(second.system.edges).toHaveLength(2);
  });

  it("records the wrangler key the edge will be emitted under", () => {
    const { system, ids } = withNodes("worker", "r2_bucket");
    expect(connect(system, ids[0]!, ids[1]!).edge?.bindingType).toBe("r2_buckets");
  });

  it("gives triggers no binding name, because they have none", () => {
    const { system, ids } = withNodes("cron", "worker");
    const result = connect(system, ids[0]!, ids[1]!);
    expect(result.edge?.kind).toBe("trigger");
    expect(result.edge?.bindingName).toBeUndefined();
  });
});
