import { randomUUID } from 'node:crypto';
import type { PromptQueueState, QueuedPrompt } from '../../shared/types';

/** Pending prompts stay outside model history until their turn starts. */
export class PromptQueue {
  private sessions = new Map<string, PromptQueueState>();

  constructor(private readonly deps: {
    send: (sessionId: string, prompt: QueuedPrompt) => Promise<void>;
    changed: (state: PromptQueueState) => void;
    started: (sessionId: string, prompt: QueuedPrompt) => void;
  }) {}

  get(sessionId: string): PromptQueueState {
    const state = this.sessions.get(sessionId);
    return { sessionId, active: state?.active ?? null, pending: [...(state?.pending ?? [])] };
  }

  submit(sessionId: string, text: string, attachPage = false) {
    if (!text.trim()) return;
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { sessionId, active: null, pending: [] };
      this.sessions.set(sessionId, state);
    }
    state.pending.push({ id: randomUUID(), text: text.trim(), attachPage });
    this.deps.changed(this.get(sessionId));
    if (!state.active) void this.drain(state);
  }

  /** Once picked up, a prompt can only be cancelled through Stop. */
  cancel(sessionId: string, id: string): boolean {
    const state = this.sessions.get(sessionId);
    const index = state?.pending.findIndex(prompt => prompt.id === id) ?? -1;
    if (!state || index < 0) return false;
    state.pending.splice(index, 1);
    this.deps.changed(this.get(sessionId));
    return true;
  }

  clear(sessionId?: string) {
    for (const state of this.sessions.values()) {
      if (sessionId !== undefined && state.sessionId !== sessionId) continue;
      state.pending.length = 0;
      this.deps.changed(this.get(state.sessionId));
    }
  }

  private async drain(state: PromptQueueState) {
    while (state.pending.length) {
      const prompt = state.pending.shift()!;
      state.active = prompt;
      this.deps.changed(this.get(state.sessionId));
      try {
        this.deps.started(state.sessionId, prompt);
        await this.deps.send(state.sessionId, prompt);
      } catch (err) {
        console.error('[prompt-queue] turn failed:', err);
      } finally {
        state.active = null;
      }
    }
    this.sessions.delete(state.sessionId);
    this.deps.changed(this.get(state.sessionId));
  }
}
