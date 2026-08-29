import { PRIMITIVES } from "./primitives.js";

/**
 * The primitive chooser.
 *
 * This answers the question Cloudflare's docs structurally cannot: not "what is
 * a Durable Object" but "should I use one *here*, and if not, what instead".
 * Each primitive's own page describes it in isolation; nothing compares them
 * under your constraints, which is exactly where weeks get lost.
 *
 * Deliberately rule-based rather than model-driven. A recommendation you cannot
 * audit is worth very little when it is about to shape a system that is painful
 * to reverse — so every point scored carries the sentence that justifies it,
 * and every rejection names what ruled it out.
 */

export type WorkShape = "request" | "event" | "schedule" | "long-running";
export type Cardinality = "single" | "bounded" | "per-entity";
export type Serialization = "required" | "not-required" | "no-writes";
export type Consistency = "read-after-write" | "eventual-ok";
export type Duration = "sub-second" | "seconds" | "minutes" | "hours";
export type AccessPattern =
  | "key-lookup"
  | "relational"
  | "blob"
  | "vector"
  | "append-only"
  | "none";
export type Runtime = "javascript" | "native";
export type ExistingDatabase = "none" | "postgres-or-mysql";

export interface Requirements {
  shape: WorkShape;
  cardinality: Cardinality;
  serialization: Serialization;
  consistency: Consistency;
  duration: Duration;
  access: AccessPattern;
  runtime: Runtime;
  existingDatabase: ExistingDatabase;
}

export const DEFAULT_REQUIREMENTS: Requirements = {
  shape: "request",
  cardinality: "bounded",
  serialization: "not-required",
  consistency: "eventual-ok",
  duration: "sub-second",
  access: "none",
  runtime: "javascript",
  existingDatabase: "none",
};

export interface Candidate {
  kind: string;
  label: string;
  score: number;
  reasons: string[];
  /** Set when a hard constraint rules the primitive out entirely. */
  disqualifiedBecause?: string;
}

export interface Decision {
  role: "compute" | "storage";
  chosen?: Candidate;
  /** Ranked, best first. The top entry is the one worth arguing about. */
  rejected: Candidate[];
}

export interface ProposedTopology {
  nodes: { kind: string; name: string }[];
  edges: { from: string; to: string; bindingName?: string }[];
}

export interface Recommendation {
  decisions: Decision[];
  topology: ProposedTopology;
  /** Things that are legal but that you will regret. */
  warnings: string[];
}

interface Rule {
  kind: string;
  when: (r: Requirements) => boolean;
  score?: number;
  reason?: string;
  /** A hard constraint: the primitive cannot do this job at all. */
  disqualify?: string;
}

const COMPUTE_RULES: Rule[] = [
  {
    kind: "worker",
    when: (r) => r.shape === "request",
    score: 3,
    reason: "The work is triggered by an HTTP request, which is what a Worker is.",
  },
  {
    kind: "worker",
    when: (r) => r.duration === "sub-second" || r.duration === "seconds",
    score: 1,
    reason: "The work finishes inside a request lifetime.",
  },
  {
    kind: "worker",
    when: (r) => r.serialization === "required",
    disqualify:
      "A Worker has no identity between requests, so it cannot serialize writes to a single entity — two concurrent requests would race.",
  },
  {
    kind: "worker",
    when: (r) => r.duration === "hours",
    disqualify:
      "Work measured in hours outlives a Worker invocation; it needs something that can checkpoint and resume.",
  },
  {
    kind: "worker",
    when: (r) => r.runtime === "native",
    disqualify: "workerd does not run native binaries.",
  },

  {
    kind: "durable_object",
    when: (r) => r.serialization === "required",
    score: 4,
    reason:
      "Writes to one entity must be serialized, and a Durable Object is single-threaded per id — that is precisely the guarantee.",
  },
  {
    kind: "durable_object",
    when: (r) => r.cardinality === "per-entity",
    score: 2,
    reason:
      "One object per entity keeps each instance small and independently addressable.",
  },
  {
    kind: "durable_object",
    when: (r) => r.consistency === "read-after-write",
    score: 1,
    reason: "Reads see writes immediately within an object.",
  },
  {
    kind: "durable_object",
    when: (r) => r.runtime === "native",
    disqualify: "Durable Objects run on workerd and cannot execute native binaries.",
  },
  {
    kind: "durable_object",
    when: (r) => r.duration === "hours",
    disqualify:
      "A single Durable Object invocation is not a durable multi-hour execution; use a Workflow and let it call the object.",
  },

  {
    kind: "workflow",
    when: (r) => r.shape === "long-running",
    score: 4,
    reason:
      "A multi-step process that must survive failure is what Workflows exist for.",
  },
  {
    kind: "workflow",
    when: (r) => r.duration === "minutes" || r.duration === "hours",
    score: 2,
    reason:
      "Steps checkpoint, so a failure hours in resumes rather than restarts from the top.",
  },
  {
    kind: "workflow",
    when: (r) => r.shape === "request",
    disqualify:
      "A Workflow is not a request handler — something still has to receive the request and start it.",
  },
  {
    kind: "workflow",
    when: (r) => r.runtime === "native",
    disqualify: "Workflows run on workerd and cannot execute native binaries.",
  },

  {
    kind: "container",
    when: (r) => r.runtime === "native",
    score: 5,
    reason:
      "A native binary, a real filesystem, or an unsupported runtime leaves no alternative.",
  },
  {
    kind: "container",
    when: (r) => r.duration === "minutes" || r.duration === "hours",
    score: 1,
    reason: "Long compute is not bounded by Worker CPU limits here.",
  },
  {
    kind: "container",
    when: (r) => r.runtime === "javascript",
    disqualify:
      "The work runs fine on workerd, and containers cost considerably more and start slower.",
  },
];

