import type { Node, SystemModel } from "@flarecraft/model";
import { emitRepo } from "./emit.js";
import { emitBlueprint } from "./blueprint.js";

/**
 * A complete project on disk, not just wrangler configs.
 *
 * The distinction that makes this safe to run repeatedly is `owned`. flarecraft
 * regenerates the files that are a projection of the topology — configs, the
 * typed Env, the blueprint — every time the canvas changes. Everything else is
 * written once and then left alone forever, because the moment a scaffold
 * overwrites a handler somebody has edited, the tool has cost more than it gave.
 */

export interface ScaffoldFile {
  path: string;
  contents: string;
  /**
   * True when this file is derived from the topology and flarecraft rewrites it
   * on every sync. False means: created if absent, never touched again.
   */
  owned: boolean;
}

export interface ScaffoldResult {
  files: ScaffoldFile[];
  warnings: string[];
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "worker";

const entryDir = (worker: Node): string => {
  const main = worker.worker?.main?.replace(/^\.\//, "") ?? "src/index.ts";
  return main.includes("/") ? main.slice(0, main.lastIndexOf("/")) : ".";
};

export function scaffoldProject(system: SystemModel): ScaffoldResult {
  // The config/env/handler set comes from the emitter, so a scaffolded project
  // and an exported one cannot drift apart.
  const emitted = emitRepo(system);
  const files: ScaffoldFile[] = [];
  const workers = system.nodes.filter((n) => n.kind === "worker");

  for (const file of emitted.files) {
    if (file.path === "pnpm-workspace.yaml") continue; // replaced below
    const owned =
      file.path.endsWith("wrangler.jsonc") ||
      file.path.endsWith("env.ts") ||
      file.path === "provision.sh";
    files.push({ ...file, owned });
  }

  files.push({
    path: "pnpm-workspace.yaml",
    owned: true,
    contents: `packages:\n${workers.map((w) => `  - "${slug(w.name)}"`).join("\n")}\n`,
  });

  files.push({
    path: "package.json",
    owned: false,
    contents: `${JSON.stringify(
      {
        name: slug(system.name),
        private: true,
        type: "module",
        scripts: {
          deploy: "pnpm -r deploy",
          typecheck: "pnpm -r typecheck",
        },
        devDependencies: { wrangler: "^4.0.0" },
      },
      null,
      2,
    )}\n`,
  });

  files.push({
    path: "tsconfig.json",
    owned: false,
    contents: `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: ["@cloudflare/workers-types"],
        },
      },
      null,
      2,
    )}\n`,
  });

  files.push({
    path: ".gitignore",
    owned: false,
    contents: [
      "node_modules/",
      "dist/",
      ".wrangler/",
      "",
      "# Local secrets. Never commit these — `vars` in wrangler.jsonc are",
      "# plaintext and deploy as-is, so anything sensitive belongs here or in",
      "# `wrangler secret put`.",
      ".dev.vars",
      "",
    ].join("\n"),
  });

  const secretNames = collectSecretHints(system);
  files.push({
    path: ".dev.vars.example",
    owned: false,
    contents: [
      "# Copy to .dev.vars for local development. .dev.vars is gitignored.",
      "# In production these go in with `wrangler secret put <NAME>`.",
      "",
      ...(secretNames.length > 0
        ? secretNames.map((name) => `${name}=`)
        : ["# No secrets needed yet."]),
      "",
    ].join("\n"),
  });

  for (const worker of workers) {
    const dir = slug(worker.name);

    files.push({
      path: `${dir}/package.json`,
      owned: false,
      contents: `${JSON.stringify(
        {
          name: dir,
          private: true,
          type: "module",
          scripts: {
            dev: "wrangler dev",
            deploy: "wrangler deploy",
            typecheck: "tsc --noEmit",
            // Regenerates runtime types from this Worker's own bindings.
            "cf-typegen": "wrangler types",
          },
          devDependencies: {
            "@cloudflare/workers-types": "^4.0.0",
            typescript: "^5.9.0",
            wrangler: "^4.0.0",
          },
        },
        null,
        2,
      )}\n`,
    });

    files.push({
      path: `${dir}/tsconfig.json`,
      owned: false,
      contents: `${JSON.stringify(
        { extends: "../tsconfig.json", include: [`${entryDir(worker)}/**/*`] },
        null,
        2,
      )}\n`,
    });
  }

  // D1 wants a migrations directory, and an empty one is not committable.
  for (const node of system.nodes.filter((n) => n.kind === "d1_database")) {
    const binder = system.nodes.find(
      (w) =>
        w.kind === "worker" &&
        system.edges.some((e) => e.from === w.id && e.to === node.id),
    );
    if (!binder) continue;
    files.push({
      path: `${slug(binder.name)}/migrations/0001_init.sql`,
      owned: false,
      contents: [
        `-- ${node.name}: first migration.`,
        "-- Apply with: wrangler d1 migrations apply " + node.name,
        "--",
        "-- D1 bills rows read. Index the columns you filter on before this",
        "-- table gets large, or a lookup quietly becomes a full scan.",
        "",
        "-- CREATE TABLE example (",
        "--   id TEXT PRIMARY KEY,",
        "--   created_at INTEGER NOT NULL",
        "-- );",
        "",
      ].join("\n"),
    });
  }

  for (const node of system.nodes.filter((n) => n.kind === "container")) {
    const binder = system.nodes.find(
      (w) =>
        w.kind === "worker" &&
        system.edges.some((e) => e.from === w.id && e.to === node.id),
    );
    if (!binder) continue;
    files.push({
      path: `${slug(binder.name)}/Dockerfile`,
      owned: false,
      contents: [
        `# Container image for ${node.name}.`,
        "FROM node:22-slim",
        "WORKDIR /app",
        "COPY . .",
        "CMD [\"node\", \"server.js\"]",
        "",
      ].join("\n"),
    });
  }

  files.push({
    path: "BLUEPRINT.md",
    owned: true,
    contents: emitBlueprint(system),
  });

  files.push({
    path: "README.md",
    owned: false,
    contents: emitReadme(system, workers),
  });

  return { files, warnings: emitted.warnings };
}

/**
 * Secret names worth stubbing.
 *
 * Values are never read — only the names, and only where a Worker already
 * declares one. Guessing at what a system "probably needs" would produce a
 * file of noise.
 */
function collectSecretHints(system: SystemModel): string[] {
  const names = new Set<string>();
  for (const worker of system.nodes.filter((n) => n.kind === "worker")) {
    for (const secret of worker.worker?.secrets ?? []) names.add(secret);
  }
  return [...names].sort();
}

function emitReadme(system: SystemModel, workers: Node[]): string {
  return [
    `# ${system.name}`,
    "",
    "Scaffolded by flarecraft. See **BLUEPRINT.md** for what this system is and",
    "what still needs building.",
    "",
    "## Which files are yours",
    "",
    "flarecraft regenerates these from the canvas every time the topology",
    "changes — edit them there, not here:",
    "",
    "- `*/wrangler.jsonc`",
    "- `*/src/env.ts`",
    "- `provision.sh`",
    "- `BLUEPRINT.md`",
    "",
    "Everything else — handlers, `package.json`, migrations, this file — was",
    "written once and will never be overwritten. It is yours.",
    "",
    "## Getting it running",
    "",
    "```bash",
    "pnpm install",
    "./provision.sh          # creates the resources, prints ids to paste back",
    "```",
    "",
    ...workers.flatMap((worker) => [
      `### ${worker.name}`,
      "",
      "```bash",
      `cd ${slug(worker.name)}`,
      "pnpm dev",
      "pnpm deploy",
      "```",
      "",
    ]),
  ].join("\n");
}

export { emitBlueprint };
