#!/usr/bin/env -S npx tsx
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { scanDirectory } from "@flarecraft/wrangler-io/fs";
import { CloudflareClient, scanAccount } from "@flarecraft/account";
import { diffSystems, lint } from "@flarecraft/rules";
import {
  DEFAULT_REQUIREMENTS,
  PRIMITIVES,
  recommend,
  type Requirements,
} from "@flarecraft/catalog";
import { incoming, outgoing, type Node, type SystemModel } from "@flarecraft/model";

/**
 * flarecraft as a set of tools for a coding agent.
 *
 * The reasoning behind this surface: an agent editing one Worker cannot see the
 * blast radius of its change, because the information is spread across configs
 * it has no reason to open. These tools answer the questions that require the
 * whole graph — who binds this, what breaks if I rename it, is this already
 * wrong — which is exactly what a per-file view cannot do.
 *
 * Everything here is read-only. An agent should be able to ask what the
 * topology is without being able to change it by accident.
 */

const server = new McpServer({ name: "flarecraft", version: "0.1.0" });

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/**
 * Two resources can share a display name when neither config carries a real
 * title — a KV namespace and a Hyperdrive config are both known only by the
 * binding variable someone chose. Appending the id is the difference between
 * "these are the same thing" and "these are two things".
 */
const identify = (node: Node): string =>
  node.nameIsFallback && node.resourceId
    ? `${node.name} [${node.resourceId}]`
    : node.name;

const CONFIG_PATH = join(homedir(), ".flarecraft", "config.json");

async function cloudflareCredentials(): Promise<
  { apiToken: string; accountId?: string } | undefined
