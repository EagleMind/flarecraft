import { useState } from "react";
import type { DeploymentPlan } from "@flarecraft/model";
import { Button, Input, Note, Section } from "./ui.js";
import { useStudio } from "./store.js";

interface StepResult {
  label: string;
  command: string;
  ok: boolean;
  output: string;
  capturedId?: string;
}

interface DeployResult {
  outDir: string;
  results: StepResult[];
  blockers: string[];
  unresolved: string[];
  completed: boolean;
  error?: string;
}

/**
 * Deploy, in two steps on purpose.
 *
 * "Plan" shows every command that would run and why it sits where it does. Only
 * then does "Run" execute them. This is the one place flarecraft writes to a
 * Cloudflare account, and creating billable resources behind a single
 * unconfirmed click is not a convenience worth having.
 */
export function DeployPanel() {
  const system = useStudio((s) => s.system);
  const projectFolder = useStudio((s) => s.projectFolder);
  const exportRepo = useStudio((s) => s.exportRepo);

  const [plan, setPlan] = useState<DeploymentPlan | undefined>();
  const [result, setResult] = useState<DeployResult | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [outDir, setOutDir] = useState("");

  const post = async <T,>(url: string, body: unknown): Promise<T> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json()) as T;
  };

  const makePlan = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      setPlan(await post<DeploymentPlan>("/api/deploy/plan", { system }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const target = outDir.trim() || projectFolder;
      const body = await post<DeployResult>("/api/deploy/run", {
        system,
        ...(target ? { outDir: target } : {}),
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
    <div className="text-[11px]">
      <p className="mb-3 leading-relaxed text-ink-dim">
        Creates the resources this system needs, writes the configs, and deploys
        every Worker in dependency order.
      </p>

      {!result && (
        <>
          <Input
            value={outDir}
            onChange={(e) => setOutDir(e.target.value)}
            placeholder={projectFolder ?? "working directory (blank = ~/.flarecraft/deploys)"}
            className="mb-2"
          />

          <div className="mb-4 flex gap-2">
            <Button onClick={() => void makePlan()} disabled={busy || !system}>
              {busy && !plan ? "planning…" : "Plan"}
            </Button>
            <Button onClick={() => void exportRepo(outDir)} disabled={busy || !system}>
              Write files only
            </Button>
          </div>
        </>
      )}

      {error && <Note tone="error">{error}</Note>}

      {plan && !result && (
        <>
          {plan.blockers.map((blocker, i) => (
            <Note key={i} tone="warn">
              {blocker}
            </Note>
          ))}

          <Section title={`${plan.steps.length} steps, in this order`}>
            <ol>
              {plan.steps.map((step, i) => (
                <li key={i} className="mb-3 flex gap-2">
                  <span className="shrink-0 text-ink-faint">{i + 1}.</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-ink">{step.label}</div>
                    <code className="mt-0.5 block break-all font-mono text-[10px] text-accent">
                      {step.command}
                    </code>
                    <div className="mt-0.5 leading-relaxed text-ink-faint">{step.why}</div>
                    {step.yieldsId && (
                      <div className="mt-0.5 text-warn">
                        prints an id that goes back into a config
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          <Button full tone="danger" onClick={() => void execute()} disabled={busy}>
            {busy ? "deploying…" : `Run all ${plan.steps.length} steps`}
          </Button>
          <p className="mt-2 leading-relaxed text-ink-faint">
            This creates real resources on your Cloudflare account. It stops at
            the first failure rather than pressing on.
          </p>
        </>
      )}

      {result && (
        <>
          <Note tone={result.completed ? "ok" : "error"}>
            {result.completed
              ? `Deployed. ${result.results.length} step(s) ran in ${result.outDir}.`
              : `Stopped after ${result.results.length} step(s). The last one failed.`}
          </Note>

          {result.unresolved.length > 0 && (
            <Section title="Needs your attention">
              <ul>
                {result.unresolved.map((item, i) => (
                  <li key={i} className="mb-2 leading-relaxed text-warn">
                    {item}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Steps">
            <ul>
              {result.results.map((step, i) => (
                <li key={i} className="mb-3 flex gap-2">
                  <span className={`shrink-0 ${step.ok ? "text-ok" : "text-danger"}`}>
                    {step.ok ? "✓" : "✗"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-ink">{step.label}</div>
                    {step.capturedId && (
                      <div className="font-mono text-[10px] text-ink-faint">
                        id {step.capturedId}
                      </div>
                    )}
                    {step.output && (
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-line p-2 font-mono text-[10px] text-ink-dim">
                        {step.output}
                      </pre>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          <Button
            full
            onClick={() => {
              setResult(undefined);
              setPlan(undefined);
            }}
          >
            Done
          </Button>
        </>
      )}
    </div>
  );
}