const STORAGE_RULES: Rule[] = [
  {
    kind: "hyperdrive",
    when: (r) => r.existingDatabase === "postgres-or-mysql",
    score: 5,
    reason:
      "There is already a SQL database; Hyperdrive makes it reachable from Workers and pools the connections.",
  },
  {
    kind: "hyperdrive",
    when: (r) => r.existingDatabase === "none",
    disqualify: "Hyperdrive fronts an existing database, and there is not one.",
  },

  {
    kind: "d1_database",
    when: (r) => r.access === "relational",
    score: 4,
    reason: "The access pattern is relational, so it wants SQL.",
  },
  {
    kind: "d1_database",
    when: (r) => r.consistency === "read-after-write",
    score: 1,
    reason: "Reads see committed writes.",
  },
  {
    kind: "d1_database",
    when: (r) => r.existingDatabase === "postgres-or-mysql",
    disqualify:
      "A database already exists; adding D1 would split the same data across two stores.",
  },
  {
    kind: "d1_database",
    when: (r) => r.access === "blob",
    disqualify: "Large objects do not belong in a SQL row.",
  },
  {
    kind: "d1_database",
    when: (r) => r.cardinality === "per-entity" && r.serialization === "required",
    disqualify:
      "One database serializes writes globally rather than per entity, so per-entity write throughput would be capped by a single writer.",
  },

  {
    kind: "kv_namespace",
    when: (r) => r.access === "key-lookup" && r.consistency === "eventual-ok",
    score: 4,
    reason:
      "Key lookups that tolerate staleness are exactly KV's shape, and reads are fast everywhere.",
  },
  {
    kind: "kv_namespace",
    when: (r) => r.consistency === "read-after-write",
    disqualify:
      "KV is eventually consistent — a read straight after a write can return the previous value.",
  },
  {
    kind: "kv_namespace",
    when: (r) => r.access === "relational",
    disqualify: "KV cannot answer relational queries; it only fetches by key.",
  },
  {
    kind: "kv_namespace",
    when: (r) => r.access === "blob",
    disqualify: "KV values are capped well below object-storage sizes.",
  },
  {
    kind: "kv_namespace",
    when: (r) => r.serialization === "required",
    disqualify:
      "KV cannot coordinate concurrent writers; two writers will silently clobber each other.",
  },

  {
    kind: "r2_bucket",
    when: (r) => r.access === "blob",
    score: 5,
    reason: "Files and large objects are what R2 is for, and egress is free.",
  },
  {
    kind: "r2_bucket",
    when: (r) => r.access !== "blob",
    disqualify: "The access pattern is not object storage.",
  },

  {
    kind: "vectorize_index",
    when: (r) => r.access === "vector",
    score: 5,
    reason: "Similarity search over embeddings needs a vector index.",
  },
  {
    kind: "vectorize_index",
    when: (r) => r.access !== "vector",
    disqualify: "There is no similarity search here.",
  },

  {
    kind: "analytics_engine_dataset",
    when: (r) => r.access === "append-only",
    score: 4,
    reason:
      "High-volume append-only events are what Analytics Engine is built to swallow.",
  },
  {
    kind: "analytics_engine_dataset",
    when: (r) => r.access !== "append-only",
    disqualify: "Individual records need to be read back, which this cannot do.",
  },

  {
    kind: "durable_object",
    when: (r) => r.serialization === "required" && r.cardinality === "per-entity",
    score: 4,
    reason:
      "Each entity's state lives in its own object's SQLite, so writes serialize per entity rather than globally.",
  },
  {
    kind: "durable_object",
    when: (r) => r.access === "blob" || r.access === "vector",
    disqualify: "This is not what a Durable Object's storage is for.",
  },
  {
    kind: "durable_object",
    when: (r) => r.serialization !== "required",
    disqualify:
      "Nothing here needs serialized writes, and a Durable Object is a heavier tool than the job calls for.",
  },
];

