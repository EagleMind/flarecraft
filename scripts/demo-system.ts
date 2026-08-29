/**
 * Build a small but realistic system and scaffold it to a folder.
 *
 * Exists to exercise the whole round trip in one command: design → project on
 * disk → (you write handlers) → reopen → deploy. The shape is deliberately
 * ordinary — an API, a database, a queue, a consumer — because the interesting
 * question is whether the scaffold is something you can actually work in, not
 * whether it can draw something exotic.
 *
 *   pnpm tsx scripts/demo-system.ts <folder>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  addNode,
  connect,
  emptySystem,
  patchConsumer,
  type NodeKind,
  type SystemModel,
} from "@flarecraft/model";
import { scaffoldProject } from "@flarecraft/wrangler-io";

const folder = resolve(process.argv[2] ?? "./demo-orders");

let system: SystemModel = emptySystem("orders", "orders");

const place = (kind: NodeKind, name: string, x: number, y: number) => {
  const result = addNode(system, kind, { x, y }, name);
  system = result.system;
  return result.node;
};

const link = (fromId: string, toId: string, binding?: string) => {
  const result = connect(system, fromId, toId, binding);
  if (result.rejected) throw new Error(result.rejected);
  system = result.system;
  return result.edge!;
};

// Ingress → API → storage, with the slow half pushed onto a queue.
const route = place("route", "orders.example.com/*", 0, 100);
const api = place("worker", "orders-api", 300, 100);
const db = place("d1_database", "orders-db", 640, 40);
const events = place("queue", "order-events", 640, 180);
const dlq = place("queue", "order-events-dlq", 640, 300);
const processor = place("worker", "order-processor", 960, 180);
const receipts = place("r2_bucket", "order-receipts", 1280, 180);

link(route.id, api.id);
link(api.id, db.id, "DB");
link(api.id, events.id, "EVENTS");

const consuming = link(events.id, processor.id);
// A dead-letter queue from the start: adding one later leaves the window
// before you did unrecoverable.
system = patchConsumer(system, consuming.id, {
  maxBatchSize: 25,
  maxBatchTimeout: 10,
  maxRetries: 3,
  deadLetterQueue: dlq.name,
});

// Both Workers read the same database — the case where a topology view earns
// its keep, because nothing in the Cloudflare dashboard shows you the second one.
link(processor.id, db.id, "DB");
link(processor.id, receipts.id, "RECEIPTS");

const { files, warnings } = scaffoldProject(system);

for (const file of files) {
  const path = join(folder, file.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.contents, "utf8");
}

console.log(`\n${system.nodes.length} elements, ${system.edges.length} connections`);
console.log(`${files.length} files written to ${folder}\n`);

for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
  console.log(`  ${file.owned ? "regenerated" : "yours      "}  ${file.path}`);
}

if (warnings.length > 0) {
  console.log("\nwarnings");
  for (const warning of warnings) console.log(`  ${warning}`);
}
