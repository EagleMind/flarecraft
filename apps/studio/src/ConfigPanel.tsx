import { useEffect, useState } from "react";
import {
  ASSETS_FIELDS,
  configSchemaFor,
  LIMITS_FIELDS,
  OBSERVABILITY_FIELDS,
  PLACEMENT_FIELDS,
  PRIMITIVES,
  QUEUE_CONSUMER_FIELDS,
  WORKER_FIELDS,
  type ConfigField,
} from "@flarecraft/catalog";
import type { Edge, Node, SystemModel } from "@flarecraft/model";
import { Button, Input, Select } from "./ui.js";
import { useStudio } from "./store.js";

/**
 * Everything about the selected element, editable in place.
 *
 * Fields come from Cloudflare's wrangler configuration reference, and each
 * carries a line saying what it is *for*. Knowing that `max_batch_timeout` is a
 * number is not the hard part; knowing that raising it trades latency for fewer
 * invocations is. That gap is why this beats keeping the docs open in a tab.
 *
 * Groups that are rarely touched start collapsed. A panel that opens with forty
 * inputs is a panel nobody reads.
 */
export function ConfigPanel({
  node,
  system,
}: {
  node: Node;
  system: SystemModel | undefined;
}) {
  const rename = useStudio((s) => s.rename);
  const editWorker = useStudio((s) => s.editWorker);
  const setNodeConfig = useStudio((s) => s.setNodeConfig);
  const setEdgeConfig = useStudio((s) => s.setEdgeConfig);
  const setConsumer = useStudio((s) => s.setConsumer);
  const drop = useStudio((s) => s.drop);
  const select = useStudio((s) => s.select);

  const spec = PRIMITIVES[node.kind];
  const schema = configSchemaFor(node.kind);
  const outgoing = (system?.edges ?? []).filter((e) => e.from === node.id);
  const incoming = (system?.edges ?? []).filter((e) => e.to === node.id);
  const nameOf = (id: string) =>
    system?.nodes.find((n) => n.id === id)?.name ?? id.split(":").slice(1).join(":");

  const worker = node.worker;

  return (
    <div>
      <header className="mb-4">
        <h2 className="text-[14px] font-semibold leading-tight">{node.name}</h2>
        <p className="mt-0.5 text-[11px] text-ink-dim">{spec?.label ?? node.kind}</p>
        {spec?.summary && (
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">{spec.summary}</p>
        )}
      </header>

      {node.kind === "worker" ? (
        <>
          <Group title="Worker" open>
            {WORKER_FIELDS.map((field) => (
              <Field
                key={field.key}
                field={field}
                value={workerValue(node, field.key)}
                onCommit={(value) => {
                  if (field.key === "name") {
                    if (typeof value === "string" && value) rename(node.id, value);
                    return;
                  }
                  editWorker(node.id, workerPatch(field.key, value));
                }}
              />
            ))}
          </Group>

          <Group title="Observability">
            {OBSERVABILITY_FIELDS.map((field) => (
              <Field
                key={field.key}
                field={field}
                value={(worker?.observability as Record<string, unknown>)?.[field.key]}
                onCommit={(value) =>
                  editWorker(node.id, {
                    observability: {
                      ...worker?.observability,
                      [field.key]: value,
                    } as NonNullable<Node["worker"]>["observability"],
                  })
                }
              />
            ))}
          </Group>

          <Group title="Limits & placement">
            {[...LIMITS_FIELDS, ...PLACEMENT_FIELDS].map((field) => {
              const scope = LIMITS_FIELDS.includes(field) ? "limits" : "placement";
              const current = (worker?.[scope] as Record<string, unknown>)?.[field.key];
              return (
                <Field
                  key={field.key}
                  field={field}
                  value={current}
                  onCommit={(value) =>
                    editWorker(node.id, {
                      [scope]: { ...worker?.[scope], [field.key]: value },
                    })
                  }
                />
              );
            })}
          </Group>

          {worker?.assets && (
            <Group title="Static assets">
              {ASSETS_FIELDS.map((field) => (
                <Field
                  key={field.key}
                  field={field}
                  value={(worker.assets as Record<string, unknown>)?.[field.key]}
                  onCommit={(value) =>
                    editWorker(node.id, {
                      assets: {
                        ...worker.assets,
                        [field.key]: value,
                      } as NonNullable<Node["worker"]>["assets"],
                    })
                  }
                />
              ))}
            </Group>
          )}
        </>
      ) : (
        <Group title="Settings" open>
          <Field
            field={{
              key: "name",
              label: "Name",
              type: "string",
              required: true,
              help: "How this resource is identified. Changing it here does not rename it on Cloudflare.",
            }}
            value={node.name}
            onCommit={(value) =>
              typeof value === "string" && value && rename(node.id, value)
            }
          />
          {schema.resource.map((field) => (
            <Field
              key={field.key}
              field={field}
              value={node.config?.[field.key]}
              onCommit={(value) => setNodeConfig(node.id, { [field.key]: value })}
            />
          ))}
          {node.resourceId && (
            <div className="mb-3 flex gap-2 text-[11px]">
              <span className="shrink-0 text-ink-faint">Resource ID</span>
              <span
                className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-ink-dim"
                title={node.resourceId}
              >
                {node.resourceId}
              </span>
            </div>
          )}
        </Group>
      )}

      {/* Inbound first: the direction the dashboard cannot show you at all. */}
      {incoming.length > 0 && (
        <Group title={`Reached by (${incoming.length})`} open>
          {incoming.map((edge) => (
            <Inbound
              key={edge.id}
              edge={edge}
              label={nameOf(edge.from)}
              onOpen={() => select(edge.from)}
              onConsumer={(patch) => setConsumer(edge.id, patch)}
            />
          ))}
        </Group>
      )}

      {outgoing.length > 0 && (
        <Group title={`Can reach (${outgoing.length})`} open>
          {outgoing.map((edge) => (
            <Outbound
              key={edge.id}
              edge={edge}
              target={system?.nodes.find((n) => n.id === edge.to)}
              onOpen={() => select(edge.to)}
              onPatch={(patch) => setEdgeConfig(edge.id, patch)}
            />
          ))}
        </Group>
      )}

      <div className="mt-6 flex items-center gap-3 border-t border-line pt-3">
        {spec?.docs && (
          <a
            href={spec.docs}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-accent underline"
          >
            Cloudflare docs
          </a>
        )}
        <span className="ml-auto">
          <Button tone="danger" onClick={() => drop(node.id)}>
            Delete
          </Button>
        </span>
      </div>
    </div>
  );
}

