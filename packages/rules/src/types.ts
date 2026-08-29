import type { SystemModel } from "@flarecraft/model";
import type { Plan } from "@flarecraft/catalog";

/**
 * A finding is anchored to the thing that is wrong.
 *
 * `nodeId` / `edgeId` are what let the canvas render a rule inline rather than
 * in a list somewhere else — being told you are making a mistake while you draw
 * it is the entire difference between a linter and a report.
 */
export type Severity = "error" | "warning" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** What to actually do. A finding without one is only half a finding. */
  remedy?: string;
  nodeId?: string;
  edgeId?: string;
  docs?: string;
}

export interface RuleContext {
  system: SystemModel;
  plan: Plan;
}

export interface Rule {
  id: string;
  title: string;
  run: (context: RuleContext) => Finding[];
}
