import { describe, expect, it } from "vitest";
import {
  emptySystem,
  nodeId,
  workerId,
  type Edge,
  type Node,
  type SystemModel,
} from "@flarecraft/model";
import { diffSystems, type DriftFinding } from "./drift.js";

const worker = (name: string, compatibilityDate?: string): Node => ({
  id: workerId(name),
  kind: "worker",
  name,
  provenance: "repo",
  worker: {
    compatibilityFlags: [],
    migrations: [],
    vars: {},
    environmentVars: {},
    secrets: [],
    ...(compatibilityDate ? { compatibilityDate } : {}),
  },
  meta: {},
});

const resource = (kind: Node["kind"], name: string): Node => ({
  id: nodeId(kind, name),
  kind,
  name,
  provenance: "repo",
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

const kinds = (findings: DriftFinding[]) => findings.map((f) => f.kind);
const of = (findings: DriftFinding[], kind: string) =>
  findings.find((f) => f.kind === kind);

describe("what is deployed versus what is written down", () => {
  it("flags a resource a config needs that the account does not have", () => {
    const api = worker("api");
    const db = resource("d1_database", "orders");
    const repo = system([api, db], [bind(api, db, "DB")]);
    const account = system([api]);

    const finding = of(diffSystems(repo, account), "undeployed");
    expect(finding?.severity).toBe("warning");
    expect(finding?.message).toContain("orders");
    expect(finding?.remedy).toContain("provision.sh");
  });

  it("treats a deployed-but-unscanned resource as information, not an error", () => {
    const repo = system([worker("api")]);
    const account = system([worker("api"), resource("r2_bucket", "mystery")]);

    const finding = of(diffSystems(repo, account), "untracked");
    // A repo scan only sees repositories that happen to be on this machine.
    expect(finding?.severity).toBe("info");
    expect(finding?.remedy).toContain("not on this machine");
  });

  it("does not call a route undeployed", () => {
    const repo = system([worker("api"), resource("route", "example.com/*")]);
    const account = system([worker("api")]);
    expect(kinds(diffSystems(repo, account))).not.toContain("undeployed");
  });
});

describe("binding drift", () => {
  it("treats a binding that exists only in production as an error", () => {
    const api = worker("api");
    const kv = resource("kv_namespace", "cache");
    const repo = system([api, kv]);
    const account = system([api, kv], [bind(api, kv, "CACHE")]);

    const finding = of(diffSystems(repo, account), "binding-only-in-account");
    // The next deploy silently removes it, which is the whole problem.
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("env.CACHE");
    expect(finding?.remedy).toContain("next deploy removes it");
  });

  it("treats a binding only in config as an undeployed change", () => {
    const api = worker("api");
    const kv = resource("kv_namespace", "cache");
    const repo = system([api, kv], [bind(api, kv, "CACHE")]);
    const account = system([api, kv]);

    expect(of(diffSystems(repo, account), "binding-only-in-repo")?.severity).toBe(
      "warning",
    );
  });

  it("stays quiet about edges belonging to a Worker only one side knows", () => {
    const ghost = worker("ghost");
    const kv = resource("kv_namespace", "cache");
    const repo = system([worker("api")]);
    const account = system([worker("api"), ghost, kv], [bind(ghost, kv, "CACHE")]);

    const findings = diffSystems(repo, account);
    // The Worker itself is reported once; restating it per binding is noise.
    expect(kinds(findings)).toContain("untracked");
    expect(kinds(findings)).not.toContain("binding-only-in-account");
  });
});

describe("field drift", () => {
  it("reports a compatibility date that differs between config and production", () => {
    const repo = system([worker("api", "2026-08-01")]);
    const account = system([worker("api", "2025-01-01")]);

    const finding = of(diffSystems(repo, account), "field-differs");
    expect(finding?.message).toContain("2026-08-01");
    expect(finding?.message).toContain("2025-01-01");
  });

  it("says nothing when only one side reported a date", () => {
    // The account API does not always include it, and absent data is not a
    // disagreement.
    const repo = system([worker("api", "2026-08-01")]);
    const account = system([worker("api")]);
    expect(kinds(diffSystems(repo, account))).not.toContain("field-differs");
  });

  it("says nothing when the two agree", () => {
    const repo = system([worker("api", "2026-08-01")]);
    const account = system([worker("api", "2026-08-01")]);
    expect(diffSystems(repo, account)).toHaveLength(0);
  });
});

describe("ordering", () => {
  it("puts production surprises above undeployed changes above information", () => {
    const api = worker("api");
    const kv = resource("kv_namespace", "cache");
    const d1 = resource("d1_database", "orders");
    const r2 = resource("r2_bucket", "mystery");

    const repo = system([api, kv, d1], [bind(api, d1, "DB")]);
    const account = system([api, kv, r2], [bind(api, kv, "CACHE")]);

    const findings = diffSystems(repo, account);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[findings.length - 1]?.severity).toBe("info");
  });
});
