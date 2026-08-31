import { execFile } from "node:child_process";
import { access, cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { groupReadiness, subsystemForGroup, type SystemModel } from "@flarecraft/model";
import { emitBlueprint } from "@flarecraft/wrangler-io";
import { projectRootFor } from "@flarecraft/wrangler-io/fs";
import { ExportError } from "./export.js";

const run = promisify(execFile);

/**
 * Pulling a group's scattered projects into one folder.
 *
 * The governing rule is that **sources are never modified**. Everything is a
 * copy, so a failure part-way through costs you nothing but a half-filled
 * destination you can delete. There is no move, no rollback to get wrong, and
 * no window in which your original repositories are gone.
 *
 * What is left behind is deliberate too: `node_modules` and build output are
 * skipped because they are large, machine-specific, and reproducible from the
 * lockfile — which is why an install runs afterwards.
 */

/**
 * Not copied.
 *
 * `.git` is on this list on purpose. The originals keep the history, and a
 * repository nested inside another project folder produces genuinely confusing
 * git behaviour — embedded repos that look tracked but are not.
 */
const EXCLUDED = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  "dist",
  "build",
  ".next",
  ".open-next",
  ".vercel",
  "coverage",
  ".turbo",
  ".cache",
]);

const LOCKFILES: { file: string; manager: string; install: string[] }[] = [
  { file: "pnpm-lock.yaml", manager: "pnpm", install: ["pnpm", "install"] },
  { file: "package-lock.json", manager: "npm", install: ["npm", "install"] },
  { file: "yarn.lock", manager: "yarn", install: ["yarn", "install"] },
  { file: "bun.lockb", manager: "bun", install: ["bun", "install"] },
];

export interface OrganizeMember {
  /** Workers whose source lives in this folder — usually one, sometimes more. */
  workers: string[];
  source: string;
  /** Folder name inside the destination. */
  target: string;
  files: number;
  bytes: number;
  manager: string;
  /** Set when more than one lockfile is present and we had to pick. */
  managerAmbiguous?: string;
}

export interface OrganizePlan {
  destination: string;
  groupName: string;
  members: OrganizeMember[];
  /** Things that must be resolved before this can run. */
  blockers: string[];
  /** Things worth knowing that do not stop it. */
  notices: string[];
}

export interface OrganizeResult extends OrganizePlan {
  copied: string[];
  installs: { target: string; command: string; ok: boolean; output: string }[];
  completed: boolean;
}

export interface OrganizeRequest {
  system: SystemModel;
  groupId: string;
  destination: string;
  /** Roots the local scan came from, used to bound the project-root walk. */
  scanRoots: string[];
  /**
   * Install dependencies in each copied folder afterwards. On by default —
   * node_modules was deliberately not copied, so without this the folders are
   * source-only. Worth turning off on a slow connection, or when you would
   * rather run the installs yourself.
   */
  install?: boolean;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** True when any segment of the path is excluded. */
function isExcluded(path: string, root: string): boolean {
  const rel = relative(root, path);
  if (!rel) return false;
  return rel.split(/[\\/]/).some((segment) => EXCLUDED.has(segment));
}

/** File count and size after exclusions, so the preview is honest about scale. */
async function measure(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;

  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // unreadable subtree; the readability check reports it separately
    }
    for (const entry of entries) {
      if (EXCLUDED.has(entry)) continue;
      const full = join(dir, entry);
      try {
        const info = await stat(full);
        if (info.isDirectory()) await walk(full);
        else {
          files += 1;
          bytes += info.size;
        }
      } catch {
        continue;
      }
    }
  };

  await walk(root);
  return { files, bytes };
}