function workerValue(node: Node, key: string): unknown {
  const worker = node.worker;
  switch (key) {
    case "name":
      return node.name;
    case "main":
      return worker?.main;
    case "compatibility_date":
      return worker?.compatibilityDate;
    case "compatibility_flags":
      return worker?.compatibilityFlags;
    case "workers_dev":
      return worker?.workersDev;
    default:
      return node.config?.[key];
  }
}

/** Map a wrangler key back onto the typed WorkerConfig the model stores. */
function workerPatch(key: string, value: unknown): Record<string, unknown> {
  switch (key) {
    case "main":
      return { main: value };
    case "compatibility_date":
      return { compatibilityDate: value };
    case "compatibility_flags":
      return { compatibilityFlags: value };
    case "workers_dev":
      return { workersDev: value };
    default:
      return { [key]: value };
  }
}

/** The model stores consumer settings camelCased; wrangler uses snake_case. */
const CONSUMER_KEYS: Record<string, string> = {
  max_batch_size: "maxBatchSize",
  max_batch_timeout: "maxBatchTimeout",
  max_retries: "maxRetries",
  max_concurrency: "maxConcurrency",
  dead_letter_queue: "deadLetterQueue",
  retry_delay: "retryDelay",
};
const consumerKey = (key: string) => CONSUMER_KEYS[key] ?? key;

