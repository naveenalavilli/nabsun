/**
 * Agent bridge — bundled to an IIFE and injected into every tab's *isolated
 * world*, so it can read and drive the DOM without the page being able to see
 * or tamper with it.
 *
 * The design follows the accessibility-snapshot approach rather than raw HTML:
 * the model receives a compact outline of the page in which every actionable
 * element carries a `[ref=…]` handle, and acts by referring to those handles.
 * A tool call sequence is always snapshot -> act.
 *
 * Handles are opaque and document-qualified — see DOCUMENT_TOKEN — because a
 * handle that outlives its document must fail rather than address whatever
 * inherited its id.
 */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ElementInfo {
  /** Opaque, document-qualified: `<token>-<n>`. Never parse it. */
  ref: string;
  tag: string;
  role: string;
  name: string;
  value?: string;
  placeholder?: string;
  href?: string;
  disabled?: boolean;
  checked?: boolean;
  expanded?: boolean;
  rect: Rect;
}

interface Snapshot {
  url: string;
  title: string;
  text: string;
  elements: ElementInfo[];
  scroll: { x: number; y: number; height: number; viewportHeight: number };
  truncated: boolean;
}

const MAX_TEXT_CHARS = 24_000;
const MAX_ELEMENTS = 500;

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BASE', 'TITLE',
]);

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV',
  'UL', 'OL', 'LI', 'TABLE', 'TR', 'TD', 'TH', 'BLOCKQUOTE', 'PRE', 'FORM',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD',
]);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'switch', 'combobox', 'textbox', 'searchbox', 'slider',
  'spinbutton', 'option', 'treeitem',
]);

/* ------------------------------------------------------------- utilities -- */

function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
    return false;
  }
  if (Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  // Zero-size elements are invisible unless they legitimately wrap content
  // (some layouts collapse containers whose children are absolutely placed).
  if (rect.width === 0 && rect.height === 0 && el.childElementCount === 0) return false;
  return true;
}

/** True when any part of the element sits inside the viewport. */
function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function textOf(el: Element, limit = 160): string {
  // Structured extraction can name a credential field directly, or name a
  // wrapper around one and ask for its text. A textarea's value *is* its text.
  const t = clean(scrubbedText(el));
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}

function implicitRole(el: Element): string {
  const tag = el.tagName;
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.split(/\s+/)[0];
  switch (tag) {
    case 'A':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'BUTTON':
      return 'button';
    case 'SELECT':
      return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    case 'TEXTAREA':
      return 'textbox';
    case 'SUMMARY':
      return 'button';
    case 'INPUT': {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (['hidden'].includes(type)) return 'none';
      return 'textbox';
    }
    default:
      return 'generic';
  }
}

/** Accessible-name computation, close enough to the spec for agent grounding. */
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((n) => clean((n as HTMLElement).innerText || n!.textContent));
    if (parts.length) return parts.join(' ');
  }
  const ariaLabel = clean(el.getAttribute('aria-label'));
  if (ariaLabel) return ariaLabel;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.labels && el.labels.length) {
      const l = clean(Array.from(el.labels).map((n) => n.innerText).join(' '));
      if (l) return l;
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const l = clean(wrapping.innerText);
      if (l) return l;
    }
  }
  if (el instanceof HTMLInputElement) {
    if (el.type === 'submit' || el.type === 'button') return clean(el.value) || clean(el.name);
    const ph = clean(el.placeholder);
    if (ph) return ph;
  }
  if (el instanceof HTMLImageElement) return clean(el.alt);

  const title = clean(el.getAttribute('title'));
  const own = textOf(el, 120);
  if (own) return own;
  if (title) return title;

  // Icon-only controls: fall back to nested img alt / svg title / name attrs.
  const img = el.querySelector('img[alt]');
  if (img) {
    const alt = clean(img.getAttribute('alt'));
    if (alt) return alt;
  }
  const svgTitle = el.querySelector('svg title');
  if (svgTitle) {
    const t = clean(svgTitle.textContent);
    if (t) return t;
  }
  return clean(el.getAttribute('name')) || clean(el.getAttribute('data-testid'));
}

