import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { projectRootFor } from "./fs.js";

/**
 * Tested against this repository's own layout rather than the machine's
 * Documents folder, so the test means the same thing on any checkout.
 *
 * The shapes exercised here are the ones that matter: a config nested a level
 * below its project root, and a walk that must stop at the scan boundary rather
 * than climbing to the filesystem root.
 */
const REPO = resolve(join(import.meta.dirname, "..", "..", ".."));

describe("locating the project a config belongs to", () => {
  it("walks up from a nested file to the package root", async () => {
    // src/fs.ts is not the root — packages/wrangler-io is, and that is the
    // folder you would have to copy to get a working project.
    const found = await projectRootFor(join(REPO, "packages/wrangler-io/src/fs.ts"), REPO);
    expect(found).toBe(join(REPO, "packages/wrangler-io"));
  });

  it("finds a different package from a different file", async () => {
    const found = await projectRootFor(join(REPO, "apps/studio/src/App.tsx"), REPO);
    expect(found).toBe(join(REPO, "apps/studio"));
  });

  it("returns the root itself when the config sits at the top", async () => {
    const found = await projectRootFor(join(REPO, "package.json"), REPO);
    expect(found).toBe(REPO);
  });

  it("never climbs above the scan root", async () => {
    // Boundary set below the real root: there is no marker at or under it, so
    // the answer must be "ask the user" rather than something outside the scan.
    const boundary = join(REPO, "packages", "wrangler-io", "src");
    const found = await projectRootFor(join(boundary, "fs.ts"), boundary);
    expect(found).toBeUndefined();
  });

  it("gives up rather than guessing when nothing looks like a root", async () => {
    const boundary = join(REPO, "packages", "wrangler-io", "fixtures");
    const found = await projectRootFor(
      join(boundary, "felt.wrangler.jsonc"),
      boundary,
    );
    expect(found).toBeUndefined();
  });
});
