import type { Settings } from '../../shared/types';

export function appearanceSelector(settings: Settings, changed: (next: Settings) => void): HTMLElement {
  const root = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = 'Appearance';
  const label = document.createElement('label');
  label.textContent = 'Color mode';
  const mode = document.createElement('select');
  mode.setAttribute('aria-label', 'Color mode');
  for (const [value, name] of [['system', 'Follow device'], ['light', 'Light'], ['dark', 'Dark']]) mode.add(new Option(name, value));
  mode.value = settings.theme;
  label.append(mode);
  const choices = document.createElement('div');
  choices.className = 'theme-choices';
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', 'Visual theme');
  const status = document.createElement('p');
  status.className = 'hint';
  status.setAttribute('role', 'status');
  status.textContent = 'Pick a style that feels like you. New tab pages use it when opened or reloaded.';
  let current = settings;
  const buttons: HTMLButtonElement[] = [];
  async function save(patch: Partial<Settings>) {
    mode.disabled = true;
    buttons.forEach(b => b.disabled = true);
    try {
      current = await window.nabsun.settings.set(patch);
      changed(current);
      status.textContent = 'Theme saved. New tab pages use it when opened or reloaded.';
    } catch { status.textContent = 'Could not save your theme. Please try again.'; }
    finally {
      mode.value = current.theme;
      mode.disabled = false;
      buttons.forEach(b => { b.disabled = false; b.setAttribute('aria-pressed', String(b.dataset.appearance === current.appearance)); });
    }
  }
  for (const [id, name, description] of [
    ['classic', 'Classic', 'Warm and minimal'],
    ['playful', 'Playful', 'Bright and imaginative'],
    ['blossom', 'Blossom', 'Soft rose tones'],
    ['ocean', 'Ocean', 'Cool and calm'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-choice';
    button.dataset.appearance = id;
    button.setAttribute('aria-pressed', String(settings.appearance === id));
    const swatch = document.createElement('span');
    swatch.className = `theme-swatch theme-swatch-${id}`;
    swatch.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    title.textContent = name;
    const detail = document.createElement('span');
    detail.textContent = description;
    button.append(swatch, title, detail);
    button.addEventListener('click', () => void save({ appearance: id }));
    buttons.push(button);
    choices.append(button);
  }
  mode.addEventListener('change', () => void save({ theme: mode.value as Settings['theme'] }));
  root.append(legend, label, choices, status);
  return root;
}
