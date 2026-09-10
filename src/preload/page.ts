/**
 * Preload for ordinary web pages.
 *
 * Runs in an isolated world with no Node access and exposes nothing to the
 * page. It does two things the main process cannot do for itself: report the
 * current text selection, and drive password autofill.
 *
 * Autofill deliberately lives here rather than in the agent bridge: it must run
 * on every page automatically, before the user interacts, whereas the bridge is
 * injected on demand when the assistant is working.
 */
import { ipcRenderer } from 'electron';

/* ------------------------------------------------------------- selection -- */

let lastSelection = '';
let selectionTimer = 0;

document.addEventListener('selectionchange', () => {
  // Selection changes fire continuously while dragging; report once it settles.
  window.clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(() => {
    const text = (window.getSelection()?.toString() ?? '').trim().slice(0, 8_000);
    if (text === lastSelection) return;
    lastSelection = text;
    ipcRenderer.send('page:selection', text);
  }, 200);
});

/* -------------------------------------------------------------- passwords -- */

interface LoginFields {
  password: HTMLInputElement;
  username: HTMLInputElement | null;
  form: HTMLFormElement | null;
}

const USERNAME_HINT =
  /user|email|login|account|signin|identifier|phone|mobile|handle|nick/i;

function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Finds the username field belonging to a password field: the nearest visible
 * text-like input before it, preferring one whose name or type says so.
 */
function findUsernameFor(password: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = password.form ?? document;
  const candidates = Array.from(
    scope.querySelectorAll<HTMLInputElement>('input'),
  ).filter(
    (input) =>
      input !== password &&
      ['text', 'email', 'tel', 'username', ''].includes((input.type || '').toLowerCase()) &&
      isVisible(input),
  );
  if (!candidates.length) return null;

  const before = candidates.filter(
    (c) => password.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_PRECEDING,
  );
  const pool = before.length ? before : candidates;

  const named = pool.find((c) =>
    USERNAME_HINT.test(`${c.name} ${c.id} ${c.autocomplete} ${c.getAttribute('aria-label') ?? ''}`),
  );
  return named ?? pool[pool.length - 1];
}

function findLoginFields(): LoginFields[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .filter(isVisible)
    .map((password) => ({
      password,
      username: findUsernameFor(password),
      form: password.form,
    }));
}

/** Sets a value the way a framework-controlled input will notice. */
function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

let filledOnce = false;

async function tryAutofill() {
  if (filledOnce) return;
  const fields = findLoginFields();
  if (!fields.length) return;

  const credentials = (await ipcRenderer.invoke('pw:for-origin')) as
    | { id: string; username: string; password: string }[]
    | null;
  if (!credentials?.length) return;

  // With several saved logins we cannot know which is wanted, so fill the
  // first only when there is exactly one; otherwise leave it to the user.
  if (credentials.length !== 1) return;
  const [credential] = credentials;

  for (const field of fields) {
    // Never overwrite something the user has already typed.
    if (field.password.value) continue;
    if (field.username && !field.username.value) setValue(field.username, credential.username);
    setValue(field.password, credential.password);
    filledOnce = true;
  }
  if (filledOnce) ipcRenderer.send('pw:used', credential.id);
}

/** Reports a submitted credential so the main process can offer to save it. */
function captureOnSubmit() {
  const seen = new WeakSet<HTMLElement>();

  const capture = (fields: LoginFields) => {
    const password = fields.password.value;
    if (!password) return;
    const username = fields.username?.value ?? '';
    ipcRenderer.send('pw:capture', { username, password });
  };

  const wire = () => {
    for (const fields of findLoginFields()) {
      const target: HTMLElement = fields.form ?? fields.password;
      if (seen.has(target)) continue;
      seen.add(target);

      if (fields.form) {
        // Capture-phase, so a handler calling stopPropagation cannot hide it.
        fields.form.addEventListener('submit', () => capture(fields), true);
      }
      // Many sign-in pages never submit a form; they post from a click or an
      // Enter key, so watch those too.
      fields.password.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') capture(fields);
      });
      const button = fields.form?.querySelector<HTMLElement>(
        'button[type="submit"], input[type="submit"], button:not([type])',
      );
      button?.addEventListener('click', () => capture(fields), true);
    }
  };

  wire();
  return wire;
}

let rewire: (() => void) | null = null;

function scan() {
  void tryAutofill();
  rewire?.();
}

window.addEventListener('DOMContentLoaded', () => {
  rewire = captureOnSubmit();
  scan();

  // Sign-in forms are frequently rendered after load, or revealed by a click,
  // so keep watching rather than scanning once.
  const observer = new MutationObserver(() => scan());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // A late scan catches forms that appear after scripts settle.
  window.setTimeout(scan, 1200);
});
