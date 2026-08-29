/**
 * End-to-end proof that the emitter produces deployable configs.
 *
 * Round-trip tests prove the model survives; they do not prove wrangler will
 * accept the result. `wrangler deploy --dry-run` is the only thing that does —
 * it validates the config, resolves bindings, and bundles the entry point,
 * without touching the network or needing credentials.
 *
 *   pnpm tsx scripts/verify-emit.ts [outDir]
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  addNode,
  connect,
  emptySystem,
  type SystemModel,
} from "@flarecraft/model";
import { emitRepo } from "@flarecraft/wrangler-io";

const run = promisify(execFile);

/** A system exercising the binding kinds most likely to be emitted wrong. */
function buildSystem(): SystemModel {
  let system = emptySystem("verify", "Verification system");

  const place = (kind: Parameters<typeof addNode>[1], name: string) => {
    const result = addNode(system, kind, { x: 0, y: 0 }, name);
    system = result.system;
    return result.node;
  };

  const api = place("worker", "verify-api");
  const consumer = place("worker", "verify-consumer");
  const kv = place("kv_namespace", "verify-cache");
  const r2 = place("r2_bucket", "verify-uploads");
  const queue = place("queue", "verify-jobs");
  const ai = place("ai", "Workers AI");

  const link = (fromId: string, toId: string, binding?: string) => {
    const result = connect(system, fromId, toId, binding);
    if (result.rejected) throw new Error(result.rejected);
    system = result.system;
  };

  link(api.id, kv.id, "CACHE");
  link(api.id, r2.id, "UPLOADS");
  link(api.id, queue.id, "JOBS");
  link(api.id, ai.id, "AI");
  link(api.id, consumer.id, "CONSUMER");
  link(queue.id, consumer.id);

  return system;
}

const outDir = resolve(process.argv[2] ?? "./.verify-emit");

await rm(outDir, { recursive: true, force: true });
const { files, warnings } = emitRepo(buildSystem());

for (const file of files) {
  const path = join(outDir, file.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.contents, "utf8");
}

console.log(`emitted ${files.length} file(s) to ${outDir}\n`);
for (const warning of warnings) console.log(`  warning: ${warning}`);

// Placeholder ids are the expected state for a freshly designed system, but
// wrangler rejects them — swap in syntactically valid ids so the dry run
// exercises the config's structure rather than stopping at the first stub.
const PLACEHOLDER_IDS: Record<string, string> = {
  '"id": "REPLACE_ME"': '"id": "0123456789abcdef0123456789abcdef"',
  '"database_id": "REPLACE_ME"': '"database_id": "00000000-0000-4000-8000-000000000000"',
};

const workerDirs = files
  .filter((f) => f.path.endsWith("wrangler.jsonc"))
  .map((f) => dirname(f.path));

let failures = 0;
for (const dir of workerDirs) {
  const configPath = join(outDir, dir, "wrangler.jsonc");
  let contents = files.find((f) => f.path === `${dir}/wrangler.jsonc`)!.contents;
  for (const [from, to] of Object.entries(PLACEHOLDER_IDS)) {
    contents = contents.split(from).join(to);
  }
  await writeFile(configPath, contents, "utf8");

  try {
    const { stdout, stderr } = await run(
      "npx",
      ["--yes", "wrangler", "deploy", "--dry-run", "--config", configPath],
      { cwd: outDir, shell: true, timeout: 180_000 },
    );
    const output = `${stdout}${stderr}`;
    console.log(`\n✓ ${dir}`);
    for (const line of output.split("\n").filter((l) => /binding|Total|Your/i.test(l))) {
      console.log(`    ${line.trim()}`);
    }
  } catch (error) {
    failures += 1;
    const err = error as { stdout?: string; stderr?: string; message: string };
    console.log(`\n✗ ${dir}`);
    console.log(`${err.stderr ?? err.stdout ?? err.message}`.split("\n").slice(0, 25).join("\n"));
  }
}

console.log(
  `\n${workerDirs.length - failures}/${workerDirs.length} emitted Worker(s) passed wrangler's dry run.`,
);
process.exit(failures === 0 ? 0 : 1);
