import { randomUUID } from 'node:crypto';
import type { AgentQuestion } from '../../shared/types';

type Emit = (question: AgentQuestion) => void;

/**
 * Lets the assistant ask the user something and wait for the answer.
 *
 * Without this the only way to ask is to end the turn and hope the user's next
 * message is a reply — which loses the thread of what the assistant was doing,
 * and is useless mid-task ("which of these three flights?"). A question is a
 * tool call: the turn stays open, the answer comes back as the tool's result,
 * and the loop continues with it.
 *
 * The shape mirrors ApprovalManager deliberately. Both are the same pattern —
 * the model needs something only the user can supply — and an abort must
 * resolve them rather than leave a dialog waiting for an answer forever.
 */
export class QuestionManager {
  private pending = new Map<string, { resolve: (answer: string | null) => void }>();
  private emit: Emit = () => {};

  setEmitter(emit: Emit) {
    this.emit = emit;
  }

  /**
   * Resolves with what the user typed, or null if they dismissed it or the run
   * was stopped. Never rejects: an unanswered question is an outcome the model
   * should be told about, not an error that ends the turn.
   */
  async ask(
    sessionId: string,
    question: string,
    options: string[],
    signal: AbortSignal,
  ): Promise<string | null> {
    if (signal.aborted) return null;

    const req: AgentQuestion = {
      id: randomUUID(),
      sessionId,
      question,
      options: options.slice(0, 8),
    };

    return new Promise<string | null>((resolve) => {
      const finish = (answer: string | null) => {
        this.pending.delete(req.id);
        signal.removeEventListener('abort', onAbort);
        resolve(signal.aborted ? null : answer);
      };
      const onAbort = () => finish(null);
      this.pending.set(req.id, { resolve: finish });
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        this.emit(req);
      } catch {
        finish(null);
      }
    });
  }

  answer(id: string, text: string | null) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.resolve(text);
  }

  /** Nothing may be left waiting when the window closes. */
  cancelAll() {
    for (const [, entry] of this.pending) entry.resolve(null);
    this.pending.clear();
  }
}
