import { useEffect, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Canvas } from "./Canvas.js";
import { ConfigPanel } from "./ConfigPanel.js";
import { Designer } from "./Designer.js";
import { Findings, findingCounts } from "./Findings.js";
import { Palette } from "./Palette.js";
import { StartScreen } from "./StartScreen.js";
import { DeployPanel } from "./DeployPanel.js";
import { Button, Note } from "./ui.js";
import { useStudio } from "./store.js";

export function App() {
  return (
    // The provider has to sit above anything calling useReactFlow, which the
    // canvas does for screen-to-flow coordinates when dropping a primitive.
    <ReactFlowProvider>
      <Studio />
    </ReactFlowProvider>
  );
}

function Studio() {
  const system = useStudio((s) => s.system);
  // Nothing loaded means the first decision has not been made yet, and that
  // decision deserves the whole window rather than a control in a sidebar.
  return system ? <Workspace /> : <StartScreen />;
}

type Tab = "add" | "review" | "deploy";

function Workspace() {
  const {
    system,
    loading,
    error,
    notice,
    selectedNodeId,
    projectFolder,
    dirty,
    setNotice,
    scaffold,
    openProject,
    select,
  } = useStudio();

  const [tab, setTab] = useState<Tab>("add");
  const selectedNode = system?.nodes.find((n) => n.id === selectedNodeId);

  useEffect(() => {
    // `dirty` is the guard that makes reopening a project safe: without it,
    // loading a folder would immediately rewrite its configs and take any
    // hand-written comments with them.
    if (!projectFolder || !system || !dirty) return;
    const timer = setTimeout(() => void scaffold(), 1200);
    return () => clearTimeout(timer);
  }, [system, projectFolder, scaffold, dirty]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 5000);
    return () => clearTimeout(timer);
  }, [notice, setNotice]);

  // Escape deselects, which is the fastest way back out of an element.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "Escape") select(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  return (
    <div className="flex h-full">
      <aside className="flex w-[23rem] shrink-0 flex-col border-r border-line bg-sunken">
        <Header />

        {/* Selecting an element replaces the tabs entirely. Leaving them there
            would offer three destinations that do nothing, which is the exact
            ambiguity this split exists to remove. */}
        {selectedNode ? (
          <button
            onClick={() => select(undefined)}
            className="flex items-center gap-2 border-b border-line px-4 py-2 text-left text-[11px] text-ink-dim transition-colors hover:bg-raised hover:text-ink"
          >
            <span aria-hidden>←</span>
            <span className="truncate">Back to {system?.name}</span>
            <kbd className="ml-auto shrink-0 rounded border border-line px-1 text-[9px] text-ink-faint">
              esc
            </kbd>
          </button>
        ) : (
          <Tabs current={tab} onChange={setTab} />
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {loading && <p className="text-[11px] text-ink-dim">working…</p>}
          {error && <Note tone="error">{error}</Note>}

          {selectedNode ? (
            <ConfigPanel node={selectedNode} system={system} />
          ) : tab === "add" ? (
            <AddPanel />
          ) : tab === "review" ? (
            system && <Findings system={system} />
          ) : (
            <DeployPanel />
          )}
        </div>

        {projectFolder && (
          <footer className="flex items-center gap-2 border-t border-line px-4 py-2">
            <span
              className={`size-1.5 shrink-0 rounded-full ${dirty ? "bg-warn" : "bg-ok"}`}
              aria-hidden
            />
            <span
              className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint"
              title={projectFolder}
            >
              {dirty ? "saving…" : "saved"} · {projectFolder}
            </span>
            <button
              onClick={() => void openProject(projectFolder)}
              title="Re-read the folder, picking up anything edited outside flarecraft"
              className="shrink-0 text-[10px] text-ink-dim underline hover:text-ink"
            >
              reload
            </button>
          </footer>
        )}
      </aside>

      <main className="relative h-full min-w-0 flex-1">
        <Canvas />
        {notice && (
          <div
            role="status"
            className="absolute left-1/2 top-4 z-10 max-w-lg -translate-x-1/2 rounded border border-warn/60 bg-raised px-3 py-2 text-[11px] leading-relaxed text-ink shadow-lg"
          >
            {notice}
          </div>
        )}
      </main>
    </div>
  );
}

