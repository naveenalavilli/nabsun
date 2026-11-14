import type { Settings } from './types';

export type AssistantApprovalMode = 'ask' | 'automatic' | 'full';
export const APPROVAL_MODES = {
  ask: { label: 'Ask for approval', description: 'Read pages automatically. Ask before changing pages or files.' },
  automatic: { label: 'Approve routine actions', description: 'Allow routine actions on the first site in each task. Ask for uploads, page scripts, file changes, and other sites.' },
  full: { label: 'Full access', description: 'Run assistant tools without approval prompts. Built-in file tools still need a folder you connect.' },
} as const;

export function approvalMode(settings: Pick<Settings, 'autoApprove' | 'approvalMode'>): AssistantApprovalMode {
  if (settings.approvalMode === 'full' && settings.autoApprove.dangerous === true) return 'full';
  return settings.autoApprove.write ? 'automatic' : 'ask';
}

export function approvalSettings(mode: AssistantApprovalMode): Partial<Settings> {
  return { approvalMode: mode, autoApprove: { safe: true, write: mode !== 'ask', dangerous: mode === 'full' } };
}

export const USAGE_AGREEMENT_VERSION = 1;
export function needsUsageAgreement(settings: Pick<Settings, 'usageAgreementRequired' | 'usageAgreementVersion'>): boolean {
  return settings.usageAgreementRequired === true && settings.usageAgreementVersion !== USAGE_AGREEMENT_VERSION;
}
