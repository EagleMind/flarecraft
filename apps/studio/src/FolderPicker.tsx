import { useCallback, useEffect, useState } from "react";
import { Button } from "./ui.js";

interface BrowseEntry {
  name: string;
  path: string;
  hasConfig: boolean;
  isProject: boolean;
}

interface BrowseResult {
  path: string;
  self: { hasConfig: boolean; isProject: boolean };
  parent: string | null;
  entries: BrowseEntry[];
  shortcuts: { label: string; path: string }[];
  error?: string;
}

/**
 * Pick a folder by looking at folders.
 *
 * Entries are labelled with what is actually inside — a wrangler config, or a
 * BLUEPRINT.md from a previous scaffold — so the choice can be made from the
 * list rather than from memory of where things live. That labelling is the
 * reason this beats a native dialog, which shows every folder identically.
 */
export function FolderPicker({
  initialPath,
  confirmLabel,
  onPick,
  onCancel,
}: {
  initialPath?: string;
  confirmLabel: string;
  onPick: (path: string, self: { hasConfig: boolean; isProject: boolean }) => void;
  onCancel: () => void;
}) {
  const [state, setState] = useState<BrowseResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`,
      );
      const body = (await response.json()) as BrowseResult;
      if (!response.ok || body.error) {
        setError(body.error ?? "Could not open that folder.");
        return;
      }
      setState(body);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initialPath);
  }, [load, initialPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="flex max-h-[80vh] w-full max-w-xl flex-col rounded-panel border border-line bg-sunken"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[12px] font-semibold">Choose a folder</h2>
          <button
            onClick={onCancel}
            className="ml-auto text-[10px] text-ink-faint hover:text-ink-dim"
          >
            cancel
          </button>
        </header>

        <div className="flex flex-wrap gap-1 border-b border-line px-4 py-2">
          {state?.shortcuts.map((shortcut) => (
            <button
              key={shortcut.path}
              onClick={() => void load(shortcut.path)}
              className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-dim transition-colors hover:border-line-strong hover:text-ink"
            >
              {shortcut.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <button
            onClick={() => state?.parent && void load(state.parent)}
            disabled={!state?.parent}
            title="Up one level"
            className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink transition-colors hover:border-line-strong disabled:opacity-30"
          >
            ↑
          </button>
          <span
            className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-dim"
            title={state?.path}
          >
            {state?.path ?? "…"}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {loading && <p className="px-2 text-[11px] text-ink-dim">reading…</p>}
          {error && (
            <p className="mx-2 rounded border border-danger/50 px-2 py-2 text-[11px] text-danger">
              {error}
            </p>
          )}
          {!loading && !error && state?.entries.length === 0 && (
            <p className="px-2 text-[11px] text-ink-dim">
              No subfolders here. You can still choose this one.
            </p>
          )}

          {state?.entries.map((entry) => (
            <button
              key={entry.path}
              onClick={() => void load(entry.path)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-ink transition-colors hover:bg-raised"
            >
              <span className="text-ink-faint" aria-hidden>
                ▸
              </span>
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {/* The labels are the point: they turn a file tree into a list of
                  candidates you can actually choose between. */}
              {entry.isProject && (
                <span className="shrink-0 text-[9px] text-ok">project</span>
              )}
              {entry.hasConfig && !entry.isProject && (
                <span className="shrink-0 text-[9px] text-storage">worker</span>
              )}
            </button>
          ))}
        </div>

        <footer className="flex items-center gap-2 border-t border-line px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
            {state?.self.isProject
              ? "A flarecraft project — opens ready to sync and deploy."
              : state?.self.hasConfig
                ? "Holds a wrangler config."
                : " "}
          </span>
          <Button tone="primary" disabled={!state} onClick={() => state && onPick(state.path, state.self)}>
            {confirmLabel}
          </Button>
        </footer>
      </div>
    </div>
  );
}