function isInteractive(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'A') return el.hasAttribute('href');
  if (['BUTTON', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(tag)) return true;
  if (tag === 'INPUT') return ((el as HTMLInputElement).type || 'text').toLowerCase() !== 'hidden';
  if (tag === 'LABEL' && (el as HTMLLabelElement).control) return false; // covered by its control
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role.split(/\s+/)[0])) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && tabindex !== '-1') return true;
  if (el.hasAttribute('onclick')) return true;
  // Elements that merely have a click cursor produce far too many false
  // positives, so require a semantic hint rather than styling alone.
  return false;
}

function isDisabled(el: Element): boolean {
  if ((el as HTMLInputElement).disabled) return true;
  return el.getAttribute('aria-disabled') === 'true';
}

/* -------------------------------------------------------------- snapshot -- */

/**
 * Element handles.
 *
 * Ref ids are allocated from a counter that never resets, so an id issued by
 * one snapshot can never be reassigned to a different element by the next. An
 * index-based array reused ids across snapshots, which meant a ref held from an
 * earlier snapshot could resolve — successfully, and silently — to whatever
 * element now occupied that slot: a click on the wrong control with no error.
 *
 * Each handle also records what the element looked like when it was handed out.
 * If the node is still connected but has become something else, resolution
 * fails and asks for a fresh snapshot rather than acting on the difference.
 */
interface RefEntry {
  el: Element;
  /** Snapshot that issued this handle. */
  generation: number;
  /** Identity at issue time. */
  fingerprint: string;
}

/**
 * Identifies the document these handles belong to.
 *
 * A counter alone was not enough: the bridge is re-injected into each new
 * document, which reset the counter to zero, so a handle from the previous page
 * collided with a fresh handle on the next one and actuated whatever now held
 * that id. Handles are therefore issued as `<documentToken>-<n>` and refuse to
 * resolve anywhere but the document that issued them.
 *
 * The token is per-injection and random, so it cannot be predicted or reused
 * across a navigation.
 */
const DOCUMENT_TOKEN = Math.random().toString(36).slice(2, 10);

let refs = new Map<number, RefEntry>();
let refSeq = 0;
let generation = 0;
/** Handles issued by the current snapshot, in order, for `refCount` and lookup. */
let currentRefs: number[] = [];

const handleFor = (id: number): string => `${DOCUMENT_TOKEN}-${id}`;

/**
 * Accepts a handle only from this document.
 *
 * There is deliberately no bare-number path. Allowing `0` or `"0"` as a
 * convenience defeated the entire qualification: after a navigation,
 * `click("0")` addressed the *new* document's first control, while the properly
 * qualified handle from the old document was correctly refused. A handle is
 * either well-formed and current, or it is an error.
 */
function parseHandle(handle: unknown): number {
  const raw = String(handle ?? '');
  const match = /^([a-z0-9]+)-(\d+)$/i.exec(raw);
  if (!match) {
    throw new Error(
      `Malformed ref ${JSON.stringify(raw)}. A ref is an opaque handle from the latest ` +
        'snapshot, like "k3f9a1b2-12" — copy one verbatim, or take a fresh snapshot.',
    );
  }
  if (match[1] !== DOCUMENT_TOKEN) {
    throw new Error(
      `Ref ${JSON.stringify(raw)} belongs to a document this tab has navigated away from. Re-snapshot.`,
    );
  }
  return Number(match[2]);
}

/**
 * Identity of an element at the moment its handle was issued.
 *
 * Tag and name alone let two same-labelled controls, or a link whose
 * destination changed underneath, pass as the same element. The destination and
 * input type are part of what the model was actually shown, so they are part of
 * identity too.
 */
function fingerprintOf(el: Element): string {
  const parts = [el.tagName, accessibleName(el).slice(0, 120)];
  if (el instanceof HTMLAnchorElement) parts.push(el.getAttribute('href') ?? '');
  if (el instanceof HTMLInputElement) parts.push(el.type);
  if (el instanceof HTMLButtonElement) parts.push(el.type);
  const role = el.getAttribute('role');
  if (role) parts.push(role);
  // A separator that cannot occur in a name, so "ab"+"c" and "a"+"bc"
  // cannot produce the same fingerprint. Written as an escape because an
  // invisible control character in source is unreadable and easy to lose.
  return parts.join('\u0001');
}

/** The handle the current snapshot gave this element, if it named it at all. */
function refIdFor(el: Element): string | null {
  for (const id of currentRefs) {
    if (refs.get(id)?.el === el) return handleFor(id);
  }
  return null;
}

