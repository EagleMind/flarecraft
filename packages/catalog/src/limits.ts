/**
 * Platform limits the lint rules check against.
 *
 * Every entry carries a `confidence`. Values marked "verify" are encoded from
 * memory and MUST be confirmed against the linked docs page before the rule
 * that consumes them is allowed to report an error rather than a warning —
 * a linter that confidently cites a wrong number is worse than no linter.
 * `assertVerifiedLimits()` below is the enforcement point.
 */

export interface PlatformLimit {
  id: string;
  label: string;
  free?: number;
  paid?: number;
  unit: string;
  confidence: "high" | "verify";
  docs: string;
  note?: string;
}

export const LIMITS: Record<string, PlatformLimit> = {
  subrequests: {
    id: "subrequests",
    label: "Subrequests per invocation",
    free: 50,
    paid: 1000,
    unit: "requests",
    confidence: "high",
    docs: "https://developers.cloudflare.com/workers/platform/limits/#subrequests",
    note: "Service binding calls and fetches to bound resources both count. This is the ceiling a deep Worker chain with fan-out runs into first.",
  },

  simultaneousConnections: {
    id: "simultaneousConnections",
    label: "Simultaneous open connections",
    free: 6,
    paid: 6,
    unit: "connections",
    confidence: "high",
    docs: "https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections",
  },

  cpuTime: {
    id: "cpuTime",
    label: "CPU time per invocation",
    free: 10,
    paid: 30_000,
    unit: "ms",
    confidence: "verify",
    docs: "https://developers.cloudflare.com/workers/platform/limits/#cpu-time",
    note: "Paid is the configurable default, raisable via limits.cpu_ms. Wall-clock is not capped the same way.",
  },

  scriptSize: {
    id: "scriptSize",
    label: "Worker script size, compressed",
    free: 3,
    paid: 10,
    unit: "MB",
    confidence: "verify",
    docs: "https://developers.cloudflare.com/workers/platform/limits/#worker-size",
  },

  queueMaxBatchSize: {
    id: "queueMaxBatchSize",
    label: "Queue consumer max_batch_size",
    paid: 100,
    unit: "messages",
    confidence: "high",
    docs: "https://developers.cloudflare.com/queues/platform/limits/",
  },

  queueMaxBatchTimeout: {
    id: "queueMaxBatchTimeout",
    label: "Queue consumer max_batch_timeout",
    paid: 60,
    unit: "seconds",
    confidence: "high",
    docs: "https://developers.cloudflare.com/queues/platform/limits/",
  },

  queueMaxRetries: {
    id: "queueMaxRetries",
    label: "Queue consumer max_retries",
    paid: 100,
    unit: "retries",
    confidence: "verify",
    docs: "https://developers.cloudflare.com/queues/platform/limits/",
  },

  queueMaxConcurrency: {
    id: "queueMaxConcurrency",
    label: "Queue consumer max_concurrency",
    paid: 250,
    unit: "invocations",
    confidence: "verify",
    docs: "https://developers.cloudflare.com/queues/platform/limits/",
  },

  kvValueSize: {
    id: "kvValueSize",
    label: "KV value size",
    free: 25,
    paid: 25,
    unit: "MiB",
    confidence: "high",
    docs: "https://developers.cloudflare.com/kv/platform/limits/",
  },

  kvKeySize: {
    id: "kvKeySize",
    label: "KV key size",
    free: 512,
    paid: 512,
    unit: "bytes",
    confidence: "high",
    docs: "https://developers.cloudflare.com/kv/platform/limits/",
  },
};

export type Plan = "free" | "paid";

export function limitFor(id: string, plan: Plan): number | undefined {
  const limit = LIMITS[id];
  if (!limit) return undefined;
  return plan === "free" ? (limit.free ?? limit.paid) : (limit.paid ?? limit.free);
}

/** Limits still needing confirmation against the docs. Surfaced in the UI. */
export function unverifiedLimits(): PlatformLimit[] {
  return Object.values(LIMITS).filter((l) => l.confidence === "verify");
}

/**
 * Guard for rules that want to report a hard error. A rule citing an unverified
 * number must downgrade itself to a warning rather than assert a threshold it
 * cannot stand behind.
 */
export function canAssertLimit(id: string): boolean {
  return LIMITS[id]?.confidence === "high";
}
