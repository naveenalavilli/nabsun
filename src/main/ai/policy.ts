import type { RiskLevel } from '../../shared/types';
import type { SettingsStore } from '../store';

export interface PolicyAction {
  tool: string;
  risk: RiskLevel;
  origin?: string;
  input: Readonly<Record<string, unknown>>;
  source?: string;
}
export type PolicyDecision =
  | { allowed: false; reason: string }
  | { allowed: true; requirePrompt?: boolean };
/** Host-supplied policy; a model, page, or MCP client cannot replace it. */
export interface PolicyProvider {
  evaluate(action: PolicyAction): PolicyDecision;
}
export class PolicyDeniedError extends Error {}
export const defaultPolicy: PolicyProvider = {
  evaluate: () => ({ allowed: true }),
};
export function integrationPolicy(
  settings: Pick<SettingsStore, 'get'>,
): PolicyProvider {
  return {
    evaluate: (action) => {
      const controls = settings.get().integrationControls;
      const key = action.source?.startsWith('plugin:')
        ? 'plugins'
        : action.source?.startsWith('mcp:')
          ? 'mcp'
          : action.source?.startsWith('extension')
            ? 'extensions'
            : null;
      return key && controls?.[key] === false
        ? {
            allowed: false,
            reason: `${key} integrations are disabled in Settings.`,
          }
        : { allowed: true };
    },
  };
}