function addRef(el: Element): string {
  const id = refSeq++;
  refs.set(id, { el, generation, fingerprint: fingerprintOf(el) });
  currentRefs.push(id);
  return handleFor(id);
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left + window.scrollX),
    y: Math.round(r.top + window.scrollY),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

function describe(el: Element, ref: string): ElementInfo {
  const info: ElementInfo = {
    ref,
    tag: el.tagName.toLowerCase(),
    role: implicitRole(el),
    name: accessibleName(el),
    rect: rectOf(el),
  };
  if (el instanceof HTMLAnchorElement) info.href = el.href;
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') info.checked = el.checked;
    // Any credential-bearing field, not only type=password: a one-time code
    // sits in a plain text input and was appearing in snapshots in full.
    else if (!isCredentialField(el)) info.value = el.value.slice(0, 200);
    if (el.placeholder) info.placeholder = el.placeholder;
  }
  if (el instanceof HTMLTextAreaElement) {
    // Same gate as the input branch. Having one classifier is not enough if a
    // serialisation branch does not call it: a textarea carrying a one-time
    // code went straight into the snapshot while the input beside it was
    // correctly redacted.
    if (!isCredentialField(el)) info.value = el.value.slice(0, 200);
    if (el.placeholder) info.placeholder = el.placeholder;
  }
  if (el instanceof HTMLSelectElement && !isCredentialField(el)) info.value = el.value;
  const expanded = el.getAttribute('aria-expanded');
  if (expanded !== null) info.expanded = expanded === 'true';
  if (isDisabled(el)) info.disabled = true;
  return info;
}

function formatElementLine(info: ElementInfo, indent: string): string {
  const bits = [`${info.role}`];
  if (info.name) bits.push(JSON.stringify(info.name));
  const attrs: string[] = [];
  if (info.value) attrs.push(`value=${JSON.stringify(info.value)}`);
  else if (info.placeholder) attrs.push(`placeholder=${JSON.stringify(info.placeholder)}`);
  if (info.checked !== undefined) attrs.push(info.checked ? 'checked' : 'unchecked');
  if (info.expanded !== undefined) attrs.push(info.expanded ? 'expanded' : 'collapsed');
  if (info.disabled) attrs.push('disabled');
  if (info.href) {
    try {
      const u = new URL(info.href);
      attrs.push(`href=${u.origin === location.origin ? u.pathname + u.search : info.href}`);
    } catch {
      /* opaque href, skip */
    }
  }
  const attrStr = attrs.length ? ` ${attrs.join(' ')}` : '';
  return `${indent}- ${bits.join(' ')}${attrStr} [ref=${info.ref}]`;
}

interface SnapshotOptions {
  /** Only include elements intersecting the viewport. */
  viewportOnly?: boolean;
  maxChars?: number;
}

