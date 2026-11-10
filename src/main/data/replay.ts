import type {
  Workflow,
  WorkflowStep,
  TargetDescriptor,
} from '../../shared/workflows';
import type { PageSnapshot, PageElement } from '../../shared/types';
import type { TabManager } from '../tabs';
import { fillVariables, matchTarget } from './workflowStore';
export interface RepairResult {
  ref: string;
  inputTokens: number;
  outputTokens: number;
}
export interface ReplayContext {
  tabs: TabManager;
  tabId: string;
  signal: AbortSignal;
  call: (name: string, input: Record<string, unknown>) => Promise<string>;
  repair?: (
    target: TargetDescriptor,
    snapshot: PageSnapshot,
    signal: AbortSignal,
    budgetTokens: number,
  ) => Promise<RepairResult | null>;
  stepBudget: number;
  tokenBudget: number;
  timeBudgetMs: number;
  checkpoint?: (
    step: number,
    state: 'started' | 'completed',
    entry?: { target: string; value: string },
  ) => void;
  save: (workflow: Workflow) => void;
}
export interface ReplayResult {
  steps: number;
  repairs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  targets: string[];
}
export async function replay(
  workflow: Workflow,
  row: Record<string, string>,
  ctx: ReplayContext,
): Promise<ReplayResult> {
  const started = Date.now(),
    result: ReplayResult = {
      steps: 0,
      repairs: 0,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      targets: [],
    };
  const live = () => {
    if (ctx.signal.aborted) throw Error('Replay stopped.');
    if (Date.now() - started > ctx.timeBudgetMs)
      throw Error('Row time budget exceeded.');
    if (result.steps > ctx.stepBudget) throw Error('Row step budget exceeded.');
    if (result.inputTokens + result.outputTokens > ctx.tokenBudget)
      throw Error('Row token budget exceeded.');
  };
  const tab = ctx.tabs.resolveTarget(ctx.tabId);
  const snapshot = async () => {
    live();
    const snap = await ctx.tabs.callBridge<PageSnapshot>(
      tab,
      'window.__nabsunAgent.snapshot({maxChars:8000})',
      ctx.signal,
    );
    if (!workflow.origins.includes(new URL(snap.url).origin))
      throw Error("The page left this workflow's allowed origins.");
    return snap;
  };
  const expected = (text: string) => fillVariables(text, row);
  const inputValue = (value: unknown): unknown =>
    typeof value === 'string'
      ? expected(value)
      : Array.isArray(value)
        ? value.map(inputValue)
        : value;
  for (let index = 0; index < workflow.steps.length; index++) {
    live();
    const step = workflow.steps[index],
      before = await snapshot();
    let target: PageElement | null = null,
      repaired = false;
    if (step.target) {
      target = matchTarget(before.elements, step.target);
      if (!target) {
        if (!ctx.repair)
          throw Error(
            'Target changed or is ambiguous. Review this step: ' +
              step.target.name,
          );
        result.modelCalls++;
        const repair = await ctx.repair(
          step.target,
          before,
          ctx.signal,
          ctx.tokenBudget - result.inputTokens - result.outputTokens,
        );
        if (!repair)
          throw Error('The assistant could not safely repair this step.');
        result.inputTokens += repair.inputTokens;
        result.outputTokens += repair.outputTokens;
        live();
        target =
          before.elements.find(
            (element) =>
              element.ref === repair.ref &&
              element.role === step.target!.role &&
              element.origin === step.target!.origin,
          ) ?? null;
        if (!target)
          throw Error(
            'Repair returned a target outside the current snapshot or origin.',
          );
        repaired = true;
        result.repairs++;
      }
    }
    if (
      step.postcondition.kind === 'text' &&
      before.text.includes(expected(step.postcondition.expected))
    )
      throw Error(
        'The success message is already present before the action. Use a fresh form or a unique row identifier.',
      );
    const input = Object.fromEntries(
      Object.entries(step.input).map(([key, value]) => [
        key,
        inputValue(value),
      ]),
    );
    if (
      step.tool === 'browser_navigate' &&
      !workflow.origins.includes(new URL(String(input.url)).origin)
    )
      throw Error('Navigation would leave workflow origins.');
    if (result.steps >= ctx.stepBudget)
      throw Error('Row step budget exceeded.');
    ctx.checkpoint?.(index, 'started');
    live();
    await ctx.call(step.tool, {
      ...input,
      ...(target ? { ref: target.ref } : {}),
      tabId: ctx.tabId,
    });
    result.steps++;
    let after = await snapshot();
    const descriptor = target
      ? {
          role: target.role,
          name: target.name,
          origin: target.origin!,
          placeholder: target.placeholder,
          cssHint: step.target?.cssHint,
        }
      : undefined;
    const deadline = Date.now() + 5000;
    while (!(await verify(step, after, descriptor)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = await snapshot();
    }
    if (!(await verify(step, after, descriptor)))
      throw Error(
        'Postcondition failed after step ' +
          (index + 1) +
          '. The row needs review; replay will not continue.',
      );
    if (repaired && descriptor) {
      step.target = descriptor;
      workflow.updatedAt = Date.now();
      ctx.save(workflow);
    }
    const entry =
      typeof input.text === 'string'
        ? { target: target?.name ?? '', value: input.text }
        : Array.isArray(input.values)
          ? { target: target?.name ?? '', value: JSON.stringify(input.values) }
          : undefined;
    ctx.checkpoint?.(index, 'completed', entry);
    result.targets.push(
      target
        ? `${target.origin}: ${target.role} ${target.name}`
        : String(input.url),
    );
  }
  return result;
  async function verify(
    step: WorkflowStep,
    snap: PageSnapshot,
    descriptor?: TargetDescriptor,
  ): Promise<boolean> {
    const condition = step.postcondition;
    if (condition.kind === 'url')
      return snap.url === expected(condition.expected);
    if (condition.kind === 'text')
      return snap.text.includes(expected(condition.expected));
    if (condition.kind === 'target')
      return !!matchTarget(snap.elements, condition.target);
    const found = descriptor ? matchTarget(snap.elements, descriptor) : null;
    if (!found) return false;
    const state = await ctx.tabs.callBridge<{
      value?: string;
      checked?: boolean;
    }>(
      tab,
      `window.__nabsunAgent.describeTarget(${JSON.stringify(found.ref)})`,
      ctx.signal,
    );
    return condition.kind === 'checked'
      ? state.checked === condition.expected
      : state.value === expected(condition.expected);
  }
}
