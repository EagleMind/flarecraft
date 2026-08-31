import { describe, expect, it } from "vitest";
import { emptySystem, type SystemModel } from "./system.js";
import { nodeId, workerId } from "./ids.js";
import type { Edge, Node } from "./index.js";
import {
  groupMembers,
  groupReadiness,
  groupSelection,
  mergeGroups,
  removeFromGroup,
  renameGroup,
  suggestGroups,
} from "./grouping.js";

const worker = (name: string, configPath?: string): Node => ({
  id: workerId(name),
  kind: "worker",
  name,
  provenance: "account",
  ...(configPath ? { configPath } : {}),
  meta: {},
});

const resource = (kind: Node["kind"], name: string): Node => ({
  id: nodeId(kind, name),
  kind,
  name,
  provenance: "account",
  meta: {},
});

const bind = (from: Node, to: Node, bindingName: string): Edge => ({
  id: `${from.id}->${to.id}|${bindingName}`,
  from: from.id,
  to: to.id,
  kind: "binding",
  bindingName,
  meta: {},
});

const system = (nodes: Node[], edges: Edge[] = []): SystemModel => ({
  ...emptySystem("s", "S"),
  nodes,
  edges,
});

const groupOf = (s: SystemModel, name: string) =>
  s.nodes.find((n) => n.name === name)?.groupId;

describe("suggesting groups from the graph", () => {
  it("groups two Workers that share a database", () => {
    const a = worker("orders-api");
    const b = worker("order-processor");
    const db = resource("d1_database", "orders-db");

    const result = suggestGroups(
      system([a, b, db], [bind(a, db, "DB"), bind(b, db, "DB")]),
    );

    expect(groupOf(result, "orders-api")).toBeDefined();
    expect(groupOf(result, "order-processor")).toBe(groupOf(result, "orders-api"));
    expect(result.groups).toHaveLength(1);
  });

  it("does NOT group two Workers that share only Workers AI", () => {
    const a = worker("alpha");
    const b = worker("beta");
    const ai = resource("ai", "Workers AI");

    const result = suggestGroups(
      system([a, b, ai], [bind(a, ai, "AI"), bind(b, ai, "AI")]),
    );

    // An account-wide capability is not shared state. Treating it as a
    // connector is the single most likely way this feature produces a
    // confidently wrong answer.
    expect(groupOf(result, "alpha")).not.toBe(groupOf(result, "beta"));
    expect(result.groups).toHaveLength(2);
  });

  it("gives a lone Worker its own group", () => {
    const result = suggestGroups(system([worker("solo")]));
    expect(result.groups).toHaveLength(1);
    expect(groupOf(result, "solo")).toBeDefined();
  });

  it("does not invent a group for resources nobody binds", () => {
    const result = suggestGroups(system([resource("r2_bucket", "orphan")]));
    // That is a lint finding, not a system.
    expect(result.groups ?? []).toHaveLength(0);
    expect(groupOf(result, "orphan")).toBeUndefined();
  });

  it("names a group after its busiest Worker", () => {
    const api = worker("orders-api");
    const consumer = worker("order-processor");
    const db = resource("d1_database", "orders-db");
    const bucket = resource("r2_bucket", "receipts");

    const result = suggestGroups(
      system(
        [api, consumer, db, bucket],
        [bind(api, db, "DB"), bind(api, bucket, "FILES"), bind(consumer, db, "DB")],
      ),
    );
    expect(result.groups?.[0]?.name).toBe("orders-api");
  });

  it("separates two genuinely unrelated systems", () => {
    const a = worker("alpha");
    const aDb = resource("d1_database", "alpha-db");
    const b = worker("beta");
    const bDb = resource("d1_database", "beta-db");

    const result = suggestGroups(
      system([a, aDb, b, bDb], [bind(a, aDb, "DB"), bind(b, bDb, "DB")]),
    );
    expect(result.groups).toHaveLength(2);
    expect(groupOf(result, "alpha")).not.toBe(groupOf(result, "beta"));
  });

  it("re-running replaces the previous suggestion rather than layering on it", () => {
    const a = worker("alpha");
    const once = suggestGroups(system([a]));
    const twice = suggestGroups(once);
    expect(twice.groups).toHaveLength(1);
  });
});

describe("editing groups by hand", () => {
  const base = () => system([worker("a"), worker("b"), worker("c")]);

  it("puts a selection into a new group", () => {
    const { system: next, group } = groupSelection(
      base(),
      [workerId("a"), workerId("b")],
      "payments",
    );
    expect(group.name).toBe("payments");
    expect(groupMembers(next, group.id).map((n) => n.name).sort()).toEqual(["a", "b"]);
    expect(groupOf(next, "c")).toBeUndefined();
  });

  it("drops a group once its last member leaves", () => {
    const { system: grouped, group } = groupSelection(base(), [workerId("a")]);
    const emptied = removeFromGroup(grouped, [workerId("a")]);
    // A group nothing belongs to is noise on the canvas.
    expect(emptied.groups).toHaveLength(0);
    expect(groupOf(emptied, "a")).toBeUndefined();
  });

  it("merges one group into another", () => {
    const first = groupSelection(base(), [workerId("a")], "one");
    const second = groupSelection(first.system, [workerId("b")], "two");

    const merged = mergeGroups(second.system, first.group.id, second.group.id);
    expect(groupOf(merged, "b")).toBe(first.group.id);
    expect(merged.groups).toHaveLength(1);
  });

  it("renames without disturbing membership", () => {
    const { system: grouped, group } = groupSelection(base(), [workerId("a")]);
    const renamed = renameGroup(grouped, group.id, "checkout");
    expect(renamed.groups?.[0]?.name).toBe("checkout");
    expect(groupMembers(renamed, group.id)).toHaveLength(1);
  });
});

describe("readiness to consolidate", () => {
  it("counts only Workers, and only those with a local config", () => {
    const located = worker("has-source", "/repo/has-source/wrangler.jsonc");
    const missing = worker("no-source");
    const db = resource("d1_database", "db");

    const { system: grouped, group } = groupSelection(
      system([located, missing, db]),
      [located.id, missing.id, db.id],
    );

    const readiness = groupReadiness(grouped, group.id);
    // A queue or a bucket has no folder, so counting them would make the
    // group look permanently unready.
    expect(readiness.workers).toHaveLength(2);
    expect(readiness.located.map((n) => n.name)).toEqual(["has-source"]);
    expect(readiness.missing.map((n) => n.name)).toEqual(["no-source"]);
  });
});