function buildSnapshot(opts: SnapshotOptions = {}): Snapshot {
  generation++;
  currentRefs = [];
  // Handles from older snapshots stay resolvable — the contract is
  // snapshot → act, and a batch of actions from one snapshot is normal — but
  // the map is bounded so a long-running page cannot grow it without limit.
  if (refs.size > 5_000) {
    for (const [id, entry] of refs) {
      if (entry.generation < generation - 2) refs.delete(id);
    }
  }
  const elements: ElementInfo[] = [];
  const lines: string[] = [];
  const maxChars = opts.maxChars ?? MAX_TEXT_CHARS;
  let chars = 0;
  let truncated = false;

  const push = (line: string) => {
    if (truncated) return;
    if (chars + line.length > maxChars) {
      truncated = true;
      lines.push('… [snapshot truncated — scroll or use read_page for full text]');
      return;
    }
    lines.push(line);
    chars += line.length + 1;
  };

  const walk = (node: Element, depth: number) => {
    if (truncated) return;
    if (SKIP_TAGS.has(node.tagName)) return;
    if (node.getAttribute('aria-hidden') === 'true') return;
    if (!isVisible(node)) return;
    if (opts.viewportOnly && !inViewport(node) && node.childElementCount === 0) return;

    const indent = '  '.repeat(Math.min(depth, 8));

    if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
      const src = node.getAttribute('src') ?? '';
      push(`${indent}- iframe ${JSON.stringify(src)} (contents not included)`);
      return;
    }

    if (isInteractive(node) && elements.length < MAX_ELEMENTS) {
      const ref = addRef(node);
      const info = describe(node, ref);
      elements.push(info);
      push(formatElementLine(info, indent));
      // Inputs and buttons rarely have meaningful element children worth
      // descending into; links and custom widgets sometimes do.
      if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(node.tagName)) return;
      for (const child of Array.from(node.children)) walk(child, depth + 1);
      return;
    }

    if (/^H[1-6]$/.test(node.tagName)) {
      const t = textOf(node, 200);
      if (t) push(`${indent}${'#'.repeat(Number(node.tagName[1]))} ${t}`);
      return;
    }

    // Leaf-ish block with direct text: emit it once instead of per text node.
    const directText = clean(
      Array.from(node.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join(' '),
    );
    if (directText && BLOCK_TAGS.has(node.tagName)) {
      push(`${indent}${directText.length > 500 ? `${directText.slice(0, 500)}…` : directText}`);
    } else if (directText && node.childElementCount === 0) {
      push(`${indent}${directText}`);
    }

    for (const child of Array.from(node.children)) walk(child, depth + 1);
  };

  const root = document.body ?? document.documentElement;
  if (root) walk(root, 0);

  return {
    url: location.href,
    title: document.title,
    text: lines.join('\n'),
    elements,
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      height: Math.round(document.documentElement.scrollHeight),
      viewportHeight: window.innerHeight,
    },
    truncated,
  };
}

/* --------------------------------------------------------------- actions -- */

function resolve(handle: unknown): Element {
  const ref = parseHandle(handle);
  const entry = refs.get(ref);
  if (!entry) throw new Error(`No element with ref=${handle}. Take a fresh snapshot first.`);
  if (!entry.el.isConnected) {
    throw new Error(`Element ref=${handle} is no longer in the document. Re-snapshot.`);
  }
  // The node survived but is not what it was — a virtualised list recycling its
  // rows, a framework reusing a node, or a link whose destination changed.
  // Acting on it would hit the wrong target while appearing to succeed.
  const now = fingerprintOf(entry.el);
  if (now !== entry.fingerprint) {
    throw new Error(
      `Element ref=${handle} has changed since the snapshot ` +
        `(was ${JSON.stringify(entry.fingerprint)}, now ${JSON.stringify(now)}). Re-snapshot.`,
    );
  }
  return entry.el;
}

/**
 * Resolution plus the checks that decide whether an action can land at all.
 *
 * Every mutating action goes through this, not `resolve`. A previously observed
 * control that has since been hidden is still `isConnected` and still matches
 * its fingerprint, so without this it accepts a click that a user could not
 * have performed.
 */
function resolveActionable(handle: unknown): Element {
  const el = resolve(handle);
  if (!isVisible(el)) throw new Error(`Element ref=${handle} is not visible. Re-snapshot.`);
  if (isDisabled(el)) throw new Error(`Element ref=${handle} is disabled.`);
  return el;
}

function scrollIntoView(el: Element) {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
}

function centerOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function fireMouse(el: Element, type: string, x: number, y: number) {
  el.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'mousedown' ? 1 : 0,
    }),
  );
}

function firePointer(el: Element, type: string, x: number, y: number) {
  if (typeof PointerEvent !== 'function') return;
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }),
  );
}

function clickRef(ref: unknown): string {
  const el = resolveActionable(ref);
  scrollIntoView(el);
  const { x, y } = centerOf(el);

  // Full synthetic sequence: frameworks listen at every stage, and some
  // widgets only commit on pointerup or mouseup rather than click.
  firePointer(el, 'pointerover', x, y);
  fireMouse(el, 'mouseover', x, y);
  firePointer(el, 'pointerdown', x, y);
  fireMouse(el, 'mousedown', x, y);
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
  firePointer(el, 'pointerup', x, y);
  fireMouse(el, 'mouseup', x, y);
  if (el instanceof HTMLElement) el.click();
  else fireMouse(el, 'click', x, y);

  return `Clicked ${implicitRole(el)} ${JSON.stringify(accessibleName(el))}`;
}

/** Sets a value the way React/Vue-controlled inputs will notice. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/**
 * Fields whose contents are secrets.
 *
 * One classifier, shared by every path: what the snapshot shows, what
 * extraction returns, and what the agent may type into. Keeping separate rules
 * per path is how a one-time code stayed visible in snapshots while `fill`
 * refused it.
 */
