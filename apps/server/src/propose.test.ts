import { describe, expect, it } from "vitest";
import { validate, type Proposal } from "./propose.js";

/**
 * The validator is the seam between a model's suggestion and the canvas.
 *
 * Everything downstream — the emitter, the deploy — assumes that what is on the
 * canvas is expressible on Cloudflare. That guarantee only holds if a proposal
 * is checked rather than trusted, so these are the tests that keep a plausible
 * but impossible topology from being drawn as though it were real.
 */
const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  summary: "",
  nodes: [],
  edges: [],
  rejected: [],
  ...overrides,
});

describe("validating a proposal", () => {
  it("keeps a legal topology intact", () => {
    const result = validate(
      proposal({
        nodes: [
          { kind: "worker", name: "api", why: "" },
          { kind: "queue", name: "jobs", why: "" },
        ],
        edges: [{ from: "api", to: "jobs", bindingName: "JOBS" }],
      }),
    );
    expect(result.edges).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops an edge the platform cannot express, and says why", () => {
    const result = validate(
      proposal({
        nodes: [
          { kind: "kv_namespace", name: "cache", why: "" },
          { kind: "queue", name: "jobs", why: "" },
        ],
        edges: [{ from: "cache", to: "jobs", bindingName: "" }],
      }),
    );
    // KV has no outbound edges at all; drawing this would be a lie.
    expect(result.edges).toHaveLength(0);
    expect(result.dropped[0]?.because).toContain("cannot connect");
  });

  it("removes a primitive that does not exist on Cloudflare", () => {
    const result = validate(
      proposal({ nodes: [{ kind: "lambda_function", name: "thing", why: "" }] }),
    );
    expect(result.nodes).toHaveLength(0);
    expect(result.dropped[0]?.because).toContain("not a Cloudflare primitive");
  });

  it("drops an edge pointing at a node that was never declared", () => {
    const result = validate(
      proposal({
        nodes: [{ kind: "worker", name: "api", why: "" }],
        edges: [{ from: "api", to: "ghost", bindingName: "GHOST" }],
      }),
    );
    expect(result.edges).toHaveLength(0);
    expect(result.dropped[0]?.because).toContain("not a node in the proposal");
  });

  it("drops edges attached to a node it already rejected", () => {
    const result = validate(
      proposal({
        nodes: [
          { kind: "worker", name: "api", why: "" },
          { kind: "dynamo_table", name: "store", why: "" },
        ],
        edges: [{ from: "api", to: "store", bindingName: "STORE" }],
      }),
    );
    expect(result.nodes.map((n) => n.name)).toEqual(["api"]);
    expect(result.edges).toHaveLength(0);
  });

  it("keeps queue delivery pointing into the Worker", () => {
    const result = validate(
      proposal({
        nodes: [
          { kind: "queue", name: "jobs", why: "" },
          { kind: "worker", name: "consumer", why: "" },
        ],
        edges: [{ from: "jobs", to: "consumer", bindingName: "" }],
      }),
    );
    expect(result.edges).toHaveLength(1);
  });
});