function Inbound({
  edge,
  label,
  onOpen,
  onConsumer,
}: {
  edge: Edge;
  label: string;
  onOpen: () => void;
  onConsumer: (patch: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const isConsumer = edge.kind === "queue_consumer";

  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 text-[11px]">
        <button onClick={onOpen} className="min-w-0 flex-1 truncate text-left hover:text-accent">
          {label}
        </button>
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">
          {edge.bindingName ? `env.${edge.bindingName}` : edge.kind.replace("_", " ")}
        </span>
        {isConsumer && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 text-ink-dim hover:text-ink"
            title="Delivery settings"
          >
            {open ? "−" : "+"}
          </button>
        )}
      </div>

      {isConsumer && open && (
        <div className="mt-2 border-l border-line pl-3">
          {QUEUE_CONSUMER_FIELDS.map((field) => (
            <Field
              key={field.key}
              field={field}
              value={
                (edge.consumer as Record<string, unknown> | undefined)?.[
                  consumerKey(field.key)
                ]
              }
              onCommit={(value) => onConsumer({ [consumerKey(field.key)]: value })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Outbound({
  edge,
  target,
  onOpen,
  onPatch,
}: {
  edge: Edge;
  target: Node | undefined;
  onOpen: () => void;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const fields = target ? configSchemaFor(target.kind).binding : [];

  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 text-[11px]">
        <button onClick={onOpen} className="min-w-0 flex-1 truncate text-left hover:text-accent">
          {target?.name ?? edge.to}
        </button>
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">
          {edge.bindingName ? `env.${edge.bindingName}` : edge.kind}
        </span>
        {fields.length > 0 && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 text-ink-dim hover:text-ink"
            title="Binding settings"
          >
            {open ? "−" : "+"}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 border-l border-line pl-3">
          {fields.map((field) => (
            <Field
              key={field.key}
              field={field}
              value={edge.config?.[field.key] ?? edge.raw?.[field.key]}
              onCommit={(value) => onPatch({ [field.key]: value })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Commits on blur or Enter rather than per keystroke, so one edit is one undo
 * step instead of one per character typed.
 */
function Field({
  field,
  value,
  onCommit,
}: {
  field: ConfigField;
  value: unknown;
  onCommit: (value: unknown) => void;
}) {
  const asText =
    field.type === "string[]"
      ? Array.isArray(value)
        ? value.join(", ")
        : ""
      : value === undefined || value === null
        ? ""
        : String(value);

  const [draft, setDraft] = useState(asText);
  const [focused, setFocused] = useState(false);
  useEffect(() => setDraft(asText), [asText]);

  const commit = (raw: string) => {
    if (field.type === "number") {
      const parsed = raw.trim() === "" ? undefined : Number(raw);
      onCommit(Number.isFinite(parsed) ? parsed : undefined);
      return;
    }
    if (field.type === "string[]") {
      onCommit(raw.split(",").map((part) => part.trim()).filter(Boolean));
      return;
    }
    onCommit(raw.trim());
  };

  const unsetLabel = field.defaultHint ? `default (${field.defaultHint})` : "not set";

  return (
    <label className="mb-3 block">
      <span className="flex items-baseline gap-1 text-[11px]">
        <span className="text-ink">{field.label}</span>
        {field.required && (
          <span className="text-danger" title="Required">
            *
          </span>
        )}
        <span className="ml-auto font-mono text-[9px] text-ink-faint">{field.key}</span>
      </span>

      {field.type === "boolean" ? (
        <Select
          className="mt-1"
          value={value === undefined ? "" : String(value)}
          onChange={(e) =>
            onCommit(e.target.value === "" ? undefined : e.target.value === "true")
          }
        >
          <option value="">{unsetLabel}</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      ) : field.type === "enum" ? (
        <Select
          className="mt-1"
          value={asText}
          onChange={(e) => onCommit(e.target.value || undefined)}
        >
          <option value="">{unsetLabel}</option>
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          className="mt-1"
          value={draft}
          placeholder={field.placeholder ?? field.defaultHint ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setDraft(asText);
          }}
        />
      )}

      {/* Help stays out of the way until you are actually in the field, so a
          group of ten does not become ten paragraphs. */}
      {(focused || field.required) && (
        <span className="mt-1 block text-[10px] leading-relaxed text-ink-faint">
          {field.help}
        </span>
      )}
    </label>
  );
}

function Group({
  title,
  open: initiallyOpen = false,
  children,
}: {
  title: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <section className="mb-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="mb-2 flex w-full items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint transition-colors hover:text-ink-dim"
      >
        <span>{title}</span>
        <span className="ml-auto">{open ? "−" : "+"}</span>
      </button>
      {open && children}
    </section>
  );
}
