import { describe, expect, it } from "vitest";
import { durableObjectId, nodeId, workerId } from "@flarecraft/model";
import { CloudflareClient } from "./client.js";
import { scanAccount } from "./scan.js";

/**
 * The scan is exercised against a canned API rather than a live account.
 *
 * What this proves is the part that can be got wrong silently: that the API's
 * binding shapes map onto the same node ids the config parser produces, and
 * that a token missing a scope degrades to a warning instead of an exception.
 * What it cannot prove is that the endpoint paths and `type` strings are right
 * — only a real account does that, and it is the first thing to check once a
 * token exists.
 */

const ok = (result: unknown) =>
  new Response(JSON.stringify({ result, success: true, errors: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const fail = (status: number, message: string) =>
  new Response(
    JSON.stringify({ result: null, success: false, errors: [{ code: status, message }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );

interface Routes {
  [pathFragment: string]: () => Response;
}

const fakeFetch = (routes: Routes, log: string[] = []): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    log.push(url);
    for (const [fragment, respond] of Object.entries(routes)) {
      if (url.includes(fragment)) return respond();
    }
    return ok([]);
  }) as typeof fetch;

const ACCOUNT = "acct123";

describe("account scan", () => {
  const routes: Routes = {
    "/storage/kv/namespaces": () =>
      ok([{ id: "kv-abc", title: "link-cache" }]),
    "/d1/database": () => ok([{ uuid: "d1-xyz", name: "orders" }]),
    "/r2/buckets": () => ok([{ name: "uploads" }]),
    "/queues": () => ok([{ queue_id: "q1", queue_name: "jobs" }]),
    "/workers/scripts?": () =>
      ok([{ id: "api", compatibility_date: "2026-01-01" }, { id: "worker-b" }]),
    "/workers/scripts/api/settings": () =>
      ok({
        bindings: [
          { type: "kv_namespace", name: "CACHE", namespace_id: "kv-abc" },
          { type: "d1", name: "DB", id: "d1-xyz" },
          { type: "queue", name: "JOBS", queue_name: "jobs" },
          { type: "service", name: "B", service: "worker-b" },
          {
            type: "durable_object_namespace",
            name: "ROOM",
            class_name: "Room",
            script_name: "worker-b",
          },
          { type: "plain_text", name: "GREETING", text: "hi" },
          { type: "some_future_binding", name: "MYSTERY" },
        ],
      }),
    "/workers/scripts/worker-b/settings": () => ok({ bindings: [] }),
    "/workers/scripts/api/schedules": () => ok({ schedules: [{ cron: "0 3 * * *" }] }),
    "/vectorize": () => fail(403, "Insufficient permissions"),
  };

  const scan = async () =>
    scanAccount(
      new CloudflareClient({ apiToken: "test", fetchImpl: fakeFetch(routes) }),
      ACCOUNT,
    );

  it("gives resources their real names from the listing endpoints", async () => {
    const { system } = await scan();
    // The binding alone would have called this "CACHE"; the listing knows the
    // namespace is actually titled link-cache.
    const kv = system.nodes.find((n) => n.id === nodeId("kv_namespace", "kv-abc"));
    expect(kv?.name).toBe("link-cache");
  });

  it("resolves API bindings onto the same ids the config parser uses", async () => {
    const { system } = await scan();
    expect(system.nodes.find((n) => n.id === nodeId("d1_database", "d1-xyz"))).toBeDefined();
    expect(system.nodes.find((n) => n.id === nodeId("queue", "jobs"))).toBeDefined();
    expect(
      system.nodes.find((n) => n.id === durableObjectId("worker-b", "Room")),
    ).toBeDefined();
  });

  it("attributes a Durable Object to the script that defines it", async () => {
    const { system } = await scan();
    // `api` binds the class but `worker-b` owns it. Getting this backwards
    // would split one shared class into two nodes.
    const room = system.nodes.find((n) => n.id === durableObjectId("worker-b", "Room"));
    expect(room?.scriptName).toBe("worker-b");
    const edge = system.edges.find((e) => e.to === room?.id);
    expect(edge?.from).toBe(workerId("api"));
  });

  it("makes service bindings a service edge, not a plain binding", async () => {
    const { system } = await scan();
    const edge = system.edges.find((e) => e.kind === "service");
    expect(edge?.from).toBe(workerId("api"));
    expect(edge?.to).toBe(workerId("worker-b"));
  });

  it("ignores bindings that carry no topology", async () => {
    const { system } = await scan();
    expect(system.nodes.some((n) => n.name === "GREETING")).toBe(false);
  });

  it("warns loudly about a binding type it does not recognise", async () => {
    const { warnings } = await scan();
    const unknown = warnings.filter((w) => w.code === "unknown-binding");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.message).toContain("some_future_binding");
  });

  it("turns a missing token scope into a warning, not a failed scan", async () => {
    const { system, warnings } = await scan();
    const scoped = warnings.find((w) => w.message.includes("not scoped"));
    expect(scoped?.detail).toContain("403");
    // The rest of the topology still came back.
    expect(system.nodes.filter((n) => n.kind === "worker")).toHaveLength(2);
  });

  it("attaches cron triggers to their Worker", async () => {
    const { system } = await scan();
    const cron = system.nodes.find((n) => n.kind === "cron");
    expect(cron?.name).toBe("0 3 * * *");
    expect(system.edges.find((e) => e.from === cron?.id)?.to).toBe(workerId("api"));
  });

  it("records which endpoints actually answered", async () => {
    const { covered } = await scan();
    expect(covered).toContain("workers");
    expect(covered).toContain("kv");
    expect(covered).not.toContain("vectorize");
  });
});

describe("client behaviour", () => {
  it("stops paginating when a page comes back short", async () => {
    const log: string[] = [];
    const client = new CloudflareClient({
      apiToken: "test",
      fetchImpl: fakeFetch({ "/things": () => ok([{ id: 1 }]) }, log),
    });
    const items = await client.list("/things");
    expect(items).toHaveLength(1);
    expect(log).toHaveLength(1);
  });

  it("never puts the token in the URL", async () => {
    const log: string[] = [];
    const client = new CloudflareClient({
      apiToken: "super-secret",
      fetchImpl: fakeFetch({ "/things": () => ok([]) }, log),
    });
    await client.list("/things");
    expect(log.join("")).not.toContain("super-secret");
  });
});