function evaluate(rules: Rule[], requirements: Requirements): Candidate[] {
  const byKind = new Map<string, Candidate>();

  for (const rule of rules) {
    const candidate = byKind.get(rule.kind) ?? {
      kind: rule.kind,
      label: PRIMITIVES[rule.kind]?.label ?? rule.kind,
      score: 0,
      reasons: [],
    };
    byKind.set(rule.kind, candidate);

    if (!rule.when(requirements)) continue;

    if (rule.disqualify) {
      // First disqualification wins: it is the most specific reason the rule
      // table had, and stacking them makes the explanation worse, not better.
      candidate.disqualifiedBecause ??= rule.disqualify;
      continue;
    }
    if (rule.score) {
      candidate.score += rule.score;
      if (rule.reason) candidate.reasons.push(rule.reason);
    }
  }

  return [...byKind.values()].sort((a, b) => {
    const aOut = a.disqualifiedBecause ? 1 : 0;
    const bOut = b.disqualifiedBecause ? 1 : 0;
    if (aOut !== bOut) return aOut - bOut;
    return b.score - a.score;
  });
}

function decide(
  role: Decision["role"],
  rules: Rule[],
  requirements: Requirements,
): Decision {
  const ranked = evaluate(rules, requirements);
  const viable = ranked.filter((c) => !c.disqualifiedBecause && c.score > 0);
  const chosen = viable[0];
  return {
    role,
    ...(chosen ? { chosen } : {}),
    rejected: ranked.filter((c) => c !== chosen),
  };
}

/** Triggers follow from the shape of the work; there is nothing to weigh. */
function triggerFor(shape: WorkShape): string | undefined {
  switch (shape) {
    case "request":
      return "route";
    case "schedule":
      return "cron";
    case "event":
      return "queue";
    case "long-running":
      return undefined;
  }
}

export function recommend(requirements: Requirements): Recommendation {
  const compute = decide("compute", COMPUTE_RULES, requirements);
  const storage =
    requirements.access === "none"
      ? { role: "storage" as const, rejected: [] }
      : decide("storage", STORAGE_RULES, requirements);

  const warnings: string[] = [];
  const nodes: ProposedTopology["nodes"] = [];
  const edges: ProposedTopology["edges"] = [];

  // Something must still receive the request, even when the real work happens
  // in a Workflow or a Container — neither is reachable from the internet.
  const needsEntryWorker =
    compute.chosen?.kind !== "worker" || requirements.shape !== "long-running";
  if (needsEntryWorker) nodes.push({ kind: "worker", name: "api" });

  const trigger = triggerFor(requirements.shape);
  if (trigger === "queue") {
    nodes.push({ kind: "queue", name: "jobs" });
    edges.push({ from: "jobs", to: "api" });
  } else if (trigger) {
    nodes.push({ kind: trigger, name: trigger === "cron" ? "0 * * * *" : "example.com/*" });
    edges.push({ from: trigger === "cron" ? "0 * * * *" : "example.com/*", to: "api" });
  }

  if (compute.chosen && compute.chosen.kind !== "worker") {
    const name = compute.chosen.kind === "durable_object" ? "Entity" : compute.chosen.kind;
    nodes.push({ kind: compute.chosen.kind, name });
    edges.push({ from: "api", to: name });
  }

  if (storage.chosen) {
    const name = storage.chosen.kind.replace(/_(namespace|database|bucket|index|dataset)$/, "");
    // Durable Object storage is the object itself — it must not be added twice.
    if (!nodes.some((n) => n.kind === storage.chosen!.kind)) {
      nodes.push({ kind: storage.chosen.kind, name });
      edges.push({ from: "api", to: name });
    }
  }

  if (requirements.cardinality === "single" && compute.chosen?.kind === "durable_object") {
    warnings.push(
      "A single Durable Object instance is a global bottleneck: every request on the planet serializes through one object. Shard by a key if you can.",
    );
  }
  if (requirements.shape === "schedule" && requirements.duration !== "sub-second") {
    warnings.push(
      "Nothing prevents cron runs from overlapping. If a run can exceed its interval, guard it with a lock or move the work into a Workflow.",
    );
  }
  if (trigger === "queue") {
    warnings.push(
      "Configure a dead-letter queue before this ships. Without one, a poison message retries until it is dropped and you never find out.",
    );
  }

  return { decisions: [compute, storage], topology: { nodes, edges }, warnings };
}
