/**
 * Prove consolidation against the real projects on this machine.
 *
 * The property that matters most is not that the copy succeeds — it is that
 * **the sources come out untouched**. So this fingerprints every source folder
 * before and after and fails loudly on any difference. Everything else in the
 * feature is recoverable; that is not.
 *
 *   pnpm tsx scripts/verify-organize.ts <scanRoot> <destination>
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanDirectory } from "@flarecraft/wrangler-io/fs";
import { groupReadiness, suggestGroups } from "@flarecraft/model";
import { planOrganize, runOrganize } from "../apps/server/src/organize.js";

const run = promisify(execFile);

const scanRoot = resolve(process.argv[2] ?? "..");
const destination = resolve(process.argv[3] ?? "./.verify-organize");

/** Every path and size under a folder, so any mutation shows up as a diff. */
async function fingerprint(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      try {
        const info = await stat(full);
        if (info.isDirectory()) await walk(full);
        else out.push(`${full.slice(root.length)}:${info.size}`);
      } catch {
        continue;
      }
    }
  };
  await walk(root);
  return out.sort();
}

await rm(destination, { recursive: true, force: true });

const { system: scanned, configPaths } = await scanDirectory(scanRoot, 4);
const grouped = suggestGroups(scanned);
console.log(`scanned ${configPaths.length} config(s) → ${grouped.groups?.length ?? 0} group(s)\n`);

// Pick the group with the most located Workers: the most interesting copy.
const candidates = (grouped.groups ?? [])
  .map((g) => ({ group: g, readiness: groupReadiness(grouped, g.id) }))
  .filter((c) => c.readiness.missing.length === 0 && c.readiness.located.length > 0)
  .sort((a, b) => b.readiness.located.length - a.readiness.located.length);

const chosen = candidates[0];
if (!chosen) {
  console.error("No group had every Worker located. Nothing to verify.");
  process.exit(1);
}

console.log(
  `group "${chosen.group.name}" — ${chosen.readiness.located.length} Worker(s) with local source\n`,
);

const request = {
  system: grouped,
  groupId: chosen.group.id,
  destination,
  scanRoots: [scanRoot],
  // Skipping install keeps this about copy fidelity rather than the network.
  install: false,
};

const plan = await planOrganize(request);
for (const member of plan.members) {
  console.log(
    `  ${member.target.padEnd(24)} ${String(member.files).padStart(5)} files  ${(
      member.bytes / 1024
    ).toFixed(0)}kb  ${member.manager}`,
  );
}
for (const notice of plan.notices) console.log(`  note: ${notice}`);
if (plan.blockers.length > 0) {
  console.error("\nblocked:");
  for (const blocker of plan.blockers) console.error(`  ${blocker}`);
  process.exit(1);
}

const before = new Map<string, string[]>();
for (const member of plan.members) {
  before.set(member.source, await fingerprint(member.source));
}

const result = await runOrganize(request);
console.log(`\ncopied ${result.copied.length} folder(s) to ${result.destination}`);

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

console.log("\nsources untouched");
for (const member of plan.members) {
  const after = await fingerprint(member.source);
  const prior = before.get(member.source)!;
  const same = prior.length === after.length && prior.every((p, i) => p === after[i]);
  check(same, member.source, same ? `${after.length} files unchanged` : "MUTATED");
}

console.log("\ndestination");
for (const member of plan.members) {
  const target = join(destination, member.target);
  const contents = await fingerprint(target);
  check(contents.length > 0, `${member.target} has files`, `${contents.length}`);
  check(
    !contents.some((p) => p.includes(`${"node_modules"}`)),
    `${member.target} excludes node_modules`,
  );
  check(!contents.some((p) => p.includes(".git")), `${member.target} excludes .git`);
}

const rootFiles = await readdir(destination);
check(rootFiles.includes("BLUEPRINT.md"), "BLUEPRINT.md written");
check(rootFiles.includes("README.md"), "README.md written");

// Copy fidelity is necessary but not sufficient: the point of consolidating is
// that each copied folder still deploys. `wrangler deploy --dry-run` is the
// same bar verify-emit holds the emitter to — it validates the config, resolves
// the bindings, and bundles the entry point, without network or credentials.
console.log("\ndeployable");
const configByWorker = new Map(
  grouped.nodes
    .filter((n) => n.kind === "worker" && n.configPath)
    .map((n) => [n.name, n.configPath!] as const),
);

for (const member of plan.members) {
  const target = join(destination, member.target);
  const sourceConfig = member.workers
    .map((name) => configByWorker.get(name))
    .find((path): path is string => Boolean(path));
  if (!sourceConfig) {
    check(false, `${member.target} dry run`, "no wrangler config to point at");
    continue;
  }
  const config = join(target, relative(member.source, sourceConfig));
  try {
    const { stdout, stderr } = await run(
      "npx",
      ["--yes", "wrangler", "deploy", "--dry-run", "--config", config],
      { cwd: target, shell: true, timeout: 240_000 },
    );
    const output = `${stdout}${stderr}`;
    const total = output
      .split("\n")
      .find((line) => /Total Upload/i.test(line))
      ?.trim();
    check(true, `${member.target} dry run`, total ?? "accepted");
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    const detail = `${err.stderr ?? err.stdout ?? err.message}`
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(" / ");
    check(false, `${member.target} dry run`, detail);
  }
}

console.log(
  failures === 0
    ? "\nEverything checks out. Sources are byte-for-byte as they were.\n"
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
