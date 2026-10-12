import type { ProviderId, Settings } from '../../shared/types';

// Suggestions, not an account entitlement list. Keep Default and custom IDs available.
// https://learn.chatgpt.com/docs/models
// https://code.claude.com/docs/en/model-config
const suggestions: Partial<Record<ProviderId, [string, string][]>> = {
  'codex-cli': [['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-luna', 'GPT-6 Luna'], ['gpt-6-astra', 'GPT-6 Astra']],
  'claude-cli': [['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']],
};

/** Shared by chat and Settings; edits only the selected provider's saved model. */
export function modelPicker(settings: Settings, changed: (next: Settings) => void): HTMLElement {
  const provider = settings.provider;
  const root = document.createElement('div');
  root.className = 'model-picker';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Model');
  const control = document.createElement('div');
  control.className = 'model-select-control';
  control.append(select);
  const saved = settings.models[provider] || '';
  const options = [['', 'Default (use CLI settings)'], ...(suggestions[provider] || [])];
  if (saved && !options.some(([id]) => id === saved)) options.push([saved, saved]);
  for (const [id, label] of options) select.add(new Option(label, id));
  select.add(new Option('Other model…', '__custom__'));
  select.value = saved;
  const custom = document.createElement('form');
  custom.className = 'model-custom';
  custom.hidden = true;
  const input = document.createElement('input');
  input.placeholder = 'Model ID';
  input.setAttribute('aria-label', 'Custom model ID');
  input.required = true;
  input.maxLength = 160;
  const apply = document.createElement('button');
  apply.textContent = 'Apply';
  apply.className = 'primary';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.className = 'ghost';
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Applies to your next message. Model access depends on your account.';
  hint.setAttribute('role', 'status');
  let current = saved;
  async function save(value: string) {
    select.disabled = apply.disabled = cancel.disabled = input.disabled = true;
    try {
      const latest = await window.nabsun.settings.get();
      const next = await window.nabsun.settings.set({ models: { ...latest.models, [provider]: value } });
      current = value;
      if (![...select.options].some(o => o.value === value)) select.add(new Option(value, value), select.options.length - 1);
      select.value = value;
      custom.hidden = true;
      hint.textContent = 'Saved for your next message. Model access depends on your account.';
      changed(next);
    } catch {
      select.value = current;
      hint.textContent = 'Could not save the model. Please try again.';
    } finally {
      select.disabled = apply.disabled = cancel.disabled = input.disabled = false;
    }
  }
  select.addEventListener('change', () => {
    custom.hidden = select.value !== '__custom__';
    if (!custom.hidden) { input.value = ''; input.focus(); }
    else void save(select.value);
  });
  custom.addEventListener('submit', e => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value || /\s/.test(value) || value.startsWith('-') || value === '__custom__') {
      hint.textContent = 'Enter a model ID without spaces or a leading dash.';
      return;
    }
    void save(value);
  });
  cancel.addEventListener('click', () => { custom.hidden = true; select.value = current; select.focus(); });
  custom.append(input, apply, cancel);
  root.append(control, custom, hint);
  return root;
}