function isCredentialField(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === 'password') return true;
  const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
  if (/password|one-time-code|cc-number|cc-csc|cc-exp|current-password|new-password/.test(autocomplete)) {
    return true;
  }
  // Sites that label the field but not its autocomplete semantics.
  const hints = `${el.getAttribute('name') ?? ''} ${el.id} ${el.getAttribute('data-testid') ?? ''}`.toLowerCase();
  return /(^|[^a-z])(otp|passcode|passwd|password|cvv|cvc|securitycode)([^a-z]|$)/.test(hints);
}

/**
 * Whether this element, or anything it sits inside, is a credential field.
 *
 * Ancestors matter as much as the element. Three observation paths each checked
 * only one direction and each leaked: `readText("#otp")` passed the field
 * itself as the root, where a descendant sweep never looked; `extract("form",
 * {value: "."})` read an ancestor whose *child* held the code; and the text
 * walker in `findText` reached the text node directly. One predicate, walked
 * upwards, is what all of them needed.
 */
function withinCredentialField(el: Element | null): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (isCredentialField(cur)) return true;
  }
  return false;
}

/**
 * The single boundary every text-reading path goes through: credential
 * subtrees removed, and the whole thing refused if the root is itself one.
 */
function scrubbedText(el: Element): string {
  if (withinCredentialField(el)) return '[redacted]';
  return withHidden(el, [], (root) => (root as HTMLElement).innerText ?? root.textContent ?? '');
}

/**
 * Reads text from the *live* element with sensitive subtrees hidden.
 *
 * Two things went wrong with the obvious implementation, cloning and deleting:
 *
 * The clone was detached, so `innerText` had no layout to consult and fell back
 * to `textContent` — which includes `display:none` content. A button labelled
 * "Visible" with a hidden child read as "VisibleHIDDEN_INSTRUCTION", both
 * damaging the accessible name the model grounds on and handing it unrendered
 * page text.
 *
 * And deletion was driven by `input, textarea, select`, while the credential
 * predicate applies to *any* element. A `contenteditable` div holding a
 * one-time code was redacted when named directly and exposed when its parent
 * was read — the same secret protected or not depending on the selector.
 *
 * So: hide by predicate across the whole subtree, read from the real DOM, and
 * restore. The mutation is synchronous and reversed before returning, so the
 * page cannot observe an intermediate state except through a MutationObserver
 * that sees the change and its undo.
 */
function withHidden<T>(root: Element, extraSelectors: string[], read: (root: Element) => T): T {
  const hidden: { node: HTMLElement; previous: string }[] = [];

  const hide = (node: Element) => {
    if (!(node instanceof HTMLElement)) return;
    hidden.push({ node, previous: node.style.display });
    node.style.display = 'none';
  };

  for (const node of root.querySelectorAll('*')) {
    if (isCredentialField(node)) hide(node);
  }
  for (const selector of extraSelectors) {
    for (const node of root.querySelectorAll(selector)) hide(node);
  }

  try {
    return read(root);
  } finally {
    for (const { node, previous } of hidden) node.style.display = previous;
  }
}

