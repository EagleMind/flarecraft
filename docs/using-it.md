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
  "openrouter": { "apiKey": "...", "model": "openai/gpt-4o" },
  "scanRoots": ["C:/Users/you/Documents"]
}
```

- **Cloudflare** — a *read-only* token is enough: Workers Scripts, KV, D1, R2,
  Queues, and Zone read. Needed for account scan and drift. Endpoints the token
  is not scoped for degrade to warnings rather than failing the scan, so a
  partial token still produces a useful map.
- **OpenRouter** — only for the prose-to-subgraph path. You can skip this key
  entirely if `OPENROUTER_API_KEY` is already set in the environment.
  `model` is optional and defaults to `openai/gpt-4o`; it can also be set via
  `OPENROUTER_MODEL`.

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

## Organizing a scattered account

Reading a live account gives you a true picture and an unhelpful one: a flat
spread of Workers, queues, and databases with nothing saying which belong
together. That is the state the dashboard leaves you in, and a faithful map of
it is still a map of sprawl.

**Organize**, in the canvas toolbar beside undo and *Tidy up*, resolves it. It
runs a suggestion pass and draws what it found straight away — groups rather
than an empty mode to figure out.

Grouping is **local metadata**. Cloudflare has no concept of a group, so it
never round-trips to the account; it lives in the saved system and in the
folder you consolidate to.

### Adjusting the grouping

Suggested groups are connected components of the graph — genuinely independent
clusters. Singleton platform services (AI, Browser Rendering, Images) are
**excluded as connectors**, or two unrelated Workers that both bind `env.AI`
would collapse into one bogus group.

Where the suggestion is wrong, correct it by selecting:

- **Shift+drag** marquees a region; **Shift+click** extends a selection.
  Plain left-drag still pans, so nothing you already do changes.
- At two or more selected, a bar appears at the top of the canvas:
  *Group into a system*, plus *Move into ▾* and *Ungroup* once the selection
  overlaps an existing group.

Each group is drawn as a translucent backdrop behind its members, with a chip at
the top-left carrying everything you need to decide about it: the name
(double-click to rename), the member count, folder readiness — *2/2 located* —
and **Save as project…**.

### Saving a group as a project

Readiness is the gate. Every Worker in the group needs a local folder before
this can run; a Worker deployed under a name that differs from its config's
`name` will not match and shows as missing. Nothing is invented for it — you get
**Locate…** and a folder picker, because a stub that looks like a project but
does not deploy is worse than a blocker.

Once every Worker is located, *Save as project…* asks where to put it. You
choose the **parent**; a new folder named after the group is created inside it.
Then the preview: which folders get copied, from where, how many files, how
large, and which package manager each one uses.

**Your originals are copied, never moved.** They are still exactly where they
were when this finishes — deleting them is your call, once you are satisfied the
copy is right. Because nothing is ever deleted, a partial failure leaves the
sources intact by construction.

Not copied: `node_modules`, build output (`dist`, `build`, `.next`,
`.open-next`, `.vercel`), `.wrangler`, `coverage`, and `.git`. The last is
deliberate — the originals keep the history, and nested repositories inside one
project folder behave confusingly. `git init` at the new root if you want it
versioned as one project.

Leave **Install dependencies afterwards** checked and each folder gets an
install using the manager detected from its own lockfile. It runs last and is
non-fatal: the files are already on disk, so a failed install is reported rather
than rolled back, and you can run it yourself.

The result is a folder of **self-contained projects, not a workspace** — each
with its own lockfile and its own install. That is forced by reality rather than
preference: projects that already carry a `pnpm-workspace.yaml` break when
nested, and a real corpus mixes managers freely. The root adds only
`BLUEPRINT.md` and a `README.md` recording what was copied, what was left
behind, and where the originals still are.

**Open it as a project** then reopens the new folder bound — syncable and
deployable, exactly as if you had started it there.

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
pnpm test          # 180 unit tests
pnpm typecheck     # all four TypeScript projects
pnpm verify:emit   # emit a repo, run `wrangler deploy --dry-run` on each Worker
pnpm verify:mcp    # drive the MCP server over a real stdio transport
pnpm verify:organize <scanRoot> <destination>   # consolidate a real group
```

`verify:emit` is the one that matters most. Round-trip tests prove the model
survives; only wrangler proves it would deploy.

`verify:organize` fingerprints every source folder before and after the copy and
fails on any difference. The copy succeeding is not the property worth
protecting — the sources coming out untouched is.

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
