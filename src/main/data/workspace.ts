import type { BatchSpec } from './batchRunner';
import { BatchRunner } from './batchRunner';
import { BatchStore } from './batches';
import { DatasetStore } from './datasets';
import { WorkflowStore } from './workflowStore';
import { createRepair } from './repair';
import type { FileStore } from '../files';
import type { Agent } from '../ai/agent';
import type { SessionStore } from '../ai/sessions';
import type { TabManager } from '../tabs';
import type { SettingsStore } from '../store';
import type { Provider } from '../ai/provider';
import type { Batch } from '../../shared/workflows';
export class DataWorkspace {
  readonly datasets: DatasetStore;
  readonly workflows: WorkflowStore;
  readonly batches: BatchStore;
  readonly runner: BatchRunner;
  scope: string | null = null;
  constructor(
    profile: string,
    files: FileStore,
    readonly agent: Agent,
    readonly tabs: TabManager,
    readonly sessions: SessionStore,
    settings: SettingsStore,
    providers: Map<string, Provider>,
    changed: (batch: Batch) => void,
    datasets?: DatasetStore,
  ) {
    this.datasets = datasets ?? new DatasetStore(profile, files);
    this.workflows = new WorkflowStore(profile);
    this.batches = new BatchStore(profile);
    this.runner = new BatchRunner(
      this.batches,
      this.datasets,
      this.workflows,
      agent,
      tabs,
      sessions,
      settings,
      changed,
      createRepair(providers, settings),
    );
  }
  check(scope: string) {
    if (typeof scope !== 'string' || !this.sessions.load(scope))
      throw Error('Open a chat before using data and workflows.');
    return scope;
  }
  async open(scope: string) {
    this.check(scope);
    for (const batch of this.batches.list(scope))
      if (['running', 'pausing'].includes(batch.state))
        await this.runner.pause(scope, batch.id);
    this.scope = scope;
  }
  saveTrace(
    scope: string,
    name: string,
    successText: string,
    datasetId?: string,
    variables?: Record<string, string>,
  ) {
    this.check(scope);
    const dataset = datasetId ? this.datasets.get(scope, datasetId) : undefined;
    if (
      variables &&
      Object.values(variables).some(
        (column) => !dataset?.columns.includes(column),
      )
    )
      throw Error('Variable mapping refers to an unknown dataset column.');
    return this.workflows.fromTrace(
      name,
      this.agent.recordedTask(scope),
      successText,
      variables,
    );
  }
  start(spec: BatchSpec) {
    this.check(spec.scope);
    if (!this.tabs.active)
      throw Error('Open a website before starting a batch.');
    return this.runner.start(spec);
  }
}
