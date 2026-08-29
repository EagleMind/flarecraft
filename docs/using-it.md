# Using flarecraft

## Setup

```bash
pnpm install
```

Two processes, two terminals:

```bash
pnpm server
```

```bash
pnpm studio
```

The studio is at http://localhost:5173. It opens asking whether to open an
existing folder or start something new — **opening needs no credentials at all**.

### Credentials, when you want more

`~/.flarecraft/config.json`, outside the repo on purpose:

```json
{
  "cloudflare": { "apiToken": "...", "accountId": "..." },
  "anthropic": { "apiKey": "..." },
  "scanRoots": ["C:/Users/you/Documents"]
}
```

- **Cloudflare** — a *read-only* token is enough: Workers Scripts, KV, D1, R2,
  Queues, and Zone read. Needed for account scan and drift. Endpoints the token
  is not scoped for degrade to warnings rather than failing the scan, so a
  partial token still produces a useful map.
- **Anthropic** — only for the prose-to-subgraph path. You can skip this key
  entirely if `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an
  `ant auth login` profile is already set up; the SDK resolves those itself.

Both are read by the local server and used there. Neither reaches the browser.

---

## The flow

flarecraft opens on one decision: **open what exists**, or **start something new**.

Both begin with a folder picker. It lists directories from the machine and
labels each one with what is actually inside — `project` for a folder flarecraft
scaffolded, `worker` for one holding a wrangler config — so the choice is made
from the list rather than from memory of where things live.

> **Why a built-in picker rather than the OS dialog.** The browser deliberately
> will not tell a page where a folder is. `showDirectoryPicker()` returns a
> handle whose `.name` is the leaf folder and nothing more; `webkitdirectory`
> gives paths relative to the selection. Neither yields an absolute path — and
> flarecraft needs one, because the server reads the configs, writes the
> scaffold, and runs `wrangler deploy` as a subprocess in that directory. The
> labelling is a bonus a native dialog could not offer anyway.

Choosing a folder opens it immediately — there is no second button. A folder
holding one project opens *as* that project: bound, so it syncs and deploys. A
folder holding many unrelated repositories is mapped but not bound.

After that it is one workspace: the canvas, with a panel that changes depending
on what you are doing.

| Panel | For |
|---|---|
| **Add** | The palette of Cloudflare primitives. Drag one onto the canvas |
| **Review** | Lint findings, clickable through to the element they concern |
| **Deploy** | Plan and run the deployment |
| *(element selected)* | Configure the thing you clicked |

**Live** in the toolbar pulls the last 24 hours of Worker traffic and puts
requests and errors on the nodes themselves. What you can see depends on your
Cloudflare plan and the token's scopes; when a dataset is not available it says
so rather than showing zeros.

---

## Configuring an element

Click any element. The panel becomes its settings — the real wrangler fields,
taken from Cloudflare's configuration reference, each labelled with the key it
writes and a line explaining what it is for.

A Worker gets its own settings plus Observability, Limits, Placement, and (if
it serves files) Static assets. Every other primitive gets the fields that
apply to it.

Bindings are listed under the element that holds them, and expand in place —
so a queue producer's `delivery_delay` or a D1 binding's `migrations_dir` is
edited where you are already looking, not in a different file.

Inbound connections are listed first, because that is the direction the
Cloudflare dashboard cannot show you at all. A queue delivering into a Worker
expands to its consumer settings: batch size, timeout, retries, dead-letter
queue.

Edits commit on blur, so one change is one undo step.

---

## Deploying

The **Deploy** panel is two steps on purpose.

**Plan** shows every command that would run, in order, with why each sits where
it does — resources before the configs that reference them, and Workers in
dependency order so a service binding never points at something that is not
there yet. Nothing has run at this point.

**Run** executes them, stops at the first failure, and shows each command's
output. Where a create command prints an id, it is captured and written back
into the configs that need it; where it cannot be read, you are told which id
to paste rather than left with a config that silently will not deploy.

This is the only part of flarecraft that writes to your Cloudflare account.

## Checking it

The Review panel runs ten rules continuously:

| Severity | Rules |
|---|---|
| **error** | service-binding cycles · credentials in `vars` (including `env.*` overlays) · Durable Object class bound with no migration · dangling bindings |
| **warning** | queue batch size × bindings against the subrequest ceiling · missing dead-letter queue · cron collisions on a shared resource · missing compatibility date |
| **info** | stale compatibility date · observability off · orphaned resources |

Two restraints worth knowing about, because they explain silence:

- A rule citing a limit marked `confidence: "verify"` **downgrades itself to a
  warning** rather than asserting a threshold the code cannot stand behind.
- Rules needing config-only fields **stay quiet about Workers seen only through
  the account API**, where those fields may simply be absent. Inventing findings
  from missing data is how a linter loses trust once and permanently.

---

## Exporting

**Export** writes a repo:

```
api/wrangler.jsonc      annotated, with comments
api/src/index.ts        stub handler, at the path `main` points to
api/src/env.ts          Env interface typed from the actual bindings
pnpm-workspace.yaml
provision.sh            creates resources whose ids do not exist yet
```

The stub handler carries **only** the entry points the topology implies — a
Worker with no cron gets no `scheduled`, because an empty handler that silently
does nothing is worse than an absent one.

Resources without an id emit `REPLACE_ME` and a warning rather than a guess. Run
`provision.sh`, paste the returned ids back in, then deploy.

The destination must be absolute and empty. That check is the difference between
a generated scaffold and an overwritten project.

> Exporting a **scanned** system regenerates configs whose `main` points at
> source living in your original repos. It is a config regenerator there, not a
> code export. Export is built for designed systems.

---

## Comparing against production

**Drift** scans both halves and reports the differences. Needs a Cloudflare token.

The finding that matters is **a binding in production and in no config** — the
next deploy removes it, and whatever depended on it stops working. That is an
error.

The reverse — deployed but in no scanned repo — is **information**, not an
error, because a repo scan only sees repositories that happen to be on this
machine, and treating an uncloned repo as a fault would bury the real signal.

---

## Refactoring

Three named operations, each returning an ordered deploy plan. The graph edit is
the easy half; the ordering is what stops an outage.

| Refactor | The order that matters |
|---|---|
| **insert queue** | Create the queue, deploy the *consumer*, then the producer. Reversed, messages pile up behind a handler that does not exist |
| **rename worker** | Deploy under the new name, redeploy every caller, delete the old name **last**. Deleting first takes production down |
| **extract worker** | Deploy the new Worker first — a service binding cannot resolve one that is not there |

Each plan ends with an explicit "the code has not moved" step. None of this
touches your handlers.

---

## From a coding agent

```bash
claude mcp add flarecraft -- npx tsx /absolute/path/to/flarecraft/apps/mcp/src/index.ts
```

Five read-only tools:

| Tool | What it answers |
|---|---|
| `scan_repos` | What is the topology under this directory |
| `who_binds` | What is wired to this resource — the reverse lookup, before renaming or deleting anything |
| `lint_topology` | Is this already wrong |
| `choose_primitive` | Which primitive fits, and what does that rule out |
| `diff_deployed` | Does production match the configs |

Everything is read-only, so an agent can ask what the topology is without being
able to change it by accident.

---

## Verification scripts

```bash
pnpm test          # 155 unit tests
pnpm typecheck     # all four TypeScript projects
pnpm verify:emit   # emit a repo, run `wrangler deploy --dry-run` on each Worker
pnpm verify:mcp    # drive the MCP server over a real stdio transport
```

`verify:emit` is the one that matters most. Round-trip tests prove the model
survives; only wrangler proves it would deploy.

---

## Troubleshooting

**"Could not reach the flarecraft server."** `pnpm server` is not running, or it
died. `tsx watch` does not recover from a module-resolution crash — restart it.

**Port 8798 in use.** Set `PORT` or `FLARECRAFT_PORT`, and point the studio at it
with `FLARECRAFT_API`.

**A scan shows fewer resources than expected.** Check the warnings. A token not
scoped for a product degrades that listing to a warning rather than failing the
whole scan, so the map is real but partial.

**Two resources with the same name.** Configs frequently carry no readable title
— a KV namespace is known only by its binding variable. Those nodes are marked
*name unresolved*; an account scan supplies the real title.
