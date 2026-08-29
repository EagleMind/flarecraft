import type { NodeKind } from "./nodes.js";

/**
 * Node ids are derived, not random, so that the same resource seen through
 * different importers collapses to one node. A D1 database found in a local
 * wrangler config and the same database found by the account scan must produce
 * the same id, otherwise the drift diff reports every resource twice.
 *
 * The identity used per kind is the one Cloudflare treats as unique:
 *   - resources are unique by name within an account
 *   - a Durable Object class is unique by (defining script, class name)
 */
export function nodeId(kind: NodeKind, ...identity: string[]): string {
  const key = identity
    .filter((part) => part.length > 0)
    .map((part) => part.trim())
    .join(":");
  return `${kind}:${key}`;
}

export function workerId(name: string): string {
  return nodeId("worker", name);
}

/**
 * A DO binding may point at a class in another script (`script_name`). When it
 * is omitted the class lives in the binding Worker itself, so the caller passes
 * its own name — never leave the script segment empty, or two different scripts
 * exporting a class of the same name would collide into one node.
 */
export function durableObjectId(scriptName: string, className: string): string {
  return nodeId("durable_object", scriptName, className);
}

export function edgeId(
  from: string,
  to: string,
  kind: string,
  bindingName?: string,
): string {
  return [from, "->", to, kind, bindingName ?? ""].join("|");
}
