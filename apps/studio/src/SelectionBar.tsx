import { useState } from "react";
import { Panel } from "@xyflow/react";
import type { SystemModel } from "@flarecraft/model";
import { useStudio } from "./store.js";

/**
 * Actions for whatever is selected, shown only while something is.
 *
 * Grouping is a selection gesture, so this is the natural home for it — the
 * alternative would be a panel control that acts on a selection you made
 * somewhere else, which is the indirection this feature is meant to avoid.
 */
export function SelectionBar({
  system,
  selected,
}: {
  system: SystemModel;
  selected: string[];
}) {
  const groupSelected = useStudio((s) => s.groupSelected);
  const ungroupNodes = useStudio((s) => s.ungroupNodes);
  const [merging, setMerging] = useState(false);

  if (selected.length < 2) return null;

  const nodes = system.nodes.filter((n) => selected.includes(n.id));
  const touched = [...new Set(nodes.map((n) => n.groupId).filter(Boolean))] as string[];
  const groups = system.groups ?? [];
  const others = groups.filter((g) => !touched.includes(g.id));

  return (
    <Panel position="top-center" className="!m-0 !mt-3">
      <div className="flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-1.5 shadow-lg">
        <span className="text-[11px] text-ink-dim">{selected.length} selected</span>

        <button
          onClick={() => groupSelected(selected)}
          className="rounded border border-accent/60 bg-accent/10 px-2 py-0.5 text-[11px] text-accent transition-colors hover:bg-accent/20"
        >
          {touched.length > 0 ? "Group as new system" : "Group into a system"}
        </button>

        {others.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setMerging((v) => !v)}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-ink transition-colors hover:border-line-strong"
            >
              Move into ▾
            </button>
            {merging && (
              <div className="absolute left-0 top-full z-20 mt-1 min-w-40 rounded border border-line bg-raised py-1 shadow-lg">
                {others.map((group) => (
                  <button
                    key={group.id}
                    onClick={() => {
                      // Assigning to an existing group is the same edit as
                      // grouping, just with the id already chosen.
                      useStudio.setState((state) => {
                        const current = state.system;
                        if (!current) return state;
                        return {
                          system: {
                            ...current,
                            nodes: current.nodes.map((n) =>
                              selected.includes(n.id) ? { ...n, groupId: group.id } : n,
                            ),
                          },
                          dirty: true,
                        };
                      });
                      setMerging(false);
                    }}
                    className="block w-full px-3 py-1 text-left text-[11px] text-ink hover:bg-line"
                  >
                    {group.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {touched.length > 0 && (
          <button
            onClick={() => ungroupNodes(selected)}
            className="rounded border border-line px-2 py-0.5 text-[11px] text-ink-dim transition-colors hover:border-line-strong hover:text-ink"
          >
            Ungroup
          </button>
        )}
      </div>
    </Panel>
  );
}
