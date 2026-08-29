import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { planDeployment, type SystemModel } from "@flarecraft/model";
import { exportRepo } from "./export.js";

const run = promisify(execFile);

/**
 * Run a designed system out to a real Cloudflare account.
 *
 * This is the only part of flarecraft that writes to your account, and it is
 * deliberately a two-call flow: `/plan` computes what would happen and returns
 * it, `/run` does it. Creating billable resources on a single unconfirmed click
 * is not a nicety worth having.
 *
 * Execution is sequential and stops at the first failure. A half-deployed
 * system is bad; a half-deployed system that kept going and buried the error
 * under six more commands is worse.
 */

export interface StepResult {
  label: string;
  command: string;
  ok: boolean;
  output: string;
  /** Id captured from the command's output, when it printed one. */
  capturedId?: string;
}

export interface DeployResult {
  outDir: string;
  results: StepResult[];
  blockers: string[];
  /** Ids the command printed but that could not be matched back to a config. */
  unresolved: string[];
  completed: boolean;
}

/**
 * Ids as the create commands print them.
 *
 * Parsing CLI output is not something to be proud of, but the alternative is
 * write access to the account API, which is a much larger trust ask for the
 * same result. When a pattern does not match, the step is reported as needing
 * manual attention rather than guessed at.
 */
const ID_PATTERNS = [
  /"?id"?\s*[:=]\s*"([0-9a-f]{32})"/i,
  /"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/i,
  /\b([0-9a-f]{32})\b/i,
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
];

function captureId(output: string): string | undefined {
  for (const pattern of ID_PATTERNS) {
    const match = output.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export async function deploySystem(
  system: SystemModel,
  outDir: string,
): Promise<DeployResult> {
  const plan = planDeployment(system);
  if (plan.blockers.some((b) => b.includes("no order") || b.includes("no Workers"))) {
    return {
      outDir,
      results: [],
      blockers: plan.blockers,
      unresolved: [],
      completed: false,
    };
  }

  // Write the repo first: every command below runs against these files.
  await exportRepo({ system, outDir, force: true });

  const results: StepResult[] = [];
  const unresolved: string[] = [];

  for (const step of plan.steps) {
    const [command, ...args] = step.command.split(" ");
    let output = "";
    let ok = true;

    try {
      const { stdout, stderr } = await run(command!, args, {
        cwd: outDir,
        shell: true,
        timeout: 300_000,
      });
      output = `${stdout}${stderr}`.trim();
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message: string };
      output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message;
      ok = false;
    }

    const capturedId = step.yieldsId ? captureId(output) : undefined;
    results.push({
      label: step.label,
      command: step.command,
      ok,
      output,
      ...(capturedId ? { capturedId } : {}),
    });

    if (!ok) {
      return { outDir, results, blockers: plan.blockers, unresolved, completed: false };
    }

    if (step.yieldsId) {
      if (capturedId) {
        const patched = await substituteId(outDir, system, step.nodeId, capturedId);
        if (!patched) unresolved.push(`${step.label}: ${capturedId}`);
      } else {
        unresolved.push(
          `${step.label}: created, but no id could be read from the output — paste it into the config by hand before the deploy steps will succeed.`,
        );
      }
    }
  }

  return { outDir, results, blockers: plan.blockers, unresolved, completed: true };
}

/**
 * Put a freshly created resource's id into every config that references it.
 *
 * The emitter writes REPLACE_ME wherever an id was unknown, so the substitution
 * targets that rather than trying to locate the binding structurally. Returns
 * false when nothing was replaced, which means the id has nowhere to go and the
 * caller should say so.
 */
async function substituteId(
  outDir: string,
  system: SystemModel,
  nodeId: string,
  id: string,
): Promise<boolean> {
  const node = system.nodes.find((n) => n.id === nodeId);
  if (!node) return false;

  let replaced = false;
  for (const worker of system.nodes.filter((n) => n.kind === "worker")) {
    const bindsIt = system.edges.some(
      (e) => e.from === worker.id && e.to === nodeId,
    );
    if (!bindsIt) continue;

    const path = join(outDir, slug(worker.name), "wrangler.jsonc");
    try {
      const contents = await readFile(path, "utf8");
      if (!contents.includes("REPLACE_ME")) continue;
      await writeFile(path, contents.replace(/REPLACE_ME/g, id), "utf8");
      replaced = true;
    } catch {
      continue;
    }
  }
  return replaced;
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "worker";