> {
  try {
    const config = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as {
      cloudflare?: { apiToken?: string; accountId?: string };
    };
    const apiToken = config.cloudflare?.apiToken;
    if (!apiToken) return undefined;
    return {
      apiToken,
      ...(config.cloudflare?.accountId
        ? { accountId: config.cloudflare.accountId }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/** A compact rendering — an agent pays for every token of this. */
function summarise(system: SystemModel): string {
  const lines: string[] = [
    `${system.nodes.length} nodes, ${system.edges.length} edges`,
    "",
  ];

  for (const worker of system.nodes.filter((n) => n.kind === "worker")) {
    const out = outgoing(system, worker.id);
    const into = incoming(system, worker.id);
    lines.push(`${worker.name}${worker.configPath ? `  [${worker.configPath}]` : ""}`);

    for (const edge of into) {
      const from = system.nodes.find((n) => n.id === edge.from);
      lines.push(`  <- ${from ? identify(from) : edge.from} (${edge.kind})`);
    }
    for (const edge of out) {
      const to = system.nodes.find((n) => n.id === edge.to);
      const binding = edge.bindingName ? `env.${edge.bindingName}` : edge.kind;
      lines.push(`  -> ${to ? identify(to) : edge.to} [${to?.kind}] ${binding}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

server.registerTool(
  "scan_repos",
  {
    title: "Scan repositories for Cloudflare topology",
    description:
      "Parse every wrangler config under a directory and return the combined topology: Workers, the resources they bind, and the triggers that invoke them. Use this before changing a Worker to see what else is wired to the same resources.",
    inputSchema: {
      root: z.string().describe("Directory to scan for wrangler configs."),
      depth: z.number().optional().describe("Search depth. Defaults to 4."),
    },
  },
  async ({ root, depth }) => {
    const { system, configPaths, warnings } = await scanDirectory(root, depth ?? 4);
    return text(
      [
        `Scanned ${configPaths.length} config(s) under ${root}.`,
        "",
        summarise(system),
        warnings.length > 0
          ? `Parse warnings:\n${warnings.map((w) => `  ${w.code}: ${w.message}`).join("\n")}`
          : "",
      ].join("\n"),
    );
  },
);

server.registerTool(
  "who_binds",
  {
    title: "Find everything bound to a resource",
    description:
      "Given a resource name, list every Worker that binds it and the variable each uses. This is the reverse lookup the Cloudflare dashboard cannot do, because bindings are only stored in one direction — ask it before renaming or deleting anything.",
    inputSchema: {
      root: z.string().describe("Directory to scan."),
      name: z.string().describe("Resource, Worker, or class name."),
    },
  },
  async ({ root, name }) => {
    const { system } = await scanDirectory(root, 4);
    const matches = system.nodes.filter(
      (n) => n.name.toLowerCase() === name.toLowerCase(),
    );
    if (matches.length === 0) return text(`Nothing called "${name}" in ${root}.`);

    const lines: string[] = [];
    for (const node of matches) {
      lines.push(`${identify(node)} (${PRIMITIVES[node.kind]?.label ?? node.kind})`);

      const inbound = incoming(system, node.id);
      if (inbound.length === 0) {
        lines.push("  nothing binds or triggers it");
      }
      for (const edge of inbound) {
        const from = system.nodes.find((n) => n.id === edge.from);
        const binding = edge.bindingName ? ` as env.${edge.bindingName}` : "";
        lines.push(`  <- ${from ? identify(from) : edge.from} (${edge.kind})${binding}`);
      }
      for (const edge of outgoing(system, node.id)) {
        const to = system.nodes.find((n) => n.id === edge.to);
        const binding = edge.bindingName ? ` as env.${edge.bindingName}` : "";
        lines.push(`  -> ${to ? identify(to) : edge.to} (${edge.kind})${binding}`);
      }
      lines.push("");
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "lint_topology",
  {
    title: "Check a topology for known Cloudflare mistakes",
    description:
      "Run flarecraft's rules over the scanned topology: service-binding cycles, credentials in vars, Durable Object classes bound without a migration, queue batch sizes against the subrequest ceiling, missing dead-letter queues, cron collisions, and hygiene checks. Run this after changing bindings.",
    inputSchema: {
      root: z.string().describe("Directory to scan."),
      plan: z.enum(["free", "paid"]).optional().describe("Defaults to paid."),
    },
  },
  async ({ root, plan }) => {
    const { system } = await scanDirectory(root, 4);
    const findings = lint(system, { plan: plan ?? "paid" });
    if (findings.length === 0) return text("No findings.");

    return text(
      findings
        .map((f) =>
          [
            `[${f.severity}] ${f.rule}: ${f.message}`,
            f.remedy ? `    ${f.remedy}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n"),
    );
  },
);

server.registerTool(
  "choose_primitive",
  {
    title: "Choose between Cloudflare primitives",
    description:
      "Answer which Cloudflare primitive fits a workload, with the reasons it was chosen and the specific constraint that rules out each alternative. Use this before reaching for a Durable Object, D1, KV, a Queue, or a Workflow — the choice is hard to reverse later.",
    inputSchema: {
      shape: z
        .enum(["request", "event", "schedule", "long-running"])
        .describe("What starts the work."),
      duration: z.enum(["sub-second", "seconds", "minutes", "hours"]).optional(),
      cardinality: z.enum(["single", "bounded", "per-entity"]).optional(),
      serialization: z
        .enum(["required", "not-required", "no-writes"])
        .optional()
        .describe("Whether writes to one entity must be serialized."),
      consistency: z.enum(["read-after-write", "eventual-ok"]).optional(),
      access: z
        .enum(["key-lookup", "relational", "blob", "vector", "append-only", "none"])
        .optional(),
      runtime: z.enum(["javascript", "native"]).optional(),
      existingDatabase: z.enum(["none", "postgres-or-mysql"]).optional(),
    },
  },
  async (input) => {
    const requirements: Requirements = {
      ...DEFAULT_REQUIREMENTS,
      ...Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      ),
    } as Requirements;

    const result = recommend(requirements);
    const lines: string[] = [];

    for (const decision of result.decisions) {
      if (!decision.chosen) continue;
      lines.push(`${decision.role}: ${decision.chosen.label}`);
      for (const reason of decision.chosen.reasons) lines.push(`  + ${reason}`);
      for (const rejected of decision.rejected.filter((c) => c.disqualifiedBecause).slice(0, 3)) {
        lines.push(`  - not ${rejected.label}: ${rejected.disqualifiedBecause}`);
      }
      lines.push("");
    }
    for (const warning of result.warnings) lines.push(`warning: ${warning}`);

    lines.push(
      "",
      "Suggested topology:",
      ...result.topology.nodes.map((n) => `  ${n.kind} "${n.name}"`),
      ...result.topology.edges.map((e) => `  ${e.from} -> ${e.to}`),
    );
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "diff_deployed",
  {
    title: "Compare configs against what is actually deployed",
    description:
      "Scan local wrangler configs and the live Cloudflare account, then report the differences: bindings that exist in production but in no config (the next deploy removes them), configs never deployed, and compatibility dates that disagree. Requires a Cloudflare API token in ~/.flarecraft/config.json.",
    inputSchema: {
      root: z.string().describe("Directory of repositories to compare."),
      accountId: z.string().optional().describe("Defaults to the configured account."),
    },
  },
  async ({ root, accountId }) => {
    const credentials = await cloudflareCredentials();
    if (!credentials) {
      return text(
        `No Cloudflare API token found. Add {"cloudflare":{"apiToken":"...","accountId":"..."}} to ${CONFIG_PATH}. A read-only token is enough.`,
      );
    }
    const account = accountId ?? credentials.accountId;
    if (!account) return text("No account id configured, and none was given.");

    const { system: repo } = await scanDirectory(root, 4);
    const client = new CloudflareClient({ apiToken: credentials.apiToken });
    const { system: live, warnings } = await scanAccount(client, account);

    const findings = diffSystems(repo, live);
    const lines = [
      findings.length === 0
        ? "No drift between the scanned configs and the account."
        : findings
            .map((f) =>
              [`[${f.severity}] ${f.message}`, f.remedy ? `    ${f.remedy}` : ""]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n\n"),
    ];

    if (warnings.length > 0) {
      lines.push(
        "",
        "The account scan was incomplete, so some of the above may be an artefact:",
        ...warnings.map((w) => `  ${w.message}`),
      );
    }
    return text(lines.join("\n"));
  },
);

await server.connect(new StdioServerTransport());
