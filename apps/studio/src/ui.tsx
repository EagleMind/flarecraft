import type { ReactNode } from "react";

/**
 * The handful of shapes the panel actually uses.
 *
 * These exist because the alternative was what this codebase had: a hundred
 * inline style objects repeating the same six colours. Tailwind 4 turns the
 * `@theme` tokens in index.css into utilities, so a button is a className.
 */

type ButtonTone = "default" | "primary" | "danger" | "ghost";

const BUTTON_TONE: Record<ButtonTone, string> = {
  default: "border-line bg-raised text-ink hover:border-line-strong",
  primary: "border-accent/60 bg-accent/10 text-accent hover:bg-accent/20",
  danger: "border-danger/60 bg-danger/10 text-danger hover:bg-danger/20",
  ghost: "border-transparent text-ink-dim hover:text-ink hover:bg-raised",
};

export function Button({
  onClick,
  disabled,
  tone = "default",
  title,
  full,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  tone?: ButtonTone;
  title?: string;
  full?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        BUTTON_TONE[tone]
      } ${full ? "w-full" : ""}`}
    >
      {children}
    </button>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      spellCheck={false}
      {...props}
      className={`w-full rounded border border-line bg-surface px-2 py-1.5 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none ${
        props.className ?? ""
      }`}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full rounded border border-line bg-surface px-2 py-1.5 text-[11px] text-ink focus:border-accent focus:outline-none ${
        props.className ?? ""
      }`}
    />
  );
}

/** A labelled group in the panel. Collapsible when it has a lot inside. */
export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="mb-5">
      <h2 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {title}
        {count !== undefined && count > 0 && (
          <span className="rounded-full bg-raised px-1.5 text-[9px] text-ink-dim">
            {count}
          </span>
        )}
      </h2>
      {children}
    </section>
  );
}

const SEVERITY_TONE = {
  error: "border-danger/60 text-danger",
  warning: "border-warn/60 text-warn",
  info: "border-line text-ink-faint",
} as const;

export function Badge({
  tone = "info",
  children,
}: {
  tone?: keyof typeof SEVERITY_TONE;
  children: ReactNode;
}) {
  return (
    <span
      className={`shrink-0 rounded border px-1 py-px text-[9px] font-semibold uppercase leading-none ${SEVERITY_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/** An inline message. `tone` carries the meaning, so the text does not have to. */
export function Note({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "error" | "ok";
  children: ReactNode;
}) {
  const tones = {
    info: "border-line text-ink-dim",
    warn: "border-warn/50 text-warn",
    error: "border-danger/50 text-danger",
    ok: "border-ok/50 text-ok",
  };
  return (
    <p className={`mb-3 rounded border px-2 py-2 text-[11px] leading-relaxed ${tones[tone]}`}>
      {children}
    </p>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-ink-dim">{children}</p>;
}
