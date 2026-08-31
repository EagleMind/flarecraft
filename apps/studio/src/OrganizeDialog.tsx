import { useCallback, useEffect, useState } from "react";
import { groupReadiness, type SystemModel } from "@flarecraft/model";
import { FolderPicker } from "./FolderPicker.js";
import { Button, Note } from "./ui.js";
import { useStudio } from "./store.js";

interface Member {
  workers: string[];
  source: string;
  target: string;
  files: number;
  bytes: number;
  manager: string;
}

interface Plan {
  destination: string;
  groupName: string;
  members: Member[];
  blockers: string[];
  notices: string[];
  copied?: string[];
  installs?: { target: string; command: string; ok: boolean; output: string }[];
  completed?: boolean;
  error?: string;
}

type Picking = "destination" | "sources" | { locate: string } | undefined;

const kb = (bytes: number) =>
  bytes > 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`;

/**
 * Consolidating one group into a folder.
 *
 * Two steps, for the same reason deploy is: the preview is where you find out
 * it was about to copy the wrong thing. Nothing here ever moves or deletes, so
 * the worst outcome of pressing on is a folder you can throw away.
 */
export function OrganizeDialog({
  system,
  groupId,
  onClose,
}: {
  system: SystemModel;
  groupId: string;
  onClose: () => void;
}) {
  const scanRoot = useStudio((s) => s.scanRoot);
  const findLocalSources = useStudio((s) => s.findLocalSources);
  const locateWorker = useStudio((s) => s.locateWorker);
  const openProject = useStudio((s) => s.openProject);

  /**
   * The folder you pick is the *parent*; the project lands in a new subfolder
   * named after the group. The picker can only navigate to folders that exist,
   * so asking for an empty destination directly would mean going and creating
   * one in the file manager first.
   */
  const [parent, setParent] = useState("");
  const [picking, setPicking] = useState<Picking>();
  const [plan, setPlan] = useState<Plan | undefined>();
  const [result, setResult] = useState<Plan | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [install, setInstall] = useState(true);

  const group = (system.groups ?? []).find((g) => g.id === groupId);
  const folderName =
    (group?.name ?? "system")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "system";
  // Both separators: a Windows path arrives with backslashes, and a
  // forward-slash-only pattern would leave a trailing one in place.
  const separator = parent.includes("\\") ? "\\" : "/";
  const destination = parent
    ? `${parent.replace(/[\\/]+$/, "")}${separator}${folderName}`
    : "";
  const readiness = groupReadiness(system, groupId);
  const ready = readiness.missing.length === 0 && readiness.workers.length > 0;

  const post = useCallback(
    async (url: string, body: unknown): Promise<Plan> => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await response.json()) as Plan;
    },
    [],
  );

  // Re-plan whenever the destination or the group's readiness changes, so the
  // preview is never stale relative to what you just fixed.
  useEffect(() => {
    if (!destination || !ready) {
      setPlan(undefined);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void post("/api/organize/plan", {
      system,
      groupId,
      destination,
      scanRoots: scanRoot ? [scanRoot] : [],
    })
      .then((body) => {
        if (cancelled) return;
        if (body.error) setError(body.error);
        else {
          setPlan(body);
          setError(undefined);
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [destination, ready, system, groupId, scanRoot, post]);

  const execute = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const body = await post("/api/organize/run", {
        system,
        groupId,
        destination,
        scanRoots: scanRoot ? [scanRoot] : [],
        install,
      });
      if (body.error) setError(body.error);
      else setResult(body);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-panel border border-line bg-sunken"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[12px] font-semibold">
            Save “{group?.name}” as a project
          </h2>
          <button
            onClick={onClose}
            className="ml-auto text-[10px] text-ink-faint hover:text-ink-dim"
          >
            close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[11px]">
          {error && <Note tone="error">{error}</Note>}

          {result ? (
            <Results
              result={result}
              // Close only once the project is actually loaded: dismissing
              // first would leave a blank canvas if the open failed.
              onOpen={() => void openProject(result.destination).then(onClose)}
            />
          ) : (
            <>
              {/* Readiness first: there is no point choosing a destination for
                  a group that cannot be consolidated yet. */}
              {!ready && (
                <section className="mb-4">
                  <Note tone="warn">
                    {readiness.workers.length === 0
                      ? "This group has no Workers, so there is nothing to consolidate."
                      : `${readiness.missing.length} Worker(s) have no local folder. Every Worker needs one before this can run — nothing is invented for you.`}
                  </Note>

                  {readiness.missing.length > 0 && (
                    <>
                      <div className="mb-2">
                        <Button onClick={() => setPicking("sources")} disabled={busy}>
                          Find sources in a folder…
                        </Button>
                      </div>
                      <ul>
                        {readiness.missing.map((worker) => (
                          <li
                            key={worker.id}
                            className="mb-1 flex items-center gap-2"
                          >
                            <span className="min-w-0 flex-1 truncate text-ink">
                              {worker.name}
                            </span>
                            <button
                              onClick={() => setPicking({ locate: worker.id })}
                              className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-dim hover:border-line-strong hover:text-ink"
                            >
                              Locate…
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              )}

              {ready && (
                <>
                  <section className="mb-4">
                    <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                      Destination
                    </h3>
                    <button
                      onClick={() => setPicking("destination")}
                      className="flex w-full items-center gap-2 rounded border border-line bg-surface px-2 py-1.5 text-left transition-colors hover:border-line-strong"
                    >
                      <span
                        className={`min-w-0 flex-1 truncate font-mono text-[10px] ${
                          destination ? "text-ink" : "text-ink-faint"
                        }`}
                      >
                        {destination || "Choose where to put it…"}
                      </span>
                      <span className="shrink-0 text-[10px] text-ink-dim">Choose…</span>
                    </button>
                    {destination && (
                      <p className="mt-1 text-[10px] text-ink-faint">
                        A new <span className="font-mono">{folderName}</span> folder
                        is created here.
                      </p>
                    )}
                  </section>

                  {plan && (
                    <>
                      {plan.blockers.map((blocker, i) => (
                        <Note key={i} tone="error">
                          {blocker}
                        </Note>
                      ))}

                      <section className="mb-4">
                        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                          Copies {plan.members.length} folder(s)
                        </h3>
                        <ul>
                          {plan.members.map((member) => (
                            <li key={member.target} className="mb-2">
                              <div className="flex items-baseline gap-2">
                                <span className="font-mono text-[11px] text-ink">
                                  {member.target}
                                </span>
                                <span className="text-[10px] text-ink-faint">
                                  {member.files} files · {kb(member.bytes)} · {member.manager}
                                </span>
                              </div>
                              <div className="truncate font-mono text-[10px] text-ink-faint">
                                from {member.source}
                              </div>
                              <div className="text-[10px] text-ink-dim">
                                {member.workers.join(", ")}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </section>

                      {plan.notices.map((notice, i) => (
                        <p key={i} className="mb-1 text-[10px] leading-relaxed text-ink-faint">
                          {notice}
                        </p>
                      ))}

                      <label className="mt-3 flex items-center gap-2 text-[11px] text-ink-dim">
                        <input
                          type="checkbox"
                          checked={install}
                          onChange={(e) => setInstall(e.target.checked)}
                        />
                        Install dependencies afterwards
                      </label>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {!result && (
          <footer className="flex items-center gap-2 border-t border-line px-4 py-3">
            <span className="min-w-0 flex-1 truncate text-[10px] text-ink-faint">
              Your original folders are copied, never moved.
            </span>
            <Button
              tone="primary"
              disabled={busy || !plan || plan.blockers.length > 0}
              onClick={() => void execute()}
            >
              {busy ? "working…" : "Copy into the folder"}
            </Button>
          </footer>
        )}
      </div>

      {picking === "destination" && (
        <FolderPicker
          confirmLabel="Put the project in here"
          onCancel={() => setPicking(undefined)}
          onPick={(path) => {
            setParent(path);
            setPicking(undefined);
          }}
        />
      )}

      {picking === "sources" && (
        <FolderPicker
          initialPath={scanRoot ?? ""}
          confirmLabel="Search this folder"
          onCancel={() => setPicking(undefined)}
          onPick={(path) => {
            setPicking(undefined);
            void findLocalSources(path);
          }}
        />
      )}

      {typeof picking === "object" && picking !== null && "locate" in picking && (
        <FolderPicker
          initialPath={scanRoot ?? ""}
          confirmLabel="This is the folder"
          onCancel={() => setPicking(undefined)}
          onPick={(path) => {
            const nodeId = picking.locate;
            setPicking(undefined);
            void locateWorker(nodeId, path);
          }}
        />
      )}
    </div>
  );
}

function Results({ result, onOpen }: { result: Plan; onOpen: () => void }) {
  return (
    <>
      <Note tone={result.completed ? "ok" : "error"}>
        {result.completed
          ? `Copied ${result.copied?.length ?? 0} folder(s) into ${result.destination}. Your originals are untouched.`
          : "Nothing was copied."}
      </Note>

      {result.installs && result.installs.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Installs
          </h3>
          <ul>
            {result.installs.map((entry) => (
              <li key={entry.target} className="mb-2 flex gap-2">
                <span className={entry.ok ? "text-ok" : "text-danger"}>
                  {entry.ok ? "✓" : "✗"}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-ink">{entry.target}</span>{" "}
                  <span className="font-mono text-[10px] text-ink-faint">
                    {entry.command}
                  </span>
                  {!entry.ok && (
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-line p-2 font-mono text-[10px] text-ink-dim">
                      {entry.output}
                    </pre>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-[10px] leading-relaxed text-ink-faint">
            A failed install costs you nothing — the files are already there. Run
            it yourself in that folder.
          </p>
        </section>
      )}

      {result.completed && (
        <Button full tone="primary" onClick={onOpen}>
          Open it as a project
        </Button>
      )}
    </>
  );
}
