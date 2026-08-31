import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptySystem, groupSelection, workerId, type Node } from "@flarecraft/model";
import { planOrganize } from "./organize.js";

/**
 * The refusals, which are the part that has to be right.
 *
 * Consolidation only ever copies, so the danger is not destruction — it is
 * producing a folder that looks complete while quietly missing a Worker, or
 * burying something that was already in the destination.
 */
const worker = (name: string, configPath?: string): Node => ({
  id: workerId(name),
  kind: "worker",
  name,
  provenance: "account",
  ...(configPath ? { configPath } : {}),
  meta: {},
});

const grouped = (nodes: Node[]) => {
  const base = { ...emptySystem("s", "S"), nodes };
  return groupSelection(base, nodes.map((n) => n.id), "checkout");
};

const emptyDir = () => mkdtemp(join(tmpdir(), "flarecraft-organize-"));

describe("blocking before anything is copied", () => {
  it("names the Worker that has no local folder", async () => {
    const { system, group } = grouped([
      worker("has-source", "/repo/has-source/wrangler.jsonc"),
      worker("no-source"),
    ]);

    const plan = await planOrganize({
      system,
      groupId: group.id,
      destination: await emptyDir(),
      scanRoots: ["/repo"],
    });

    // "Block until resolved" — never invent a stub for a Worker whose source
    // we cannot find.
    expect(plan.blockers.join(" ")).toContain("no-source");
    expect(plan.blockers.join(" ")).toContain("no local folder");
  });

  it("refuses a group with no Workers at all", async () => {
    const { system, group } = grouped([
      { id: "queue:jobs", kind: "queue", name: "jobs", provenance: "account", meta: {} },
    ]);

    const plan = await planOrganize({
      system,
      groupId: group.id,
      destination: await emptyDir(),
      scanRoots: ["/repo"],
    });
    expect(plan.blockers.join(" ")).toContain("nothing to consolidate");
  });

  it("refuses a destination that already has something in it", async () => {
    const destination = await emptyDir();
    await writeFile(join(destination, "existing.txt"), "mine", "utf8");

    const { system, group } = grouped([worker("api", "/repo/api/wrangler.jsonc")]);
    const plan = await planOrganize({
      system,
      groupId: group.id,
      destination,
      scanRoots: ["/repo"],
    });

    // Burying somebody's existing folder is the one irreversible thing this
    // could do, so it is refused rather than merged into.
    expect(plan.blockers.join(" ")).toContain("not empty");
  });

  it("refuses a relative destination", async () => {
    const { system, group } = grouped([worker("api", "/repo/api/wrangler.jsonc")]);
    await expect(
      planOrganize({
        system,
        groupId: group.id,
        destination: "./somewhere",
        scanRoots: ["/repo"],
      }),
    ).rejects.toThrow("absolute");
  });

  it("reports a source it cannot resolve to a project root", async () => {
    // A config path outside every scan root cannot be traced to a folder.
    const { system, group } = grouped([worker("api", "/elsewhere/api/wrangler.jsonc")]);
    const plan = await planOrganize({
      system,
      groupId: group.id,
      destination: await emptyDir(),
      scanRoots: ["/repo"],
    });
    expect(plan.blockers.join(" ")).toContain("api");
  });
});
