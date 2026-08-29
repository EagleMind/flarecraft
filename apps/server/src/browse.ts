import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

/**
 * A folder picker, served from the machine rather than the browser.
 *
 * The obvious approach — `showDirectoryPicker()` — is the wrong one here. It
 * hands back a `FileSystemDirectoryHandle` whose `name` is the folder's own
 * name and nothing more; there is no absolute path, deliberately, and the
 * server needs an absolute path to scan or scaffold. `webkitdirectory` has the
 * same problem. So the filesystem is enumerated where it actually lives.
 *
 * Directories only. This never reads a file's contents — it checks for the
 * presence of a config to label the entry, and that is all.
 */

export interface BrowseEntry {
  name: string;
  path: string;
  /** Contains a wrangler config: worth scanning. */
  hasConfig: boolean;
  /** Contains a BLUEPRINT.md: a project flarecraft scaffolded. */
  isProject: boolean;
}

export interface BrowseResult {
  path: string;
  /**
   * What the current folder itself is, not just its children.
   *
   * Lets the caller tell "a folder holding one project" from "a folder holding
   * many unrelated repos" — which decides whether opening it should bind it for
   * syncing and deploying, or merely map it.
   */
  self: { hasConfig: boolean; isProject: boolean };
  /** Parent directory, or null at a filesystem root. */
  parent: string | null;
  entries: BrowseEntry[];
  /** Somewhere sensible to start, offered alongside the listing. */
  shortcuts: { label: string; path: string }[];
}

const CONFIG_NAMES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".open-next",
  ".wrangler",
  ".vercel",
  "coverage",
  "$RECYCLE.BIN",
  "System Volume Information",
]);

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

async function labelDirectory(path: string): Promise<Omit<BrowseEntry, "name" | "path">> {
  const [configChecks, blueprint] = await Promise.all([
    Promise.all(CONFIG_NAMES.map((name) => exists(join(path, name)))),
    exists(join(path, "BLUEPRINT.md")),
  ]);
  return { hasConfig: configChecks.some(Boolean), isProject: blueprint };
}

/** Drives that actually respond, so a dead mapped drive does not hang the list. */
async function windowsDrives(): Promise<{ label: string; path: string }[]> {
  if (process.platform !== "win32") return [];
  const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const found = await Promise.all(
    letters.map(async (letter) => {
      const path = `${letter}:\\`;
      return (await exists(path)) ? { label: path, path } : undefined;
    }),
  );
  return found.filter((drive): drive is { label: string; path: string } => Boolean(drive));
}

async function shortcuts(): Promise<{ label: string; path: string }[]> {
  const home = homedir();
  const candidates = [
    { label: "Home", path: home },
    { label: "Documents", path: join(home, "Documents") },
    { label: "Desktop", path: join(home, "Desktop") },
    { label: "Projects", path: join(home, "Projects") },
  ];

  const usable = await Promise.all(
    candidates.map(async (entry) => ((await exists(entry.path)) ? entry : undefined)),
  );
  return [
    ...usable.filter((e): e is { label: string; path: string } => Boolean(e)),
    ...(await windowsDrives()),
  ];
}

export async function browseDirectory(requested?: string): Promise<BrowseResult> {
  const path = resolve(requested?.trim() || homedir());

  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "EACCES" || code === "EPERM"
        ? `No permission to read ${path}.`
        : `Cannot open ${path}.`,
    );
  }

  const entries: BrowseEntry[] = [];
  for (const name of names) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const full = join(path, name);
    try {
      if (!(await stat(full)).isDirectory()) continue;
    } catch {
      // Junctions, permission-denied entries, and files being written all
      // throw here. Skipping one is far better than failing the listing.
      continue;
    }
    entries.push({ name, path: full, ...(await labelDirectory(full)) });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const parentPath = dirname(path);
  return {
    path,
    self: await labelDirectory(path),
    // `dirname` of a root returns the root itself; that is the signal there is
    // nowhere further up to go.
    parent: parentPath === path || parse(path).root === path ? null : parentPath,
    entries,
    shortcuts: await shortcuts(),
  };
}
