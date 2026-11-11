import type { SendOptions } from './agent';
export const INTERACTIVE_CLI_TIMEOUT_MS = 30 * 60 * 1000;
/** Explicit workflow budgets stay capped; normal supervised CLI chats get more time. */
export function turnTimeLimit(provider: string, supplied?: SendOptions['budget']) {
  return !supplied && provider.endsWith('-cli') ? INTERACTIVE_CLI_TIMEOUT_MS
    : supplied ? Math.max(1000, Math.min(300000, supplied.timeMs)) : undefined;
}
export class TaskInterruption extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function timeLimitInterruption(milliseconds: number) {
  const minutes=milliseconds>=60000, count=Math.round(milliseconds/(minutes?60000:1000));
  const duration=`${count} ${minutes?'minute':'second'}${count===1?'':'s'}`;
  return new TaskInterruption('time_limit', `The assistant reached this task's time limit (${duration}). Review the completed actions, then ask me to continue. Completed actions were not undone.`);
}
export function interruptedTask(signal: AbortSignal) {
  return signal.reason instanceof TaskInterruption ? signal.reason
    : new TaskInterruption('interrupted', 'The task was interrupted. Review the completed actions, then ask me to continue.');
}
export const userStop = () => new TaskInterruption('user_stop', 'Stopped because you pressed Stop. You can ask me to continue.');
