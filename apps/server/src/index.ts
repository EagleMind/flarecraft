import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { scanDirectory } from "@flarecraft/wrangler-io/fs";
import { CloudflareClient, scanAccount, fetchWorkerActivity } from "@flarecraft/account";
import { diffSystems } from "@flarecraft/rules";
import { describeConfig, loadConfig, CONFIG_PATH } from "./config.js";
import { proposeTopology, NoCredentialsError } from "./propose.js";
import { exportRepo, ExportError, DEFAULT_EXPORT_ROOT } from "./export.js";
import { deploySystem } from "./deploy.js";
import { scaffoldToFolder, defaultProjectFolder } from "./scaffold.js";
import { browseDirectory } from "./browse.js";
import { planOrganize, runOrganize } from "./organize.js";
import { planDeployment, type SystemModel } from "@flarecraft/model";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * The local half of flarecraft.
 *
 * It exists for two reasons the browser cannot cover on its own: it holds the
 * Cloudflare API token (which must never reach the page, and which the CF API
 * would refuse over CORS anyway), and it reads wrangler configs off disk.
 *
 * Bound to 127.0.0.1 only. This is a personal tool and there is no auth on
 * these routes, so it must not be reachable from anywhere else.
 */

// Not 8787: that is wrangler dev's default, so a flarecraft server on it would
// collide with any Worker the user happens to be running locally — which, for
// this tool's audience, is essentially always.
const PORT = Number(process.env["PORT"] ?? process.env["FLARECRAFT_PORT"] ?? 8798);
const app = new Hono();

// The studio dev server is a different origin in development.
app.use("/api/*", cors({ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }));

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/config", async (c) => {
  const config = await loadConfig();
  return c.json(describeConfig(config));
});

