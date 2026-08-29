import { PRIMITIVES } from "./primitives.js";

/**
 * What the emitter writes where a resource has no id yet.
 *
 * It has to round-trip as *absent*, not as an id. Read back naively it makes a
 * resource that does not exist look created — so the deploy plan skips it, the
 * deploy fails, and the reason is three steps away from the symptom. Two
 * resources both awaiting ids would also collapse into one node.
 */
export const PLACEHOLDER_ID = "REPLACE_ME";

export const isPlaceholderId = (value: string | undefined): boolean =>
  value === undefined || value === PLACEHOLDER_ID;

/**
 * Picks the identity segment for a resource node.
 *
 * This has to be shared between the config parser and the account scanner or
 * the drift diff falls apart: the same D1 database read from disk and read from
 * the API must collapse to one node. The two importers see different things —
 * a wrangler config gives you `database_id` and often no readable name, while
 * the API gives you both — so identity is keyed on whichever field is stable
 * across both.
 *
 * For primitives that carry a Cloudflare-side id, that id wins. KV is the case
 * that forces this: `kv_namespaces` entries in a config have an `id` and a
 * binding variable, and no namespace title at all.
 */
export function resourceKey(
  kind: string,
  name: string | undefined,
  resourceId: string | undefined,
): string {
  const spec = PRIMITIVES[kind];
  if (spec?.requiresResourceId && resourceId && !isPlaceholderId(resourceId)) {
    return resourceId;
  }
  return name ?? resourceId ?? "unnamed";
}

/**
 * Display name when the config gives us nothing readable. Falls back to the
 * binding variable, which is at least meaningful to whoever wrote it, and is
 * replaced by the real title once an account scan merges over the top.
 */
export function resourceDisplayName(
  name: string | undefined,
  bindingName: string | undefined,
  resourceId: string | undefined,
): string {
  return name ?? bindingName ?? resourceId ?? "unnamed";
}

/**
 * Whether the name above is a stand-in rather than the resource's real title.
 *
 * This distinction has to travel with the node. A KV binding in a config knows
 * only `env.CACHE`, while the account listing knows the namespace is titled
 * "link-cache" — and whichever importer runs second must not overwrite a real
 * title with a binding variable. Merge precedence reads this flag.
 */
export function isFallbackName(name: string | undefined): boolean {
  return name === undefined;
}
