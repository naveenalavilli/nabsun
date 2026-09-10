import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest } from '../../shared/types';
import type { SettingsStore } from '../store';
import type { Tool } from './tools/types';

type Emit = (req: ApprovalRequest) => void;

interface Pending {
  resolve: (decision: ApprovalDecision) => void;
}

/**
 * The permission gate between the model and anything that changes state.
 * A tool runs only if its risk level is auto-approved, the user has previously
 * chosen "always allow" for it, or they approve this specific call.
 */
export class ApprovalManager {
  private pending = new Map<string, Pending>();
  private emit: Emit = () => {};

  constructor(private readonly settings: SettingsStore) {}

  setEmitter(emit: Emit) {
    this.emit = emit;
  }

  /** Resolves to true when the call may proceed. */
  async request(tool: Tool, input: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
    const settings = this.settings.get();
    if (settings.alwaysAllowTools.includes(tool.name)) return true;
    if (settings.autoApprove[tool.risk]) return true;

    const req: ApprovalRequest = {
      id: randomUUID(),
      toolName: tool.name,
      risk: tool.risk,
      title: describe(tool, input),
      detail: summarizeInput(input),
      input,
    };

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(req.id, { resolve });
      // An aborted turn must not leave a dialog waiting for an answer.
      const onAbort = () => {
        if (this.pending.delete(req.id)) resolve('deny');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.emit(req);
    });

    if (decision === 'allow_always') {
      const current = this.settings.get().alwaysAllowTools;
      if (!current.includes(tool.name)) {
        this.settings.set({ alwaysAllowTools: [...current, tool.name] });
      }
      return true;
    }
    return decision === 'allow';
  }

  resolve(id: string, decision: ApprovalDecision) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.resolve(decision);
  }

  /** Deny everything outstanding, e.g. when the window is closing. */
  denyAll() {
    for (const [, entry] of this.pending) entry.resolve('deny');
    this.pending.clear();
  }
}

function describe(tool: Tool, input: Record<string, unknown>): string {
  switch (tool.name) {
    case 'browser_navigate':
      return `Navigate to ${String(input.url ?? '')}`;
    case 'browser_click':
      return 'Click an element on the page';
    case 'browser_type':
      return `Type into the page${input.submit ? ' and submit' : ''}`;
    case 'browser_evaluate':
      return 'Run JavaScript in the page';
    case 'tab_open':
      return `Open a tab${input.url ? ` at ${String(input.url)}` : ''}`;
    case 'tab_close':
      return 'Close a tab';
    default:
      return `Run ${tool.name}`;
  }
}

function summarizeInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input, null, 2);
  return json.length > 1200 ? `${json.slice(0, 1200)}\n…` : json;
}
