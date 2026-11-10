const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
  const item = document.createElement(tag);
  item.textContent = text;
  return item;
};
export class ActivityView {
  private generation = 0;
  constructor(private root: HTMLElement) {}
  async render(day?: string) {
    const generation = ++this.generation;
    this.root.replaceChildren(
      element('h1', 'Assistant activity'),
      element(
        'p',
        'Review what the assistant attempted and how it was approved. Typed data and page values are stored as fingerprints, so the journal does not contain their original text.',
      ),
    );
    const status = element('p', 'Checking activity integrity…');
    status.setAttribute('role', 'status');
    this.root.append(status);
    try {
      const data = await window.nabsun.activity.list(day);
      if (generation !== this.generation) return;
      status.textContent = 'Journal integrity verified.';
      const controls = element('div');
      controls.className = 'data-actions';
      const select = element('select');
      select.setAttribute('aria-label', 'Activity date');
      for (const day of [...data.days].reverse()) {
        const option = element('option', day);
        option.value = day;
        select.append(option);
      }
      select.value = day ?? data.days.at(-1) ?? '';
      select.addEventListener('change', () => void this.render(select.value));
      const search = element('input');
      search.type = 'search';
      search.placeholder = 'Filter by action, website, or result';
      search.setAttribute('aria-label', 'Filter activity');
      const exportButton = element('button', 'Export this day');
      exportButton.disabled = !data.days.length;
      exportButton.addEventListener('click', () => {
        void window.nabsun.activity.export(select.value).catch(() => {
          status.textContent =
            'Could not export this journal. Check the destination and try again.';
        });
      });
      controls.append(select, search, exportButton);
      this.root.append(controls);
      const list = element('div');
      this.root.append(list);
      const paint = () => {
        list.replaceChildren();
        const query = search.value.toLowerCase();
        const actions = new Map<
          string,
          {
            intent?: (typeof data.records)[number];
            result?: (typeof data.records)[number];
          }
        >();
        for (const record of data.records) {
          const action = actions.get(record.event.actionId) ?? {};
          action[record.event.phase] = record;
          actions.set(record.event.actionId, action);
        }
        for (const action of [...actions.values()].reverse()) {
          const record = action.result ?? action.intent!,
            event = record.event,
            origin = event.origin ?? action.intent?.event.origin ?? 'Browser';
          const label = `${event.tool} · ${origin} · ${event.status ?? 'Unfinished — check the website before retrying'}`;
          if (query && !label.toLowerCase().includes(query)) continue;
          const card = element('article');
          card.className = 'data-run';
          card.append(
            element('strong', label),
            element(
              'p',
              `${new Date(record.time).toLocaleTimeString()}${event.approver ? ' · Approved by ' + event.approver : ''}`,
            ),
          );
          const details = element('details');
          details.append(
            element('summary', 'Technical record'),
            element('pre', JSON.stringify(action, null, 2)),
          );
          card.append(details);
          list.append(card);
        }
        if (!list.children.length)
          list.append(element('p', 'No matching activity.'));
      };
      search.addEventListener('input', paint);
      paint();
      this.root.append(
        element(
          'p',
          'Shows the latest 200 records for this day. Export includes the full day. Retention is controlled in Assistant & permissions settings. A journal detects changes; it cannot protect against someone who can rewrite the journal and its checkpoints.',
        ),
      );
    } catch {
      if (generation === this.generation)
        status.textContent =
          'Activity could not be verified. Actions will stop if the journal is damaged or cannot be saved. Restart Nabsun and preserve the activity files for review.';
    }
  }
}
