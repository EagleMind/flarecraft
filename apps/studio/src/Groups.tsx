import { useMemo, useState } from "react";
import { ViewportPortal, useReactFlow } from "@xyflow/react";
import { groupReadiness, type SystemModel } from "@flarecraft/model";
import { NODE_HEIGHT, NODE_WIDTH } from "./layout.js";
import { useStudio } from "./store.js";

const PADDING = 28;
const CHIP_HEIGHT = 30;

interface Box {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  members: number;
  located: number;
  workers: number;
}

/**
 * Groups drawn behind the nodes, in canvas coordinates.
 *
 * Rendered through `ViewportPortal` rather than as React Flow parent nodes.
 * That choice is what keeps this feature additive: parent nodes would make
 * every child position relative and change how the ELK layout has to be
 * applied, whereas a portal just paints in the same coordinate space and the
 * node model never learns it exists.
 */
export function Groups({
  system,
  onSave,
}: {
  system: SystemModel;
  onSave: (groupId: string) => void;
}) {
  const boxes = useMemo(() => computeBoxes(system), [system]);
  if (boxes.length === 0) return null;

  return (
    <ViewportPortal>
      {boxes.map((box) => (
        <GroupBox key={box.id} box={box} onSave={() => onSave(box.id)} />
      ))}
    </ViewportPortal>
  );
}

function computeBoxes(system: SystemModel): Box[] {
  return (system.groups ?? []).flatMap((group) => {
    const members = system.nodes.filter((n) => n.groupId === group.id);
    const placed = members.filter((n) => n.position);
    if (placed.length === 0) return [];

    const xs = placed.map((n) => n.position!.x);
    const ys = placed.map((n) => n.position!.y);
    const readiness = groupReadiness(system, group.id);

    const x = Math.min(...xs) - PADDING;
    const y = Math.min(...ys) - PADDING - CHIP_HEIGHT;
    return [
      {
        id: group.id,
        name: group.name,
        x,
        y,
        width: Math.max(...xs) + NODE_WIDTH + PADDING - x,
        height: Math.max(...ys) + NODE_HEIGHT + PADDING - y,
        members: members.length,
        located: readiness.located.length,
        workers: readiness.workers.length,
      },
    ];
  });
}

function GroupBox({ box, onSave }: { box: Box; onSave: () => void }) {
  const renameGroupTo = useStudio((s) => s.renameGroupTo);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(box.name);
  const { setCenter } = useReactFlow();

  const ready = box.workers > 0 && box.located === box.workers;

  return (
    <div
      className="pointer-events-none absolute"
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <div className="absolute inset-0 rounded-xl border border-dashed border-line-strong/70 bg-raised/25" />

      {/* The chip carries everything you need to decide about this group, so
          nothing about it lives in a panel somewhere else. */}
      <div
        className="pointer-events-auto absolute left-2 top-1 flex items-center gap-2 rounded-md border border-line bg-raised px-2 py-1 shadow"
        style={{ height: CHIP_HEIGHT - 4 }}
      >
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false);
              if (draft.trim()) renameGroupTo(box.id, draft.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setDraft(box.name);
                setEditing(false);
              }
            }}
            className="w-32 rounded border border-line bg-surface px-1 text-[11px] text-ink focus:outline-none"
          />
        ) : (
          <button
            onDoubleClick={() => setEditing(true)}
            onClick={() =>
              setCenter(box.x + box.width / 2, box.y + box.height / 2, {
                duration: 300,
              })
            }
            title="Click to focus, double-click to rename"
            className="text-[11px] font-semibold text-ink"
          >
            {box.name}
          </button>
        )}

        <span className="text-[10px] text-ink-faint">{box.members}</span>

        <span
          className={`text-[10px] ${ready ? "text-ok" : "text-warn"}`}
          title={
            ready
              ? "Every Worker has local source"
              : "Some Workers have no local folder yet"
          }
        >
          {box.located}/{box.workers} located
        </span>

        <button
          onClick={onSave}
          className="rounded border border-accent/60 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent transition-colors hover:bg-accent/20"
        >
          Save as project…
        </button>
      </div>
    </div>
  );
}
