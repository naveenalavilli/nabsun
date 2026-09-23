import type { RiskLevel, ToolSpec } from '../../../shared/types';
import type { HistoryStore } from '../../history';
import type { SettingsStore } from '../../store';
import type { TabManager } from '../../tabs';

export interface ToolImages {
  mediaType: string;
  data: string;
}

export interface ToolResult {
  content: string;
  images?: ToolImages[];
}

export interface ToolContext {
  tabs: TabManager;
  history: HistoryStore;
  settings: SettingsStore;
  /**
   * The tab the agent is currently working in. Tools default to this rather
   * than the user's active tab so that the agent does not lose its place when
   * the user clicks around mid-run.
   */
  getAgentTabId(): string | null;
  setAgentTabId(id: string | null): void;
  /** Pushes a one-line progress note into the transcript. */
  status(message: string): void;
  /**
   * Asks the user something and waits for the answer, keeping the turn open.
   * Resolves to null when they skip it or the run is stopped. Absent for
   * callers with no one to ask — an external agent has no sidebar.
   */
  ask?(question: string, options: string[]): Promise<string | null>;
  signal: AbortSignal;
  userDataPath: string;
  /** Host decision; absent means no permission to disclose saved notes. */
  memoryAllowed?: boolean;
}

export interface Tool extends ToolSpec {
  handler(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | string>;
}

export function defineTool(
  spec: {
    name: string;
    description: string;
    risk: RiskLevel;
    source?: string;
    properties: Record<string, unknown>;
    required?: string[];
  },
  handler: Tool['handler'],
): Tool {
  return {
    name: spec.name,
    description: spec.description,
    risk: spec.risk,
    source: spec.source ?? 'browser',
    inputSchema: {
      type: 'object',
      properties: spec.properties,
      required: spec.required ?? [],
      additionalProperties: false,
    },
    handler,
  };
}

/**
 * Refuses to continue into a side effect after the run was stopped.
 *
 * Checking once, before the handler is entered, is not enough. A handler awaits
 * — highlighting an element, waiting for a page to settle — and a Stop landing
 * during that await used to be ignored: the click was still issued afterwards.
 * Call this immediately before anything that changes the page or the world, so
 * the last thing checked before an action is whether the action is still wanted.
 */
export function assertLive(ctx: ToolContext, what: string): void {
  if (ctx.signal.aborted) {
    throw new Error(`Stopped before ${what}. Nothing was changed by this call.`);
  }
}

/** Argument coercion — models occasionally send numbers as strings and vice versa. */
export function num(value: unknown, fallback?: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (fallback !== undefined) return fallback;
  throw new Error(`Expected a number, received ${JSON.stringify(value)}`);
}

export function str(value: unknown, fallback?: string): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new Error('Expected a string, received nothing');
  }
  return String(value);
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}