/** Topology from wrangler configs on disk. Needs no credentials at all. */
app.get("/api/system/repo", async (c) => {
  const config = await loadConfig();
  const root = c.req.query("root") ?? config.scanRoots?.[0];
  if (!root) {
    return c.json(
      {
        error: "No scan root given.",
        detail: `Pass ?root=<path>, or add "scanRoots" to ${CONFIG_PATH}.`,
      },
      400,
    );
  }

  const depth = Number(c.req.query("depth") ?? 4);
  try {
    const { system, warnings, configPaths } = await scanDirectory(root, depth);
    return c.json({ system, warnings, configPaths, source: "repo" });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

/** Topology from the live account. */
app.get("/api/system/account", async (c) => {
  const config = await loadConfig();
  const token = config.cloudflare?.apiToken;
  const accountId = c.req.query("accountId") ?? config.cloudflare?.accountId;

  if (!token) {
    return c.json(
      {
        error: "No Cloudflare API token configured.",
        detail: `Add {"cloudflare":{"apiToken":"...","accountId":"..."}} to ${CONFIG_PATH}. A token with read-only Workers, KV, D1, R2, and Queues scopes is enough.`,
      },
      400,
    );
  }
  if (!accountId) {
    return c.json({ error: "No account id. Pass ?accountId= or set it in config." }, 400);
  }

  try {
    const client = new CloudflareClient({ apiToken: token });
    const { system, warnings, covered } = await scanAccount(client, accountId);
    return c.json({ system, warnings, covered, source: "account" });
  } catch (error) {
    // Never echo the token back, even inside an error message.
    return c.json({ error: (error as Error).message }, 502);
  }
});

/** Accounts the token can see, so the UI can offer a picker. */
app.get("/api/accounts", async (c) => {
  const config = await loadConfig();
  const token = config.cloudflare?.apiToken;
  if (!token) return c.json({ error: "No Cloudflare API token configured." }, 400);

  try {
    const client = new CloudflareClient({ apiToken: token });
    const accounts = await client.list<{ id: string; name: string }>("/accounts");
    return c.json({ accounts: accounts.map((a) => ({ id: a.id, name: a.name })) });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502);
  }
});

/**
 * Prose → proposed subgraph. The key runs here and never reaches the browser,
 * same contract as the Cloudflare token.
 */
app.post("/api/design/propose", async (c) => {
  const config = await loadConfig();
  const body = (await c.req.json()) as {
    prompt?: string;
    existingNodes?: { kind: string; name: string }[];
  };
  if (!body.prompt?.trim()) {
    return c.json({ error: "Describe what you want to build." }, 400);
  }

  try {
    // No pre-flight credential check: an unset OPENROUTER_API_KEY does not
    // mean there is none configured in ~/.flarecraft/config.json.
    const proposal = await proposeTopology({
      ...(config.openrouter?.apiKey ? { apiKey: config.openrouter.apiKey } : {}),
      ...(config.openrouter?.model ? { model: config.openrouter.model } : {}),
      prompt: body.prompt,
      ...(body.existingNodes ? { existingNodes: body.existingNodes } : {}),
    });
    return c.json(proposal);
  } catch (error) {
    if (error instanceof NoCredentialsError) {
      return c.json({ error: error.message }, 401);
    }
    // Never echo a credential back, even inside an error message.
    return c.json({ error: (error as Error).message }, 502);
  }
});

app.get("/api/drift", async (c) => {
  const config = await loadConfig();
  const token = config.cloudflare?.apiToken;
  const accountId = c.req.query("accountId") ?? config.cloudflare?.accountId;
  const root = c.req.query("root") ?? config.scanRoots?.[0];

  if (!root) return c.json({ error: "No scan root given." }, 400);
  if (!token) {
    return c.json(
      {
        error: "No Cloudflare API token configured.",
        detail: `Drift needs both halves. Add {"cloudflare":{"apiToken":"...","accountId":"..."}} to ${CONFIG_PATH}.`,
      },
      400,
    );
  }
  if (!accountId) return c.json({ error: "No account id configured." }, 400);

  try {
    const { system: repo } = await scanDirectory(root, 4);
    const client = new CloudflareClient({ apiToken: token });
    const { system: live, warnings } = await scanAccount(client, accountId);
    return c.json({ findings: diffSystems(repo, live), scanWarnings: warnings });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 502);
  }
});

/**
 * What deploying would do. Computes only — nothing runs.
 *
 * Split from /run on purpose: creating billable resources on a single
 * unconfirmed click is not a convenience worth having.
 */
app.post("/api/deploy/plan", async (c) => {
  const body = (await c.req.json()) as { system?: unknown };
  if (!body?.system) return c.json({ error: "No system." }, 400);
  return c.json(planDeployment(body.system as never));
});

/** Execute the plan. The only endpoint that writes to the Cloudflare account. */
app.post("/api/deploy/run", async (c) => {
  const body = (await c.req.json()) as { system?: unknown; outDir?: string };
  if (!body?.system) return c.json({ error: "No system." }, 400);

  const system = body.system as never as Parameters<typeof deploySystem>[0];
  const outDir =
    body.outDir?.trim() ||
    join(homedir(), ".flarecraft", "deploys", slugName(system.name ?? "system"));

  try {
    return c.json(await deploySystem(system, outDir));
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

function slugName(name: string): string {
  return (
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "system"
  );
}

/**
 * Live Worker traffic, for overlaying on the canvas.
 *
 * What comes back depends on the plan and the token's scopes, and the
 * Analytics API reports that as warnings rather than failures — so this
 * endpoint returns 200 with an explanation rather than an error page.
 */
app.get("/api/activity", async (c) => {
  const config = await loadConfig();
  const token = config.cloudflare?.apiToken;
  const accountId = c.req.query("accountId") ?? config.cloudflare?.accountId;
  const hours = Number(c.req.query("hours") ?? 24);

  if (!token || !accountId) {
    return c.json({
      activity: [],
      warnings: [
        `Live activity needs a Cloudflare API token with Account Analytics read. Add it to ${CONFIG_PATH}.`,
      ],
    });
  }

  try {
    return c.json(await fetchWorkerActivity({ apiToken: token, accountId, hours }));
  } catch (error) {
    return c.json({ activity: [], warnings: [(error as Error).message] });
  }
});

/**
 * Create or re-sync a project folder from the design.
 *
 * Safe to call repeatedly: configs, the typed Env, and BLUEPRINT.md are
 * regenerated every time; handlers, package.json, and migrations are created
 * once and then never touched.
 */
app.post("/api/scaffold", async (c) => {
  const body = (await c.req.json()) as { system?: unknown; folder?: string };
  if (!body?.system) return c.json({ error: "No system." }, 400);

  const system = body.system as SystemModel;
  const folder =
    body.folder?.trim() || defaultProjectFolder(homedir(), system.name ?? "system");

  try {
    return c.json(await scaffoldToFolder({ system, folder }));
  } catch (error) {
    if (error instanceof ExportError) return c.json({ error: error.message }, 400);
    return c.json({ error: (error as Error).message }, 500);
  }
});

/**
 * List subfolders, so the UI can offer a picker instead of a path text box.
 *
 * Directories only, and it never reads a file — it checks for the presence of
 * a wrangler config or a BLUEPRINT.md purely to label the entry.
 */
app.get("/api/browse", async (c) => {
  try {
    return c.json(await browseDirectory(c.req.query("path")));
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400);
  }
});

/**
 * Consolidate a group's scattered projects into one folder.
 *
 * Split into plan and run for the same reason deploy is: this touches real
 * folders, and the preview is where you find out it was going to copy the wrong
 * thing. Nothing is ever moved or deleted, so a failed run costs only a
 * half-filled destination.
 */
app.post("/api/organize/plan", async (c) => {
  try {
    const body = (await c.req.json()) as Parameters<typeof planOrganize>[0];
    if (!body?.system || !body?.groupId) {
      return c.json({ error: "No system or group." }, 400);
    }
    return c.json(await planOrganize(body));
  } catch (error) {
    if (error instanceof ExportError) return c.json({ error: error.message }, 400);
    return c.json({ error: (error as Error).message }, 500);
  }
});

app.post("/api/organize/run", async (c) => {
  try {
    const body = (await c.req.json()) as Parameters<typeof runOrganize>[0];
    if (!body?.system || !body?.groupId) {
      return c.json({ error: "No system or group." }, 400);
    }
    return c.json(await runOrganize(body));
  } catch (error) {
    if (error instanceof ExportError) return c.json({ error: error.message }, 400);
    return c.json({ error: (error as Error).message }, 500);
  }
});

/** Model → a repo on disk. The only endpoint that creates files. */
app.post("/api/export", async (c) => {
  try {
    const body = (await c.req.json()) as Parameters<typeof exportRepo>[0];
    if (!body?.system) return c.json({ error: "No system to export." }, 400);
    return c.json(await exportRepo(body));
  } catch (error) {
    if (error instanceof ExportError) return c.json({ error: error.message }, 400);
    return c.json({ error: (error as Error).message }, 500);
  }
});

app.get("/api/export/default-root", (c) => c.json({ root: DEFAULT_EXPORT_ROOT }));

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`flarecraft server  http://127.0.0.1:${info.port}`);
  console.log(`config             ${CONFIG_PATH}`);
});
