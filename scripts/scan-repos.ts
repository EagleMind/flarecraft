/**
 * Scan a directory tree for wrangler configs and print the topology found.
 *
 * This is the read-only half of flarecraft in its crudest form, and it is here
 * so the graph can be sanity-checked against reality without any UI:
 *
 *   pnpm tsx scripts/scan-repos.ts ../
 */
import { scanDirectory } from "@flarecraft/wrangler-io/fs";
import { findCycles, orphanNodes, type SystemModel } from "@flarecraft/model";
import { PRIMITIVES } from "@flarecraft/catalog";

const root = process.argv[2] ?? "..";
const { system, warnings, configPaths } = await scanDirectory(root, 4);

console.log(`\nscanned ${configPaths.length} config(s) under ${root}\n`);

printCounts(system);
printWorkers(system);
printWarnings(warnings);
printFindings(system);

function printCounts(system: SystemModel): void {
  const counts = new Map<string, number>();
  for (const node of system.nodes) {
    counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
  }
  console.log(`${system.nodes.length} nodes, ${system.edges.length} edges`);
  for (const [kind, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${PRIMITIVES[kind]?.label ?? kind}`);
  }
}

function printWorkers(system: SystemModel): void {
  console.log("\nworkers");
  for (const worker of system.nodes.filter((n) => n.kind === "worker")) {
    const out = system.edges.filter((e) => e.from === worker.id);
    const inbound = system.edges.filter((e) => e.to === worker.id);
    console.log(`\n  ${worker.name}  (${out.length} out, ${inbound.length} in)`);
    for (const edge of inbound) {
      const from = system.nodes.find((n) => n.id === edge.from);
      console.log(`      <- ${from?.name ?? edge.from}  [${edge.kind}]`);
    }
    for (const edge of out) {
      const to = system.nodes.find((n) => n.id === edge.to);
      const label = edge.bindingName ? `env.${edge.bindingName}` : edge.kind;
      console.log(`      -> ${to?.name ?? edge.to}  (${to?.kind}) ${label}`);
    }
  }
}

function printWarnings(warnings: { code: string; message: string }[]): void {
  if (warnings.length === 0) return;
  console.log(`\nparse warnings (${warnings.length})`);
  for (const w of warnings) console.log(`  ${w.code}: ${w.message}`);
}

function printFindings(system: SystemModel): void {
  console.log("\nfindings");

  const cycles = findCycles(system, new Set(["service" as const]));
  for (const cycle of cycles) {
    console.log(`  cycle: ${cycle.join(" -> ")}`);
  }

  const orphans = orphanNodes(system).filter((n) => n.kind !== "worker");
  for (const orphan of orphans) {
    console.log(`  orphan ${orphan.kind}: ${orphan.name}`);
  }

  const noCompatDate = system.nodes.filter(
    (n) => n.kind === "worker" && n.configPath && !n.worker?.compatibilityDate,
  );
  for (const worker of noCompatDate) {
    console.log(`  no compatibility_date: ${worker.name}`);
  }

  if (cycles.length + orphans.length + noCompatDate.length === 0) {
    console.log("  none");
  }
}
