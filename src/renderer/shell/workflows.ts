import type {
  Batch,
  DatasetSummary,
  RecordedTask,
  Workflow,
} from '../../shared/workflows';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

/** This UI renders table cells and workflow names as text, never HTML. */
export class WorkflowsView {
  private scope: string | null = null;
  private datasetId = '';
  private workflowId = '';
  private datasets: DatasetSummary[] = [];
  private workflows: Workflow[] = [];
  private generation = 0;

  constructor(private root: HTMLElement) {
    window.nabsun.workflows.onScope((context) => {
      this.scope = context.scope;
      this.datasetId = '';
      this.workflowId = context.workflowId ?? '';
      void this.render();
    });
    window.nabsun.workflows.onChanged((batch) => {
      if (batch.scope === this.scope && this.root.querySelector('#data-runs')) {
        void this.task(() => this.runs());
      }
    });
  }

  private q<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.root.querySelector<T>(selector)!;
  }

  private status(error: unknown) {
    const output = this.root.querySelector('[role=status]');
    const text = error instanceof Error ? error.message : String(error);
    if (output) output.textContent = text;
    else if (text)
      this.root.replaceChildren(
        node('h1', 'Data & workflows'),
        node('p', text),
      );
  }

  private async task(action: () => Promise<unknown>) {
    try {
      this.status('');
      await action();
    } catch (error) {
      this.status(error);
    }
  }

  render() {
    return this.task(() => this.renderPage());
  }

  private async renderPage() {
    const generation = ++this.generation;
    this.scope ??= await window.nabsun.workflows.context();
    if (generation !== this.generation) return;
    if (!this.scope) {
      this.root.replaceChildren(
        node('h1', 'Data & workflows'),
        node(
          'p',
          'Open a chat, then choose Data & workflows from Assistant options.',
        ),
      );
      return;
    }
    const scope = this.scope;
    const [datasets, workflows] = await Promise.all([
      window.nabsun.workflows.datasets(scope),
      window.nabsun.workflows.list(),
    ]);
    if (generation !== this.generation) return;
    this.datasets = datasets;
    this.workflows = workflows;
    if (!datasets.some((data) => data.id === this.datasetId))
      this.datasetId = datasets[0]?.id ?? '';
    if (!workflows.some((workflow) => workflow.id === this.workflowId))
      this.workflowId = workflows[0]?.id ?? '';
    this.root.innerHTML = [
      '<div class="data-page-heading"><span class="welcome-eyebrow">REPEAT WORK, WITH LESS EFFORT</span><h1>Data &amp; workflows</h1><p>Add a table, save a task that worked, and repeat it row by row. Review the results as you go.</p></div>',
      '<div class="data-flow" aria-label="Three steps: add a table, choose a workflow, review results"><span><b>1</b> Add a table</span><i aria-hidden="true">&rarr;</i><span><b>2</b> Choose a workflow</span><i aria-hidden="true">&rarr;</i><span><b>3</b> Review results</span></div>',
      '<p class="data-status" role="status"></p><div class="data-columns"><section class="data-card"><h2>Your table</h2><p>CSV, TSV, or Excel (.xlsx). Include a header row. Up to 5,000 rows.</p><button id="data-attach" class="primary">Add a table</button><label for="data-dataset">Table for this chat</label><select id="data-dataset"></select><div id="data-preview"></div>',
      '<details><summary>Paste from a spreadsheet</summary><form id="data-paste"><label for="data-table-name">Table name</label><input id="data-table-name" value="Pasted table" maxlength="120"><label for="data-table-text">Paste the header and rows</label><textarea id="data-table-text" rows="5" maxlength="8388608" required></textarea><button type="submit">Add pasted table</button></form></details></section>',
      '<section class="data-card"><h2>Choose how to enter it</h2><label for="data-mode">Run method</label><select id="data-mode"><option value="workflow">Saved workflow: no model when steps match</option><option value="assistant">Assistant: a new task for each row</option></select><div id="data-workflow-method"><label for="data-workflow">Saved workflow</label><select id="data-workflow"></select><p id="data-workflow-info" class="hint"></p><div class="data-actions"><button id="data-export-workflow">Export workflow</button><button id="data-import-workflow">Import workflow</button></div></div>',
      '<div id="data-assistant-method" hidden><label for="data-template">Task template</label><textarea id="data-template" rows="3" placeholder="Enter the row values in this form."></textarea><p class="hint">Use column names such as {{Name}}. Row values arrive separately as data. Local/API assistants are supported.</p><label for="data-success">Success message on the page</label><input id="data-success" maxlength="500" placeholder="Saved {{Name}}"></div>',
      '<details><summary>Row limits and recovery</summary><p class="hint">An uncertain submission pauses for review.</p><label for="data-steps">Maximum tool steps per row</label><input id="data-steps" type="number" min="1" max="100" value="40"><label for="data-tokens">Token budget per row</label><input id="data-tokens" type="number" min="200" max="200000" value="8000"><label for="data-seconds">Time per row (seconds)</label><input id="data-seconds" type="number" min="5" max="300" value="90"><label for="data-failures">Pause after consecutive failures</label><input id="data-failures" type="number" min="1" max="10" value="3"></details><button id="data-start" class="primary">Start row-by-row run</button><p class="hint">The workflow opens its saved start page for each row. Action approvals still apply.</p></section></div>',
      '<section class="data-card"><h2>Save the task you just completed</h2><p>Complete a task in the assistant first, then map entered text to table columns.</p><form id="data-record"><label for="data-workflow-name">Workflow name</label><input id="data-workflow-name" maxlength="120" required><label for="data-record-success">Final success message</label><input id="data-record-success" maxlength="500" required placeholder="Saved {{Name}}"><div id="data-variable-map"></div><button class="primary" type="submit">Save successful task</button></form><p id="data-record-note" class="hint"></p>',
      '<details><summary>Advanced: review or edit saved steps</summary><p class="hint">Each step needs a target and a postcondition. Review literal values before sharing a workflow.</p><label for="data-workflow-json">Workflow definition</label><textarea id="data-workflow-json" rows="8" spellcheck="false"></textarea><button id="data-update-workflow">Save edited steps</button></details></section>',
      '<section class="data-card"><h2>Runs and results</h2><p>Progress is saved after each row. Uncertain submissions are never retried automatically.</p><div id="data-runs"></div><div id="data-report"></div></section>',
    ].join('');
    const choose = this.q<HTMLSelectElement>('#data-dataset');
    this.options(
      choose,
      datasets.map((data) => [
        data.id,
        data.name + ' (' + data.rowCount + ' rows)',
      ]),
      this.datasetId,
      'Add a table first',
    );
    const workflowSelect = this.q<HTMLSelectElement>('#data-workflow');
    this.options(
      workflowSelect,
      workflows.map((workflow) => [workflow.id, workflow.name]),
      this.workflowId,
      'Save or import a workflow',
    );
    choose.addEventListener('change', () => {
      this.datasetId = choose.value;
      void this.task(async () => {
        await this.preview();
        await this.mapping();
      });
    });
    workflowSelect.addEventListener('change', () => {
      this.workflowId = workflowSelect.value;
      this.workflowDetails();
    });
    this.q('#data-mode').addEventListener('change', () => {
      const workflow =
        this.q<HTMLSelectElement>('#data-mode').value === 'workflow';
      this.q('#data-workflow-method').hidden = !workflow;
      this.q('#data-assistant-method').hidden = workflow;
    });
    this.q('#data-attach').addEventListener(
      'click',
      () =>
        void this.task(async () => {
          const data = await window.nabsun.workflows.attach(scope);
          if (data) this.datasetId = data.id;
          await this.render();
        }),
    );
    this.q('#data-paste').addEventListener('submit', (event) => {
      event.preventDefault();
      void this.task(async () => {
        const data = await window.nabsun.workflows.paste(
          scope,
          this.q<HTMLTextAreaElement>('#data-table-text').value,
          this.q<HTMLInputElement>('#data-table-name').value,
        );
        this.datasetId = data.id;
        await this.render();
      });
    });
    this.q('#data-import-workflow').addEventListener(
      'click',
      () =>
        void this.task(async () => {
          const workflow = await window.nabsun.workflows.import();
          if (workflow) this.workflowId = workflow.id;
          await this.render();
        }),
    );
    this.q('#data-export-workflow').addEventListener(
      'click',
      () =>
        void this.task(() => window.nabsun.workflows.export(this.workflowId)),
    );
    this.q('#data-update-workflow').addEventListener(
      'click',
      () =>
        void this.task(async () => {
          await window.nabsun.workflows.update(
            JSON.parse(
              this.q<HTMLTextAreaElement>('#data-workflow-json').value,
            ),
          );
          await this.render();
        }),
    );
    this.q('#data-record').addEventListener('submit', (event) => {
      event.preventDefault();
      void this.task(async () => {
        const entries = [
          ...this.root.querySelectorAll<HTMLSelectElement>(
            '[data-map-literal]',
          ),
        ]
          .filter((select) => select.value)
          .map((select) => [select.dataset.mapLiteral!, select.value]);
        const mapping = Object.fromEntries(entries);
        for (const [literal, column] of entries)
          if (mapping[literal] !== column)
            throw Error(
              'A repeated value maps to different columns. Edit the individual saved steps instead.',
            );
        const workflow = await window.nabsun.workflows.saveTrace(
          scope,
          this.q<HTMLInputElement>('#data-workflow-name').value,
          this.q<HTMLInputElement>('#data-record-success').value,
          this.datasetId || undefined,
          mapping,
        );
        this.workflowId = workflow.id;
        await this.render();
        this.status('Workflow saved. Review its steps before running it.');
      });
    });
    this.q('#data-start').addEventListener(
      'click',
      () =>
        void this.task(async () => {
          if (!this.datasetId) throw Error('Add a table first.');
          const workflow =
            this.q<HTMLSelectElement>('#data-mode').value === 'workflow';
          if (workflow && !this.workflowId)
            throw Error('Save or import a workflow first.');
          await window.nabsun.workflows.start({
            scope,
            datasetId: this.datasetId,
            workflowId: workflow ? this.workflowId : undefined,
            taskTemplate: workflow
              ? undefined
              : this.q<HTMLTextAreaElement>('#data-template').value,
            successText: workflow
              ? undefined
              : this.q<HTMLInputElement>('#data-success').value,
            stepBudget: Number(this.q<HTMLInputElement>('#data-steps').value),
            tokenBudget: Number(this.q<HTMLInputElement>('#data-tokens').value),
            timeBudgetMs:
              1000 * Number(this.q<HTMLInputElement>('#data-seconds').value),
            maxConsecutiveFailures: Number(
              this.q<HTMLInputElement>('#data-failures').value,
            ),
          });
        }),
    );
    this.workflowDetails();
    await this.preview();
    await this.mapping();
    await this.runs();
  }

  private options(
    select: HTMLSelectElement,
    entries: string[][],
    selected: string,
    empty: string,
  ) {
    select.replaceChildren();
    if (!entries.length) {
      const option = node('option', empty);
      option.value = '';
      select.append(option);
    }
    for (const [value, label] of entries) {
      const option = node('option', label);
      option.value = value;
      option.selected = value === selected;
      select.append(option);
    }
  }

  private workflowDetails() {
    const workflow = this.workflows.find(
      (workflow) => workflow.id === this.workflowId,
    );
    this.q('#data-workflow-info').textContent = workflow
      ? workflow.steps.length + ' steps. Start page: ' + workflow.startUrl
      : 'Complete a task, then save it below.';
    this.q<HTMLTextAreaElement>('#data-workflow-json').value = workflow
      ? JSON.stringify(workflow, null, 2)
      : '';
  }

  private async preview() {
    const root = this.q('#data-preview');
    root.replaceChildren();
    if (!this.scope || !this.datasetId) return;
    const dataset = this.datasets.find((data) => data.id === this.datasetId);
    if (!dataset) return;
    const scope = this.scope,
      id = this.datasetId;
    const rows = await window.nabsun.workflows.preview(scope, id);
    if (scope !== this.scope || id !== this.datasetId || !root.isConnected)
      return;
    const wrap = node('div');
    wrap.className = 'data-table-scroll';
    const table = node('table'),
      head = node('tr'),
      thead = node('thead'),
      body = node('tbody');
    for (const column of dataset.columns) head.append(node('th', column));
    thead.append(head);
    table.append(thead);
    for (const row of rows) {
      const tr = node('tr');
      for (const column of dataset.columns) tr.append(node('td', row[column]));
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    root.append(
      node(
        'p',
        'Showing ' + rows.length + ' of ' + dataset.rowCount + ' rows.',
      ),
      wrap,
    );
  }

  private async mapping() {
    const target = this.q('#data-variable-map');
    target.replaceChildren();
    if (!this.scope) return;
    const scope = this.scope,
      id = this.datasetId;
    let trace: RecordedTask;
    try {
      trace = await window.nabsun.workflows.trace(this.scope);
    } catch {
      this.q('#data-record-note').textContent =
        'Complete a task in this chat before recording it.';
      return;
    }
    if (scope !== this.scope || id !== this.datasetId || !target.isConnected)
      return;
    if (!trace.complete) {
      this.q('#data-record-note').textContent =
        trace.reason ?? 'This task needs review before recording.';
      return;
    }
    const dataset = this.datasets.find((data) => data.id === this.datasetId);
    const rows = dataset
      ? await window.nabsun.workflows.preview(scope, dataset.id)
      : [];
    if (scope !== this.scope || id !== this.datasetId || !target.isConnected)
      return;
    this.q('#data-record-note').textContent =
      'Only successful supported browser actions are saved. Review these column mappings.';
    for (const action of trace.actions.filter(
      (action) => typeof action.input.text === 'string',
    )) {
      const literal = String(action.input.text),
        label = node(
          'label',
          (action.target?.name ?? 'Text field') + ': ' + literal.slice(0, 100),
        ),
        select = node('select');
      select.dataset.mapLiteral = literal;
      select.setAttribute(
        'aria-label',
        'Value for ' + (action.target?.name ?? 'text field'),
      );
      const matching =
        dataset?.columns.filter((column) => rows[0]?.[column] === literal) ??
        [];
      this.options(
        select,
        [
          ['', 'Keep the text as entered'],
          ...(dataset?.columns.map((column) => [
            column,
            'Use column: ' + column,
          ]) ?? []),
        ],
        matching.length === 1 ? matching[0] : '',
        'Keep text',
      );
      label.append(select);
      target.append(label);
    }
  }

  private async runs() {
    const scope = this.scope;
    if (!scope) return;
    const batches = await window.nabsun.workflows.batches(scope);
    if (scope !== this.scope) return;
    const target = this.root.querySelector('#data-runs');
    if (!target) return;
    target.replaceChildren();
    if (!batches.length) {
      target.append(node('p', 'Your row-by-row runs will appear here.'));
      return;
    }
    for (const batch of batches.slice(0, 10)) {
      const card = node('article');
      card.className = 'data-run';
      card.append(
        node(
          'strong',
          batch.state +
            ': ' +
            batch.successes +
            ' completed, ' +
            batch.failures +
            ' failed, ' +
            batch.skipped +
            ' skipped',
        ),
      );
      const progress = node('progress');
      progress.max = batch.rowCount;
      progress.value = batch.successes + batch.failures + batch.skipped;
      progress.setAttribute('aria-label', 'Completed rows');
      card.append(
        progress,
        node(
          'p',
          'Row ' +
            Math.min(batch.cursor, batch.rowCount) +
            ' of ' +
            batch.rowCount,
        ),
      );
      if (batch.lastError) card.append(node('p', batch.lastError));
      const actions = node('div');
      actions.className = 'data-actions';
      const button = (label: string, action: () => Promise<unknown>) => {
        const button = node('button', label);
        button.addEventListener('click', () => void this.task(action));
        actions.append(button);
      };
      if (['running', 'pausing'].includes(batch.state))
        button('Pause after this row', () =>
          window.nabsun.workflows.control(scope, batch.id, 'pause'),
        );
      else if (batch.state !== 'completed')
        button('Resume', () =>
          window.nabsun.workflows.control(scope, batch.id, 'resume'),
        );
      if (batch.state !== 'completed') {
        button('Stop', () =>
          window.nabsun.workflows.control(scope, batch.id, 'stop'),
        );
        button('Skip next pending row', () =>
          window.nabsun.workflows.control(scope, batch.id, 'skip'),
        );
      }
      button('View report', () => this.report(batch));
      button('Export CSV', () =>
        window.nabsun.workflows.exportReport(scope, batch.id, 'csv'),
      );
      button('Export JSON', () =>
        window.nabsun.workflows.exportReport(scope, batch.id, 'json'),
      );
      card.append(actions);
      target.append(card);
    }
  }

  private async report(batch: Batch) {
    const report = await window.nabsun.workflows.report(batch.scope, batch.id),
      root = this.q('#data-report');
    root.replaceChildren(
      node('h3', 'Run report'),
      node(
        'p',
        'Reports include entered values, which can contain personal data.',
      ),
    );
    const review = report.rows.find((row) => row.status === 'needs-review');
    if (review) {
      const box = node('div');
      box.className = 'data-review';
      box.append(
        node('strong', 'Review row ' + review.row + ' on the website first.'),
        node('p', review.error ?? 'The row may already have been submitted.'),
      );
      const complete = node(
        'button',
        'I checked: this row is already complete',
      );
      complete.addEventListener(
        'click',
        () =>
          void this.task(async () => {
            await window.nabsun.workflows.control(
              batch.scope,
              batch.id,
              'complete',
            );
            await this.runs();
            await this.report(batch);
          }),
      );
      const skip = node('button', 'I checked: skip this row');
      skip.addEventListener(
        'click',
        () =>
          void this.task(async () => {
            await window.nabsun.workflows.control(
              batch.scope,
              batch.id,
              'review-skip',
            );
            await this.runs();
            await this.report(batch);
          }),
      );
      const retry = node('button', 'I checked: prepare this row for retry');
      retry.addEventListener(
        'click',
        () =>
          void this.task(async () => {
            await window.nabsun.workflows.control(
              batch.scope,
              batch.id,
              'retry',
            );
            await this.runs();
            await this.report(batch);
          }),
      );
      box.append(complete, skip, retry);
      root.append(box);
    }
    const wrap = node('div');
    wrap.className = 'data-table-scroll';
    const table = node('table'),
      head = node('tr'),
      thead = node('thead'),
      body = node('tbody');
    for (const title of [
      'Row',
      'Result',
      'Steps',
      'Model calls',
      'Time',
      'Details',
    ])
      head.append(node('th', title));
    thead.append(head);
    table.append(thead);
    for (const row of report.rows.slice(0, 50)) {
      const tr = node('tr');
      for (const value of [
        String(row.row),
        row.status,
        String(row.steps),
        String(row.modelCalls),
        (row.durationMs / 1000).toFixed(1) + 's',
        row.error ?? row.targets.join('; '),
      ])
        tr.append(node('td', value));
      if (row.entries?.length) {
        const cell = tr.lastElementChild!;
        const details = node('details'),
          summary = node('summary', 'Entered fields (preview)');
        details.append(summary);
        for (const entry of row.entries)
          details.append(node('p', entry.target + ': ' + entry.value));
        cell.append(details);
      }
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    root.append(
      wrap,
      node(
        'p',
        'Showing up to 50 rows near the current position. Exports include the complete recorded results.',
      ),
    );
  }
}