/** Identity and the actions that change where the data comes from. */
function Header() {
  const { system, loading, reset, refreshActivity, activityWarnings } = useStudio();

  return (
    <header className="border-b border-line px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="truncate text-[13px] font-semibold tracking-tight" title={system?.name}>
          {system?.name}
        </h1>
        <button
          onClick={reset}
          className="shrink-0 text-[10px] text-ink-faint underline hover:text-ink-dim"
        >
          close
        </button>
      </div>

      <p className="mt-0.5 text-[11px] text-ink-dim">
        {system?.nodes.length} elements · {system?.edges.length} connections
      </p>

      <div className="mt-2">
        <Button
          onClick={() => void refreshActivity()}
          disabled={loading}
          title="Requests and errors from the last 24 hours, shown on each Worker"
        >
          Show live traffic
        </Button>
      </div>

      {activityWarnings.length > 0 && (
        <p className="mt-2 text-[10px] leading-relaxed text-warn">{activityWarnings[0]}</p>
      )}

      {/* Only while the canvas is still blank: once something is on it, prose
          goes back to being additive, in the Add tab's "Describe it" path. */}
      {system && system.nodes.length === 0 && <DescribePrompt />}
    </header>
  );
}

/**
 * Describe the whole system before placing a single element.
 *
 * The first thing a new, empty canvas needs is not a palette to browse — it is
 * an architecture. This asks for one in prose and applies the result directly,
 * the same validated path as the Add tab's assistant.
 */
function DescribePrompt() {
  const loading = useStudio((s) => s.loading);
  const designFromPrompt = useStudio((s) => s.designFromPrompt);
  const [prompt, setPrompt] = useState("");

  const submit = async () => {
    if (!prompt.trim()) return;
    await designFromPrompt(prompt);
    setPrompt("");
  };

  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        Describe the architecture
      </p>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder="A webhook receiver that verifies signatures, queues each event, and writes results somewhere I can query by customer…"
        className="w-full rounded border border-line bg-surface px-2 py-1.5 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />
      <div className="mt-2">
        <Button full tone="primary" onClick={() => void submit()} disabled={loading || !prompt.trim()}>
          {loading ? "designing…" : "Design it"}
        </Button>
      </div>
    </div>
  );
}

function Tabs({
  current,
  onChange,
}: {
  current: Tab;
  onChange: (tab: Tab) => void;
}) {
  const system = useStudio((s) => s.system);
  const counts = useMemo(
    () => (system ? findingCounts(system) : { error: 0, warning: 0, total: 0 }),
    [system],
  );

  // The count on Review is the point: you can see there is something wrong
  // without switching to look.
  const badge =
    counts.error > 0
      ? { text: String(counts.error), tone: "bg-danger/20 text-danger" }
      : counts.warning > 0
        ? { text: String(counts.warning), tone: "bg-warn/20 text-warn" }
        : undefined;

  const tabs: { id: Tab; label: string }[] = [
    { id: "add", label: "Add" },
    { id: "review", label: "Review" },
    { id: "deploy", label: "Deploy" },
  ];

  return (
    <div className="flex border-b border-line">
      {tabs.map((entry) => (
        <button
          key={entry.id}
          onClick={() => onChange(entry.id)}
          className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-3 py-2 text-[11px] transition-colors ${
            current === entry.id
              ? "border-accent text-ink"
              : "border-transparent text-ink-dim hover:text-ink"
          }`}
        >
          {entry.label}
          {entry.id === "review" && badge && (
            <span className={`rounded-full px-1.5 text-[9px] font-semibold ${badge.tone}`}>
              {badge.text}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Adding things is the primary act, so the palette leads.
 *
 * The questionnaire that used to own a tab sits behind a question someone
 * actually asks — and only makes sense once you are already looking at the list.
 */
function AddPanel() {
  const [assist, setAssist] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 shrink-0">
        <Button full tone={assist ? "primary" : "default"} onClick={() => setAssist((v) => !v)}>
          {assist ? "← Back to the palette" : "Not sure which to use?"}
        </Button>
      </div>
      {assist ? <Designer /> : <Palette disabled={false} />}
    </div>
  );
}