async function detectManager(
  root: string,
): Promise<{ manager: string; install: string[]; ambiguous?: string }> {
  const present = [];
  for (const candidate of LOCKFILES) {
    if (await exists(join(root, candidate.file))) present.push(candidate);
  }

  if (present.length === 0) {
    // No lockfile is not an error — plenty of small Workers have none. npm is
    // the safe default because it needs no extra tooling installed.
    return { manager: "npm (no lockfile)", install: ["npm", "install"] };
  }
  const chosen = present[0]!;
  return present.length > 1
    ? {
        manager: chosen.manager,
        install: chosen.install,
        ambiguous: `${basename(root)} has ${present.length} lockfiles (${present
          .map((p) => p.file)
          .join(", ")}); using ${chosen.manager}.`,
      }
    : { manager: chosen.manager, install: chosen.install };
}

export async function planOrganize(
  request: OrganizeRequest,
): Promise<OrganizePlan> {
  const destination = request.destination?.trim();
  if (!destination) throw new ExportError("No destination folder.");
  if (!isAbsolute(destination)) {
    throw new ExportError("The destination must be an absolute path.");
  }

  const resolved = resolve(destination);
  const blockers: string[] = [];
  const notices: string[] = [];

  const readiness = groupReadiness(request.system, request.groupId);
  const group = (request.system.groups ?? []).find((g) => g.id === request.groupId);

  // The user's rule: block until every Worker has a folder. No stubs.
  for (const worker of readiness.missing) {
    blockers.push(
      `${worker.name} has no local folder. Locate it, or take it out of this group.`,
    );
  }
  if (readiness.workers.length === 0) {
    blockers.push("This group has no Workers, so there is nothing to consolidate.");
  }

  // One folder can hold several Workers — flowrite's config sits under a
  // `server/` subfolder, for instance — so sources are keyed and copied once.
  const bySource = new Map<string, string[]>();
  for (const worker of readiness.located) {
    const root = await findRoot(worker.configPath!, request.scanRoots);
    if (!root) {
      blockers.push(
        `Could not tell which folder ${worker.name} belongs to from ${worker.configPath}. Locate it manually.`,
      );
      continue;
    }
    bySource.set(root, [...(bySource.get(root) ?? []), worker.name]);
  }

  const members: OrganizeMember[] = [];
  const takenTargets = new Set<string>();

  for (const [source, workers] of bySource) {
    if (!(await exists(source))) {
      blockers.push(`${source} no longer exists.`);
      continue;
    }
    try {
      await access(source, constants.R_OK);
    } catch {
      blockers.push(`No permission to read ${source}.`);
      continue;
    }

    const [{ files, bytes }, manager] = await Promise.all([
      measure(source),
      detectManager(source),
    ]);
    if (manager.ambiguous) notices.push(manager.ambiguous);

    // Two different sources can share a basename; keep target names unique.
    let target = basename(source);
    for (let n = 2; takenTargets.has(target); n += 1) target = `${basename(source)}-${n}`;
    takenTargets.add(target);

    members.push({ workers, source, target, files, bytes, manager: manager.manager });
    if (workers.length > 1) {
      notices.push(`${target} holds ${workers.length} Workers and is copied once.`);
    }
  }

  await checkDestination(resolved, blockers);

  if (members.length > 0) {
    notices.push(
      "node_modules, build output, and .git are not copied. Your original folders are left exactly as they are.",
      "Each project keeps its own lockfile and gets its own install, so nothing here becomes a workspace.",
    );
  }

  return {
    destination: resolved,
    groupName: group?.name ?? "system",
    members,
    blockers,
    notices,
  };
}

async function findRoot(
  configPath: string,
  scanRoots: string[],
): Promise<string | undefined> {
  for (const root of scanRoots) {
    if (!configPath.startsWith(resolve(root))) continue;
    const found = await projectRootFor(configPath, root);
    if (found) return found;
  }
  return undefined;
}

