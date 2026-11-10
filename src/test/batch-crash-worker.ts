import fs from 'node:fs';
import path from 'node:path';
import { app, BaseWindow } from 'electron';
import { FileStore } from '../main/files';
import { DatasetStore } from '../main/data/datasets';
import { WorkflowStore } from '../main/data/workflowStore';
import { BatchStore } from '../main/data/batches';
import { BatchRunner } from '../main/data/batchRunner';
import { Agent } from '../main/ai/agent';
import { ApprovalManager } from '../main/ai/approvals';
import { SessionStore } from '../main/ai/sessions';
import { SettingsStore } from '../main/store';
import { HistoryStore } from '../main/history';
import { TabManager } from '../main/tabs';
import { browserTools } from '../main/ai/tools/browser';

const configPath = process.argv
  .find((arg) => arg.startsWith('--crash-config='))
  ?.slice(15);
if (!configPath) throw Error('Missing fixture configuration');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
  profile: string;
  scope: string;
  batch: string;
  hold: boolean;
};
app.setPath('userData', config.profile);
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

async function main() {
  await app.whenReady();
  const files = new FileStore(config.profile),
    datasets = new DatasetStore(config.profile, files);
  const workflows = new WorkflowStore(config.profile),
    store = new BatchStore(config.profile);
  const sessions = new SessionStore(config.profile),
    settings = new SettingsStore(),
    history = new HistoryStore();
  const window = new BaseWindow({ show: false, width: 1100, height: 800 });
  window.showInactive();
  const tabs = new TabManager({
    window,
    history,
    partition: 'crash-fixture',
    preloadPath: path.join(__dirname, '../preload/page.js'),
    homepage: 'about:blank',
    onFindResult: () => {},
  });
  tabs.setBounds({ x: 0, y: 0, width: 1100, height: 800 });
  tabs.create('about:blank');
  const approvals = new ApprovalManager(settings);
  const agent = new Agent({
    files,
    datasets,
    settings,
    history,
    tabs,
    approvals,
    sessions,
    providers: new Map(),
    getTools: () => browserTools(),
    userDataPath: config.profile,
    emit: () => {},
  });
  const runner = new BatchRunner(
    store,
    datasets,
    workflows,
    agent,
    tabs,
    sessions,
    settings,
    () => {},
    undefined,
    async (_batch, row) => {
      if (config.hold && row.row === 20) {
        // Deliberately freeze after the fsynced result, before the cursor update.
        process.stdout.write('DURABLE_ROW_20\n');
        await new Promise<void>(() => {});
      }
    },
  );
  try {
    runner.resume(config.scope, config.batch);
    await runner.wait(config.batch);
    const batch = store.get(config.scope, config.batch);
    if (batch.state !== 'completed')
      throw Error(batch.lastError || 'Batch did not finish');
  } finally {
    agent.abortAll();
    approvals.denyAll();
    tabs.destroyAll();
    window.destroy();
    settings.flush();
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
