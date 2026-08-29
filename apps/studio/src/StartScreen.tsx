import { useState } from "react";
import { FolderPicker } from "./FolderPicker.js";
import { Button, Input, Note } from "./ui.js";
import { useStudio } from "./store.js";

type Picking = "open" | "create" | undefined;

/**
 * The first decision, made first.
 *
 * Both paths start by choosing a folder, and a folder is chosen by looking at
 * folders — the picker labels each with whether it holds a wrangler config or a
 * previous scaffold, which is what makes the choice obvious.
 */
export function StartScreen() {
  const loadRepo = useStudio((s) => s.loadRepo);
  const loadAccount = useStudio((s) => s.loadAccount);
  const newSystem = useStudio((s) => s.newSystem);
  const scaffold = useStudio((s) => s.scaffold);
  const openProject = useStudio((s) => s.openProject);
  const loading = useStudio((s) => s.loading);
  const error = useStudio((s) => s.error);

  const [recent, setRecent] = useState(
    () => localStorage.getItem("flarecraft:root") ?? "",
  );
  const [recentIsProject, setRecentIsProject] = useState(
    () => localStorage.getItem("flarecraft:rootIsProject") === "1",
  );
  const [projectFolder, setProjectFolder] = useState(
    () => localStorage.getItem("flarecraft:projects") ?? "",
  );
  const [name, setName] = useState("");
  const [picking, setPicking] = useState<Picking>();

  /**
   * Choosing a folder opens it. There is no second button.
   *
   * A folder holding one project opens *as* that project — bound, so it syncs
   * and deploys. A folder holding many unrelated repositories is only mapped.
   * The difference is knowable from the folder itself, so it is decided here
   * rather than asked about.
   */
  const openFolder = (path: string, isProject: boolean) => {
    if (!path) return;
    localStorage.setItem("flarecraft:root", path);
    localStorage.setItem("flarecraft:rootIsProject", isProject ? "1" : "0");
    setRecent(path);
    setRecentIsProject(isProject);
    if (isProject) void openProject(path);
    else void loadRepo(path);
  };

  const create = async () => {
    if (projectFolder) localStorage.setItem("flarecraft:projects", projectFolder);
    newSystem(name.trim() || "Untitled system", projectFolder || undefined);
    await scaffold(projectFolder || undefined);
  };

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-2xl">
        <h1 className="text-lg font-semibold tracking-tight">flarecraft</h1>
        <p className="mt-1 text-[12px] text-ink-dim">
          Map a Cloudflare system, design a new one, and configure every piece on
          the canvas.
        </p>

        {error && <div className="mt-4">{<Note tone="error">{error}</Note>}</div>}

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Card
            title="Open what exists"
            body="Reads every wrangler config under a folder and maps the whole architecture — Workers, what they bind, and how they reach each other."
          >
            <Button full onClick={() => setPicking("open")} disabled={loading}>
              {loading ? "reading…" : "Choose a folder…"}
            </Button>

            {recent && (
              <button
                onClick={() => openFolder(recent, recentIsProject)}
                disabled={loading}
                title={`Reopen ${recent}`}
                className="truncate text-left font-mono text-[10px] text-ink-faint underline hover:text-ink-dim disabled:opacity-40"
              >
                ↩ {recent}
              </button>
            )}

            <button
              onClick={() => void loadAccount()}
              disabled={loading}
              className="mt-auto pt-1 text-left text-[10px] text-ink-faint underline hover:text-ink-dim disabled:opacity-40"
            >
              or read the live Cloudflare account
            </button>
          </Card>

          <Card
            title="Start something new"
            body="Scaffolds a real project: wrangler configs, a typed Env, handler stubs, and a BLUEPRINT.md describing what to build. It stays in sync as you design."
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void create()}
              placeholder="Name it"
            />

            <button
              onClick={() => setPicking("create")}
              className="flex items-center gap-2 rounded border border-line bg-surface px-2 py-1.5 text-left transition-colors hover:border-line-strong"
            >
              <span
                className={`min-w-0 flex-1 truncate font-mono text-[10px] ${
                  projectFolder ? "text-ink" : "text-ink-faint"
                }`}
                title={projectFolder || "~/.flarecraft/projects"}
              >
                {projectFolder || "~/.flarecraft/projects"}
              </span>
              <span className="shrink-0 text-[10px] text-ink-dim">Choose…</span>
            </button>

            <Button full tone="primary" onClick={() => void create()}>
              Create project
            </Button>

            {projectFolder && (
              <button
                onClick={() => openFolder(projectFolder, true)}
                disabled={loading}
                title="Read an existing project back in, picking up anything edited outside flarecraft"
                className="text-left text-[10px] text-ink-faint underline hover:text-ink-dim disabled:opacity-40"
              >
                or reopen the project already there
              </button>
            )}
          </Card>
        </div>
      </div>

      {picking && (
        <FolderPicker
          initialPath={picking === "open" ? recent : projectFolder}
          confirmLabel={picking === "open" ? "Open this folder" : "Put the project here"}
          onCancel={() => setPicking(undefined)}
          onPick={(path, self) => {
            setPicking(undefined);
            if (picking === "open") {
              openFolder(path, self.isProject || self.hasConfig);
            } else {
              // Creating a project writes files, so that one stays explicit.
              setProjectFolder(path);
            }
          }}
        />
      )}
    </div>
  );
}

function Card({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-panel border border-line bg-sunken p-4">
      <h2 className="text-[12px] font-semibold">{title}</h2>
      <p className="mb-1 text-[11px] leading-relaxed text-ink-dim">{body}</p>
      {children}
    </div>
  );
}
