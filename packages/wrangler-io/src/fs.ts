import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { mergeSystems, emptySystem, type SystemModel } from "@flarecraft/model";
import { parseWranglerConfig, type ParseResult, type ParseWarning } from "./parse.js";

/**
 * Node-only helpers, exported from `@flarecraft/wrangler-io/fs` rather than the
 * package root so the studio bundle never pulls `node:fs` in. The browser talks
 * to the local server for anything touching disk.
 */

const CONFIG_NAMES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".open-next",
  ".wrangler",
  ".vercel",
  "coverage",
]);

export async function parseWranglerFile(
  path: string,
  environment?: string,
): Promise<ParseResult> {
  const text = await readFile(path, "utf8");
  return parseWranglerConfig(text, {
    configPath: resolve(path),
    ...(environment ? { environment } : {}),
  });
}

/** Every wrangler config under `root`, depth-limited so a scan cannot run away. */
export async function findWranglerConfigs(
  root: string,
  maxDepth = 4,
): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // Unreadable directories are common on Windows; skipping is correct here
      // and far better than aborting a scan of an otherwise fine tree.
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      if (CONFIG_NAMES.includes(entry)) {
        found.push(full);
        continue;
      }
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      try {
        if ((await stat(full)).isDirectory()) await walk(full, depth + 1);
      } catch {
        continue;
      }
    }
  };

  await walk(resolve(root), 0);
  return found.sort();
}

export interface ScanResult {
  system: SystemModel;
  warnings: ParseWarning[];
  configPaths: string[];
}

/**
 * Parse every config under a directory into one merged system.
 *
 * Merging is what turns a pile of independent configs into a topology: a
 * `services` binding in one config and the Worker it names in another become
 * one edge between two real nodes, because both resolve to the same node id.
 */
export async function scanDirectory(
  root: string,
  maxDepth = 4,
): Promise<ScanResult> {
  const configPaths = await findWranglerConfigs(root, maxDepth);
  let system = emptySystem(`repo:${resolve(root)}`, "Local repositories");
  const warnings: ParseWarning[] = [];

  for (const path of configPaths) {
    try {
      const result = await parseWranglerFile(path);
      system = mergeSystems(system, result.system);
      warnings.push(...result.warnings);
    } catch (error) {
      warnings.push({
        code: "malformed",
        message: `Could not read ${path}: ${(error as Error).message}`,
        configPath: path,
      });
    }
  }

  return { system, warnings, configPaths };
}

/**
 * Markers that say "this directory is the root of a project".
 *
 * `package.json` rather than `.git` alone: of the seven real projects this was
 * checked against, every one has a `package.json` at its root but one has no
 * `.git` at all, so requiring a repository would have silently mislocated it.
 */
const ROOT_MARKERS = [".git", "package.json"];

/**
 * The project folder a wrangler config belongs to.
 *
 * A config is rarely at the root — `mymoney/worker/wrangler.jsonc` and
 * `fileaway/fileaway-upload-worker/wrangler.jsonc` both sit a level down — so
 * copying "the folder with the config in it" would take a fragment of the
 * project and leave its package.json behind.
 *
 * Walks up looking for a root marker, never climbing past `scanRoot`. Returns
 * undefined when nothing above the config looks like a project root, which the
 * caller should treat as "ask the user" rather than guessing.
 */
export async function projectRootFor(
  configPath: string,
  scanRoot: string,
): Promise<string | undefined> {
  const boundary = resolve(scanRoot);
  let current = dirname(resolve(configPath));

  for (;;) {
    if (await hasRootMarker(current)) return current;

    const parent = dirname(current);
    // Stop at the scan root, at the filesystem root, or if we somehow escaped.
    if (current === boundary || parent === current) return undefined;
    if (!parent.startsWith(boundary)) return undefined;
    current = parent;
  }
}

async function hasRootMarker(directory: string): Promise<boolean> {
  for (const marker of ROOT_MARKERS) {
    try {
      await access(join(directory, marker));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
