import type { UpdateStatus } from '../../shared/updates';

let status: UpdateStatus = { state: 'idle', currentVersion: '' };
let availableVersion = '';
let checking = false;
let openError = false;
let started = false;

function paint() {
  const toolbar = document.querySelector<HTMLButtonElement>('#update-btn');
  if (toolbar) {
    toolbar.hidden = !availableVersion;
    toolbar.title = `Nabsun ${availableVersion} is available. Open the download page.`;
  }
  document.querySelectorAll<HTMLElement>('[data-update-status]').forEach(node => {
    const prefix = status.currentVersion ? `Nabsun ${status.currentVersion}. ` : '';
    node.textContent = prefix + (openError ? 'Could not open the download page. Please try again.'
      : checking ? 'Checking for updates…'
      : status.state === 'available' ? `Version ${availableVersion} is available.`
      : status.state === 'current' ? 'You’re up to date.'
      : status.state === 'error' ? 'Could not check for updates. Check your connection and retry in a minute.'
      : 'Check for the latest release.');
  });
  document.querySelectorAll<HTMLButtonElement>('[data-update-check]').forEach(button => { button.disabled = checking; });
  document.querySelectorAll<HTMLButtonElement>('[data-update-open]').forEach(button => { button.hidden = !availableVersion; });
}

export async function checkForUpdates(manual = false) {
  if (checking) return;
  checking = true;
  openError = false;
  paint();
  try {
    status = await window.nabsun.updates.check(manual);
    if (status.state === 'available') availableVersion = status.latestVersion!;
    else if (status.state === 'current') availableVersion = '';
  } catch {
    status = { ...status, state: 'error' };
  } finally { checking = false; paint(); }
}

async function openRelease() {
  try { await window.nabsun.updates.open(); openError = false; }
  catch { openError = true; }
  paint();
  if (openError) document.querySelector<HTMLButtonElement>('#settings-btn')?.click();
}

export function updatesSection(): HTMLElement {
  const section = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = 'App updates';
  const message = document.createElement('p');
  message.dataset.updateStatus = '';
  message.setAttribute('role', 'status');
  const check = document.createElement('button');
  check.className = 'ghost';
  check.dataset.updateCheck = '';
  check.textContent = 'Check for updates';
  check.addEventListener('click', () => { void checkForUpdates(true); });
  const download = document.createElement('button');
  download.className = 'primary';
  download.dataset.updateOpen = '';
  download.textContent = 'Download update';
  download.addEventListener('click', () => { void openRelease(); });
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Checks GitHub at startup and every 24 hours. Downloads open in your default browser; install the update yourself.';
  section.append(legend, message, check, download, hint);
  // Settings mounts this synchronously; refresh all mounted copies without retaining detached views.
  queueMicrotask(paint);
  return section;
}

export function startUpdateChecks() {
  if (started) return;
  started = true;
  document.querySelector('#update-btn')?.addEventListener('click', () => { void openRelease(); });
  void checkForUpdates();
  window.setInterval(() => { void checkForUpdates(); }, 24 * 60 * 60_000);
}