function fillRef(ref: unknown, text: string, submit: boolean): string {
  const el = resolveActionable(ref);
  if (isCredentialField(el)) {
    throw new Error(
      `Element ref=${ref} is a password or one-time-code field. The assistant does ` +
        'not enter credentials — the user should type this, or use saved passwords.',
    );
  }
  scrollIntoView(el);
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setNativeValue(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setNativeValue(el, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if ((el as HTMLElement).isContentEditable) {
    (el as HTMLElement).innerText = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  } else {
    throw new Error(`Element ref=${ref} (${el.tagName.toLowerCase()}) is not a text field.`);
  }

  if (submit) {
    const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    const form = (el as HTMLInputElement).form;
    // Only fall back to form.submit() when nothing intercepted the Enter key.
    if (form && !form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) {
      // A listener called preventDefault: the app is handling it.
    } else if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    }
  }
  // The value is not echoed: a result is transcript, and a field that turns out
  // to hold something sensitive should not be repeated back into one.
  return `Filled ${JSON.stringify(accessibleName(el))} (${text.length} characters)${submit ? ' and submitted' : ''}`;
}

function selectRef(ref: unknown, values: string[]): string {
  const el = resolveActionable(ref);
  if (!(el instanceof HTMLSelectElement)) throw new Error(`Element ref=${ref} is not a <select>.`);
  const wanted = new Set(values.map((v) => v.toLowerCase()));
  let matched = 0;
  for (const opt of Array.from(el.options)) {
    const hit = wanted.has(opt.value.toLowerCase()) || wanted.has(clean(opt.text).toLowerCase());
    opt.selected = hit;
    if (hit) matched++;
  }
  if (!matched) {
    const available = Array.from(el.options).map((o) => o.text).slice(0, 20);
    throw new Error(`No option matched ${JSON.stringify(values)}. Available: ${JSON.stringify(available)}`);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return `Selected ${values.join(', ')}`;
}

function setCheckedRef(ref: unknown, checked: boolean): string {
  const el = resolveActionable(ref);
  if (!(el instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(el.type)) {
    // ARIA widgets: toggling means clicking.
    if (el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch') {
      if ((el.getAttribute('aria-checked') === 'true') !== checked) return clickRef(ref);
      return 'Already in the requested state';
    }
    throw new Error(`Element ref=${ref} is not a checkbox or radio.`);
  }
  if (el.checked !== checked) {
    el.click();
  }
  return `${checked ? 'Checked' : 'Unchecked'} ${JSON.stringify(accessibleName(el))}`;
}

function hoverRef(ref: unknown): string {
  const el = resolveActionable(ref);
  scrollIntoView(el);
  const { x, y } = centerOf(el);
  firePointer(el, 'pointerover', x, y);
  fireMouse(el, 'mouseover', x, y);
  fireMouse(el, 'mousemove', x, y);
  return `Hovered ${JSON.stringify(accessibleName(el))}`;
}

function scrollPage(
  direction: 'up' | 'down' | 'top' | 'bottom',
  amount?: number,
  ref?: number,
): string {
  const target: Element | Window = ref !== undefined ? resolve(ref) : window;
  const px = amount ?? Math.round(window.innerHeight * 0.85);
  if (target === window) {
    switch (direction) {
      case 'top':
        window.scrollTo({ top: 0 });
        break;
      case 'bottom':
        window.scrollTo({ top: document.documentElement.scrollHeight });
        break;
      case 'up':
        window.scrollBy({ top: -px });
        break;
      default:
        window.scrollBy({ top: px });
    }
    return `Scrolled ${direction}. Now at y=${Math.round(window.scrollY)} of ${document.documentElement.scrollHeight}`;
  }
  const el = target as Element;
  if (direction === 'top') el.scrollTop = 0;
  else if (direction === 'bottom') el.scrollTop = el.scrollHeight;
  else el.scrollTop += direction === 'up' ? -px : px;
  return `Scrolled element ${direction}`;
}

/** Full readable text of the page (or a CSS-selected subtree). */
function readText(selector?: string, maxChars = 60_000): { text: string; truncated: boolean } {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) throw new Error(`No element matches selector ${JSON.stringify(selector)}`);

  // Prefer semantic containers so we skip chrome/nav boilerplate when present.
  let target: Element = root;
  if (!selector) {
    const main = document.querySelector('main, article, [role="main"]');
    if (main && clean((main as HTMLElement).innerText).length > 200) target = main;
  }

  // The selector can name the credential field itself, which a sweep over
  // descendants never sees. scrubbedText refuses that root outright.
  if (withinCredentialField(target)) {
    return { text: '[redacted]', truncated: false };
  }

  // Read from the live tree with credential subtrees and aria-hidden content
  // hidden. `innerText` already excludes script, style and noscript, because
  // they are not rendered — the clone needed to delete them only because it had
  // no layout to consult.
  const raw = withHidden(target, ['[aria-hidden="true"]'], (root) =>
    (root as HTMLElement).innerText ?? root.textContent ?? '',
  );
  const text = raw
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

function findText(query: string, limit = 20): { ref: string | null; context: string }[] {
  const q = query.toLowerCase();
  const out: { ref: string | null; context: string }[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode()) && out.length < limit) {
    const t = node.textContent ?? '';
    const idx = t.toLowerCase().indexOf(q);
    if (idx === -1) continue;
    const parent = node.parentElement;
    if (!parent || !isVisible(parent)) continue;
    // The walker reaches a credential field's own text node directly, which is
    // how searching for the code returned it.
    if (withinCredentialField(parent)) continue;
    const start = Math.max(0, idx - 60);
    const context = clean(t.slice(start, idx + q.length + 60));
    // Attach the nearest interactive ancestor so the model can act on the hit.
    let ref: string | null = null;
    let cur: Element | null = parent;
    while (cur && ref === null) {
      ref = refIdFor(cur);
      cur = cur.parentElement;
    }
    out.push({ ref, context });
  }
  return out;
}

/**
 * Whether reading this attribute off this node would disclose a secret.
 *
 * Snapshots omit password values, but structured extraction can name any
 * attribute — `input@value` against a password field walked straight around
 * that. Redaction has to hold on every path out of the page, not just the one
 * that was thought of first.
 */
function isSecretRead(node: Element | null, attr: string): boolean {
  if (!node) return false;
  // HTML attribute lookup is case-insensitive, so the guard must be too:
  // `@value` was redacted while `@VALUE` returned the password.
  const name = attr.toLowerCase();
  if (name !== 'value' && name !== 'defaultvalue') return false;
  return isCredentialField(node);
}

function extract(selector: string, fields: Record<string, string>): Record<string, string>[] {
  const rows = Array.from(document.querySelectorAll(selector));
  return rows.slice(0, 200).map((row) => {
    const rec: Record<string, string> = {};
    for (const [key, sel] of Object.entries(fields)) {
      if (sel === '.' || sel === 'self') {
        rec[key] = textOf(row, 400);
        continue;
      }
      const attrMatch = /^(.*)@([\w-]+)$/.exec(sel);
      if (attrMatch) {
        const [, css, attr] = attrMatch;
        const node = css ? row.querySelector(css) : row;
        rec[key] = isSecretRead(node, attr) ? '[redacted]' : (node?.getAttribute(attr) ?? '');
      } else {
        const node = row.querySelector(sel);
        rec[key] = node ? textOf(node, 400) : '';
      }
    }
    return rec;
  });
}

/* ------------------------------------------------------------- highlight -- */

const HIGHLIGHT_ID = '__nabsun_highlight_layer__';

function highlight(refList: unknown[], durationMs = 1400) {
  let layer = document.getElementById(HIGHLIGHT_ID);
  if (!layer) {
    layer = document.createElement('div');
    layer.id = HIGHLIGHT_ID;
    Object.assign(layer.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483647',
    } as CSSStyleDeclaration);
    document.documentElement.appendChild(layer);
  }
  layer.textContent = '';
  for (const ref of refList) {
    let el: Element | undefined;
    try {
      el = refs.get(parseHandle(ref))?.el;
    } catch {
      continue; // Highlighting is cosmetic; a bad handle fails at the action.
    }
    if (!el || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'absolute',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      border: '2px solid #ff5b2c',
      borderRadius: '4px',
      boxShadow: '0 0 0 3px rgba(255,91,44,.25)',
      transition: 'opacity .3s',
    } as CSSStyleDeclaration);
    layer.appendChild(box);
  }
  const el = layer;
  window.setTimeout(() => {
    el.style.opacity = '0';
    window.setTimeout(() => el.remove(), 300);
  }, durationMs);
}

/* ----------------------------------------------------------------- ready -- */

/** Heuristic "page settled" signal used after navigations and clicks. */
function readyState(): { ready: boolean; state: string; pendingImages: number } {
  const imgs = Array.from(document.images).filter((i) => !i.complete).length;
  return {
    ready: document.readyState === 'complete' && imgs === 0,
    state: document.readyState,
    pendingImages: imgs,
  };
}

const api = {
  version: 1,
  snapshot: (opts?: SnapshotOptions) => buildSnapshot(opts),
  click: clickRef,
  fill: fillRef,
  select: selectRef,
  setChecked: setCheckedRef,
  hover: hoverRef,
  scroll: scrollPage,
  readText,
  findText,
  extract,
  highlight,
  readyState,
  refCount: () => currentRefs.length,
};

declare global {
  interface Window {
    __nabsunAgent?: typeof api;
  }
}

window.__nabsunAgent = api;

export type AgentBridge = typeof api;
export {};
