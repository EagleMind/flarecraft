import { useMemo, useState } from "react";
import { PRIMITIVES, type PrimitiveCategory } from "@flarecraft/catalog";
import { Input } from "./ui.js";

/**
 * Primitives you can drag onto the canvas.
 *
 * Ordered the way a system gets built — something has to trigger it, something
 * has to run, and then it needs somewhere to put things — rather than
 * alphabetically, which would scatter the pieces you reach for together.
 */
const CATEGORY_ORDER: PrimitiveCategory[] = [
  "ingress",
  "compute",
  "messaging",
  "storage",
  "service",
  "external",
];

const CATEGORY_LABEL: Record<PrimitiveCategory, string> = {
  ingress: "Triggers",
  compute: "Compute",
  messaging: "Messaging",
  storage: "Storage",
  service: "Services",
  external: "Outside Cloudflare",
};

/** Tailwind cannot see a class built at runtime, so the stripes are explicit. */
const CATEGORY_STRIPE: Record<PrimitiveCategory, string> = {
  ingress: "bg-ingress",
  compute: "bg-compute",
  messaging: "bg-messaging",
  storage: "bg-storage",
  service: "bg-service",
  external: "bg-external",
};

export const DRAG_MIME = "application/x-flarecraft-primitive";

export function Palette({ disabled }: { disabled: boolean }) {
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = Object.values(PRIMITIVES).filter(
      (p) =>
        !needle ||
        p.label.toLowerCase().includes(needle) ||
        p.summary.toLowerCase().includes(needle),
    );
    return CATEGORY_ORDER.map((category) => ({
      category,
      items: matches.filter((p) => p.category === category),
    })).filter((group) => group.items.length > 0);
  }, [query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter…"
        className="mb-3 shrink-0"
      />

      <p className="mb-3 shrink-0 text-[10px] leading-relaxed text-ink-faint">
        Drag onto the canvas. Connections that Cloudflare cannot express will
        refuse to land.
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {grouped.length === 0 && (
          <p className="text-[11px] text-ink-dim">Nothing matches “{query}”.</p>
        )}

        {grouped.map(({ category, items }) => (
          <section key={category} className="mb-4">
            <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              {CATEGORY_LABEL[category]}
            </h3>
            {items.map((primitive) => (
              <div
                key={primitive.kind}
                draggable={!disabled}
                onDragStart={(event) => {
                  event.dataTransfer.setData(DRAG_MIME, primitive.kind);
                  event.dataTransfer.effectAllowed = "move";
                }}
                title={primitive.summary}
                className={`mb-1 flex cursor-grab items-center gap-2 rounded border border-line bg-raised px-2 py-1 text-[11px] transition-colors hover:border-line-strong active:cursor-grabbing ${
                  disabled ? "pointer-events-none opacity-40" : ""
                }`}
              >
                <span
                  className={`h-4 w-1 shrink-0 rounded-full ${CATEGORY_STRIPE[category]}`}
                  aria-hidden
                />
                {primitive.label}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
