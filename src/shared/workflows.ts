export interface Dataset {
  schemaVersion: 1;
  id: string;
  scope: string;
  name: string;
  columns: string[];
  rows: Record<string, string>[];
  createdAt: number;
}
export interface DatasetSummary {
  id: string;
  name: string;
  columns: string[];
  rowCount: number;
}
export interface TargetDescriptor {
  role: string;
  name: string;
  origin: string;
  placeholder?: string;
  cssHint?: string;
}
export type Postcondition =
  | { kind: 'value'; expected: string }
  | { kind: 'checked'; expected: boolean }
  | { kind: 'text'; expected: string }
  | { kind: 'target'; target: TargetDescriptor }
  | { kind: 'url'; expected: string };
export interface WorkflowStep {
  tool:
    | 'browser_type'
    | 'browser_click'
    | 'browser_select'
    | 'browser_set_checked'
    | 'browser_hover'
    | 'browser_navigate';
  target?: TargetDescriptor;
  input: Record<string, unknown>;
  postcondition: Postcondition;
}
export interface Workflow {
  schemaVersion: 1;
  id: string;
  name: string;
  startUrl: string;
  origins: string[];
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt: number;
}
export interface RecordedAction {
  tool: string;
  input: Record<string, unknown>;
  target?: TargetDescriptor;
  beforeUrl: string;
  afterUrl: string;
  afterValue?: string;
  afterChecked?: boolean;
}
export interface RecordedTask {
  actions: RecordedAction[];
  modelCalls?: number;
  complete: boolean;
  reason?: string;
}
export type RowStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'needs-review';
export interface RowResult {
  row: number;
  status: RowStatus;
  steps: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  repairs: number;
  targets: string[];
  entries?: { target: string; value: string }[];
  error?: string;
  failureImage?: string;
  startedAt?: number;
  completedAt?: number;
}
export interface Batch {
  schemaVersion: 1;
  id: string;
  scope: string;
  datasetId: string;
  workflowId?: string;
  taskTemplate?: string;
  successText?: string;
  lastError?: string;
  rowCount: number;
  cursor: number;
  state: 'ready' | 'running' | 'pausing' | 'paused' | 'stopped' | 'completed';
  successes: number;
  failures: number;
  skipped: number;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  stepBudget: number;
  tokenBudget: number;
  timeBudgetMs: number;
  createdAt: number;
  updatedAt: number;
}
export interface BatchReport {
  batch: Batch;
  rows: RowResult[];
}