/** Writable, and empty enough that this cannot bury an existing project. */
async function checkDestination(destination: string, blockers: string[]): Promise<void> {
  try {
    const entries = await readdir(destination);
    if (entries.length > 0) {
      blockers.push(
        `${destination} is not empty. Choose an empty folder so nothing already there is buried.`,
      );
    }
    try {
      await access(destination, constants.W_OK);
    } catch {
      blockers.push(`No permission to write to ${destination}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      blockers.push(`Cannot open ${destination}: ${(error as Error).message}`);
      return;
    }
    // Does not exist yet: check the parent can take a new folder.
    const parent = resolve(destination, "..");
    try {
      await access(parent, constants.W_OK);
    } catch {
      blockers.push(`Cannot create ${destination} — no permission to write to ${parent}.`);
    }
  }
}

export async function runOrganize(
  request: OrganizeRequest,
): Promise<OrganizeResult> {
  const plan = await planOrganize(request);
  if (plan.blockers.length > 0) {
    return { ...plan, copied: [], installs: [], completed: false };
  }

  await mkdir(plan.destination, { recursive: true });
  const copied: string[] = [];

  for (const member of plan.members) {
    const target = resolve(plan.destination, member.target);

    // Generated names, but an escape here would be silent and unrecoverable.
    const inside = relative(plan.destination, target);
    if (inside.startsWith("..") || isAbsolute(inside) || inside.split(sep)[0] === "..") {
      throw new ExportError(`Refusing to write outside the destination: ${member.target}`);
    }

    await cp(member.source, target, {
      recursive: true,
      // The filter is what implements the exclusions; returning false for a
      // directory skips its whole subtree.
      filter: (src) => !isExcluded(src, member.source),
    });
    copied.push(member.target);
  }

  const subsystem = subsystemForGroup(request.system, request.groupId, plan.groupName);
  await writeFile(
    join(plan.destination, "BLUEPRINT.md"),
    emitBlueprint(subsystem),
    "utf8",
  );
  await writeFile(join(plan.destination, "README.md"), readme(plan), "utf8");

  // Install last, and never fatal: the files are already on disk, so a flaky
  // network must not cost you the copy.
  const installs: OrganizeResult["installs"] = [];
  for (const member of request.install === false ? [] : plan.members) {
    const target = resolve(plan.destination, member.target);
    const { install } = await detectManager(member.source);
    const [command, ...args] = install;
    try {
      const { stdout, stderr } = await run(command!, args, {
        cwd: target,
        shell: true,
        timeout: 600_000,
      });
      installs.push({
        target: member.target,
        command: install.join(" "),
        ok: true,
        output: `${stdout}${stderr}`.trim().slice(-2000),
      });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message: string };
      installs.push({
        target: member.target,
        command: install.join(" "),
        ok: false,
        output: (`${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message).slice(-2000),
      });
    }
  }

  return { ...plan, copied, installs, completed: true };
}

function readme(plan: OrganizePlan): string {
  return [
    `# ${plan.groupName}`,
    "",
    "Assembled by flarecraft from projects that were scattered across your disk.",
    "See **BLUEPRINT.md** for what this system is and how the pieces connect.",
    "",
    "## Where this came from",
    "",
    "| Folder | Copied from | Workers |",
    "|---|---|---|",
    ...plan.members.map(
      (m) => `| \`${m.target}\` | \`${m.source}\` | ${m.workers.join(", ")} |`,
    ),
    "",
    "**Your originals were not touched.** Everything above was copied, not moved,",
    "so the folders listed in the middle column are still exactly where they were.",
    "Delete them yourself once you are satisfied this copy is right.",
    "",
    "## What was left behind",
    "",
    "`node_modules`, build output (`dist`, `build`, `.next`, `.open-next`,",
    "`.vercel`), `.wrangler`, `coverage`, and `.git`.",
    "",
    "`.git` is excluded deliberately: the originals keep the history, and nested",
    "repositories inside one project folder behave confusingly. If you want this",
    "to be version controlled, `git init` here and commit it as one project.",
    "",
    "## Layout",
    "",
    "Each folder is self-contained, with its own lockfile and its own",
    "dependencies — this is not a workspace. Run commands inside the folder you",
    "mean, not at the root.",
    "",
  ].join("\n");
}
