import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Workflow,
  WorkflowStep,
  RecordedTask,
  TargetDescriptor,
} from '../../shared/workflows';
import type { PageElement } from '../../shared/types';
import { durableJson, readJson, validId } from './storage';
const allowed = new Set([
  'browser_type',
  'browser_click',
  'browser_select',
  'browser_set_checked',
  'browser_hover',
  'browser_navigate',
]);
function safeUrl(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error('Workflow URLs must be HTTP(S) without credentials.');
  if (
    [...url.searchParams.keys()].some((key) =>
      /^(?:access_token|refresh_token|id_token|token|api[_-]?key|authorization|password|secret|code|session(?:id)?)$/i.test(
        key,
      ),
    ) ||
    url.hash
  )
    throw Error(
      'Remove sign-in tokens and URL fragments before saving a workflow.',
    );
  return url;
}
function validTarget(target: TargetDescriptor, origins: string[]) {
  if (
    !target ||
    typeof target.name !== 'string' ||
    target.name.length > 500 ||
    typeof target.role !== 'string' ||
    !target.role ||
    target.role.length > 100 ||
    !origins.includes(target.origin) ||
    (target.placeholder !== undefined &&
      (typeof target.placeholder !== 'string' ||
        target.placeholder.length > 500)) ||
    (target.cssHint !== undefined &&
      (typeof target.cssHint !== 'string' || target.cssHint.length > 1000))
  )
    throw Error('Invalid target descriptor.');
}
export function fillVariables(
  text: string,
  row: Record<string, string>,
): string {
  return text.replace(/\{\{([^{}]+)\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(row, key)) throw Error('Missing column: ' + key);
    return row[key];
  });
}
export function matchTarget(
  elements: PageElement[],
  target: TargetDescriptor,
): PageElement | null {
  const scored = elements
    .filter(
      (element) =>
        element.role === target.role &&
        (element.origin ?? target.origin) === target.origin,
    )
    .map((element) => ({
      element,
      score:
        (element.name === target.name ? (target.placeholder ? 0.8 : 0.9) : 0) +
        (target.placeholder && element.placeholder === target.placeholder
          ? 0.2
          : 0),
    }))
    .filter((match) => match.score >= 0.85);
  return scored.length === 1 ? scored[0].element : null;
}
export class WorkflowStore {
  private dir: string;
  constructor(profile: string) {
    this.dir = path.join(profile, 'workflows');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  save(workflow: Workflow) {
    this.validate(workflow);
    durableJson(path.join(this.dir, workflow.id + '.json'), workflow);
  }
  get(id: string) {
    const workflow = readJson<Workflow>(
      path.join(this.dir, validId(id) + '.json'),
      1024 * 1024,
    );
    this.validate(workflow);
    return workflow;
  }
  list() {
    return fs
      .readdirSync(this.dir)
      .filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))
      .map((file) => this.get(file.slice(0, -5)));
  }
  import(value: unknown) {
    const workflow = structuredClone(value) as Workflow;
    workflow.id = randomUUID();
    workflow.createdAt = workflow.updatedAt = Date.now();
    this.save(workflow);
    return workflow;
  }
  private validate(workflow: Workflow) {
    if (workflow.schemaVersion !== 1)
      throw Error('Unsupported workflow schema.');
    validId(workflow.id);
    if (
      typeof workflow.name !== 'string' ||
      !workflow.name.trim() ||
      workflow.name.length > 120 ||
      !Array.isArray(workflow.steps) ||
      !workflow.steps.length ||
      workflow.steps.length > 100
    )
      throw Error('Invalid workflow name or steps.');
    const start = safeUrl(workflow.startUrl);
    if (
      !Array.isArray(workflow.origins) ||
      !workflow.origins.length ||
      workflow.origins.length > 30 ||
      workflow.origins.some((origin) => safeUrl(origin).origin !== origin) ||
      !workflow.origins.includes(start.origin)
    )
      throw Error('Invalid workflow origins.');
    for (const step of workflow.steps) {
      const keys: Record<string, string[]> = {
        browser_type: ['text', 'submit'],
        browser_click: ['button', 'clickCount', 'expectNavigation'],
        browser_select: ['values'],
        browser_set_checked: ['checked'],
        browser_hover: [],
        browser_navigate: ['url'],
      };
      if (
        !step.input ||
        typeof step.input !== 'object' ||
        Object.keys(step.input).some((key) => !keys[step.tool]?.includes(key))
      )
        throw Error('Unexpected saved action input.');
      if (
        step.tool === 'browser_type' &&
        (typeof step.input.text !== 'string' || step.input.text.length > 32768)
      )
        throw Error('Invalid typed value.');
      if (
        step.tool === 'browser_select' &&
        (!Array.isArray(step.input.values) ||
          step.input.values.length > 100 ||
          step.input.values.some((value) => typeof value !== 'string'))
      )
        throw Error('Invalid selection values.');
      if (
        step.tool === 'browser_set_checked' &&
        typeof step.input.checked !== 'boolean'
      )
        throw Error('Invalid checked state.');
      if (step.target) validTarget(step.target, workflow.origins);
      if (
        step.tool === 'browser_type' &&
        step.input.submit !== undefined &&
        typeof step.input.submit !== 'boolean'
      )
        throw Error('Invalid submit option.');
      if (
        step.tool === 'browser_click' &&
        ((step.input.button !== undefined &&
          !['left', 'right', 'middle'].includes(String(step.input.button))) ||
          (step.input.clickCount !== undefined &&
            ![1, 2].includes(step.input.clickCount as number)) ||
          (step.input.expectNavigation !== undefined &&
            typeof step.input.expectNavigation !== 'boolean'))
      )
        throw Error('Invalid click options.');
      if (
        !allowed.has(step.tool) ||
        !step.postcondition ||
        !['value', 'checked', 'text', 'target', 'url'].includes(
          step.postcondition.kind,
        )
      )
        throw Error('Every supported action needs a postcondition.');
      if (
        step.tool !== 'browser_navigate' &&
        (!step.target || !workflow.origins.includes(step.target.origin))
      )
        throw Error('A step target needs an allowed origin.');
      if (step.tool === 'browser_navigate') {
        if (typeof step.input.url !== 'string')
          throw Error('Invalid navigation URL.');
        const url = safeUrl(step.input.url);
        if (!workflow.origins.includes(url.origin))
          throw Error('Navigation leaves workflow origins.');
      }
      if (step.postcondition.kind === 'target')
        validTarget(step.postcondition.target, workflow.origins);
      if (
        step.postcondition.kind === 'checked' &&
        typeof step.postcondition.expected !== 'boolean'
      )
        throw Error('Invalid checked postcondition.');
      if (
        ['value', 'text', 'url'].includes(step.postcondition.kind) &&
        typeof (step.postcondition as { expected: unknown }).expected !==
          'string'
      )
        throw Error('Invalid text postcondition.');
      if (
        step.postcondition.kind === 'url' &&
        !workflow.origins.includes(safeUrl(step.postcondition.expected).origin)
      )
        throw Error('Postcondition leaves workflow origins.');
      if (
        step.postcondition.kind === 'text' &&
        !step.postcondition.expected.trim()
      )
        throw Error('A success text postcondition cannot be empty.');
      if (
        'expected' in step.postcondition &&
        typeof step.postcondition.expected !== 'boolean' &&
        (typeof step.postcondition.expected !== 'string' ||
          step.postcondition.expected.length > 32768)
      )
        throw Error('Invalid postcondition.');
      if (
        JSON.stringify(step.input).length > 65536 ||
        'ref' in step.input ||
        'tabId' in step.input
      )
        throw Error('Saved inputs cannot contain live tab ids or refs.');
    }
  }
  fromTrace(
    name: string,
    trace: RecordedTask,
    successText: string,
    variables: Record<string, string> = {},
  ): Workflow {
    if (!trace.complete || !trace.actions.length)
      throw Error(
        trace.reason || 'Finish a successful task before saving a workflow.',
      );
    const variable = (value: unknown): unknown =>
      typeof value === 'string'
        ? Object.hasOwn(variables, value)
          ? '{{' + variables[value] + '}}'
          : value
        : Array.isArray(value)
          ? value.map(variable)
          : value;
    const steps: WorkflowStep[] = trace.actions.map((action, index) => {
      if (!allowed.has(action.tool))
        throw Error(
          'This task uses an action that cannot be replayed yet: ' +
            action.tool,
        );
      const input = Object.fromEntries(
        Object.entries(action.input)
          .filter(([key]) => !['ref', 'tabId'].includes(key))
          .map(([key, value]) => [
            key,
            ['text', 'values'].includes(key) ? variable(value) : value,
          ]),
      );
      if (action.tool === 'browser_navigate') input.url = action.afterUrl;
      let postcondition: WorkflowStep['postcondition'];
      if (action.afterUrl !== action.beforeUrl)
        postcondition = { kind: 'url', expected: action.afterUrl };
      else if (action.tool === 'browser_type' && !action.input.submit)
        postcondition = {
          kind: 'value',
          expected: String(variable(action.input.text)),
        };
      else if (action.tool === 'browser_select')
        postcondition = {
          kind: 'value',
          expected: String(variable(action.afterValue ?? '')),
        };
      else if (action.tool === 'browser_set_checked')
        postcondition = {
          kind: 'checked',
          expected: action.afterChecked === true,
        };
      else if (trace.actions[index + 1]?.target)
        postcondition = {
          kind: 'target',
          target: trace.actions[index + 1].target!,
        };
      else {
        if (!successText.trim())
          throw Error('Provide the success message to verify the last action.');
        postcondition = { kind: 'text', expected: successText };
      }
      return {
        tool: action.tool as WorkflowStep['tool'],
        target: action.target,
        input,
        postcondition,
      };
    });
    const workflow: Workflow = {
      schemaVersion: 1,
      id: randomUUID(),
      name,
      startUrl:
        trace.actions[0].tool === 'browser_navigate'
          ? trace.actions[0].afterUrl
          : trace.actions[0].beforeUrl,
      origins: [
        ...new Set(
          trace.actions
            .flatMap((action) => [
              action.target?.origin,
              ...[action.beforeUrl, action.afterUrl].map((url) => {
                try {
                  return new URL(url).origin;
                } catch {
                  return '';
                }
              }),
            ])
            .filter(
              (origin): origin is string => !!origin && origin !== 'null',
            ),
        ),
      ],
      steps,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.save(workflow);
    return workflow;
  }
}
