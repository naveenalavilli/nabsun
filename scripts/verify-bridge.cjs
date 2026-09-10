/**
 * End-to-end check of the page bridge, run under a real Electron renderer.
 *
 *   node_modules/electron/dist/electron.exe scripts/verify-bridge.cjs
 *
 * This exercises the part of the system with the least margin for error: the
 * snapshot must find the right elements with the right names, and the actions
 * must actually drive a page that only trusts real input events.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const WORLD = 1729;
const root = path.dirname(__dirname);
const bridge = fs.readFileSync(path.join(root, 'dist', 'page', 'agent-bridge.js'), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}

async function evalInPage(wc, expression) {
  const wrapped = `(() => { try { return { ok: true, value: ${expression} }; }
    catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; } })()`;
  const res = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: wrapped }], true);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

/** Refs are opaque strings, so they must be quoted into any expression. */
const q = (ref) => JSON.stringify(String(ref));

/** Runs an expression that is expected to throw, returning the message. */
async function tryInPage(wc, expression) {
  const code = `(() => { try { return String(${expression}); }
    catch (e) { return e && e.message ? e.message : String(e); } })()`;
  return wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], true);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const wc = win.webContents;

  try {
    await wc.loadFile(path.join(root, 'scripts', 'fixtures', 'form.html'));
    await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: bridge }]);

    const snap = await evalInPage(wc, 'window.__nabsunAgent.snapshot({})');

    check('snapshot returns a title and url', snap.title === 'Bridge Fixture' && snap.url.endsWith('form.html'));

    const byName = (n) => snap.elements.find((e) => e.name === n);
    const email = byName('Email address');
    check('labelled input is found with its accessible name', Boolean(email), JSON.stringify(snap.elements.map((e) => e.name)));
    check('input role is textbox', email && email.role === 'textbox', email && email.role);
    check('placeholder is captured', email && email.placeholder === 'you@example.com');

    const submit = byName('Create account');
    check('button is found by its text', Boolean(submit));

    const icon = byName('Dismiss notice');
    check('icon-only button is named from aria-label', Boolean(icon));

    const link = snap.elements.find((e) => e.role === 'link');
    check('link exposes an href', Boolean(link && link.href));

    check(
      'display:none subtree is excluded',
      !snap.elements.some((e) => e.name === 'Should never appear in a snapshot'),
    );

    check('outline carries opaque [ref=…] handles', /\[ref=[a-z0-9]+-\d+\]/.test(snap.text), snap.text.slice(0, 200));

    // --- actions -----------------------------------------------------------
    const checkboxEl = snap.elements.find((e) => e.role === 'checkbox');
    const planEl = snap.elements.find((e) => e.tag === 'select');

    await evalInPage(wc, `window.__nabsunAgent.fill(${q(email.ref)}, "agent@example.com", false)`);
    await evalInPage(wc, `window.__nabsunAgent.setChecked(${q(checkboxEl.ref)}, true)`);
    await evalInPage(wc, `window.__nabsunAgent.select(${q(planEl.ref)}, ["Pro"])`);
    await evalInPage(wc, `window.__nabsunAgent.click(${q(submit.ref)})`);

    const result = await evalInPage(wc, 'document.getElementById("result").textContent');
    check(
      'fill reaches a controlled input, and click/select/check all commit',
      result === 'submitted:agent@example.com|agree=true|plan=pro',
      `got: ${JSON.stringify(result)}`,
    );

    // --- reading / extraction ----------------------------------------------
    const text = await evalInPage(wc, 'window.__nabsunAgent.readText()');
    check('readText returns prose', text.text.includes('Sign in'));

    const found = await evalInPage(wc, 'window.__nabsunAgent.findText("pricing")');
    check('findText locates a string', found.length > 0, JSON.stringify(found));

    const rows = await evalInPage(
      wc,
      'window.__nabsunAgent.extract("li.row", { title: "h3", href: "a@href" })',
    );
    check(
      'extract pulls structured rows',
      rows.length === 2 && rows[0].title === 'Alpha' && rows[1].href.endsWith('/b'),
      JSON.stringify(rows),
    );

    // Well-formed, from this document, but never issued: the "unknown handle"
    // case, distinct from the malformed one covered further down.
    const unknown = `${String(email.ref).split('-')[0]}-9999`;
    const stale = await tryInPage(wc, `window.__nabsunAgent.click(${q(unknown)})`);
    check('an unknown handle fails loudly', /No element with ref/.test(stale), stale);

    // --- handle reuse and credential fields --------------------------------
    // A ref that survives into a changed page must not silently mean something
    // else. Index-based handles did exactly that: after the page reordered, an
    // old ref resolved to whatever now sat in that slot and clicked it.
    await wc.loadFile(path.join(root, 'scripts', 'fixtures', 'shifting.html'));
    await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: bridge }]);

    const first = await evalInPage(wc, 'window.__nabsunAgent.snapshot({})');
    const safeRef = first.elements.find((e) => e.name === 'Save draft').ref;

    // Done through the DOM: the isolated world shares the document with the
    // page but not its globals, so the fixture's own helper is not visible.
    await evalInPage(
      wc,
      '(() => { const b = document.getElementById("actions");' +
        ' b.insertBefore(document.getElementById("destructive"), document.getElementById("safe"));' +
        ' return "reordered"; })()',
    );
    const second = await evalInPage(wc, 'window.__nabsunAgent.snapshot({})');

    check(
      'a re-snapshot never reissues a handle to a different element',
      !second.elements.some((e) => e.ref === safeRef && e.name !== 'Save draft'),
      JSON.stringify(second.elements.map((e) => ({ ref: e.ref, name: e.name }))),
    );

    const reused = await tryInPage(wc, `window.__nabsunAgent.click(${q(safeRef)})`);
    const clicked = await evalInPage(wc, 'document.getElementById("clicked").textContent');
    check(
      'an old handle never actuates the element that replaced it',
      clicked !== 'destructive',
      `clicked: ${clicked} (call returned: ${reused})`,
    );

    // Credentials: the agent must not type them, and must not read them back
    // out through structured extraction either.
    const pwRef = second.elements.find((e) => e.name === 'Password').ref;
    const pwFill = await tryInPage(wc, `window.__nabsunAgent.fill(${q(pwRef)}, "s3cret", false)`);
    check('fill refuses a password field', /does not enter credentials/.test(pwFill), pwFill);

    const otpRef = second.elements.find((e) => e.name === 'One-time code').ref;
    const otpFill = await tryInPage(wc, `window.__nabsunAgent.fill(${q(otpRef)}, "999999", false)`);
    check('fill refuses a one-time-code field', /does not enter credentials/.test(otpFill), otpFill);

    const secrets = await evalInPage(
      wc,
      'window.__nabsunAgent.extract("#login", { pw: "#pw@value", otp: "#otp@value", user: "#user@value" })',
    );
    check(
      'extract redacts password and one-time-code values',
      secrets[0].pw === '[redacted]' && secrets[0].otp === '[redacted]',
      JSON.stringify(secrets),
    );

    const userRef = second.elements.find((e) => e.name === 'Username').ref;
    const echo = await evalInPage(wc, `window.__nabsunAgent.fill(${q(userRef)}, "topsecret", false)`);
    check(
      'a fill result reports the length, not the value',
      !String(echo).includes('topsecret'),
      String(echo),
    );

    check(
      'password values stay out of the snapshot',
      !JSON.stringify(second).includes('hunter2-from-attribute'),
    );

    // HTML attribute lookup is case-insensitive; the redaction guard was not,
    // so `@VALUE` returned what `@value` refused.
    const upper = await evalInPage(
      wc,
      'window.__nabsunAgent.extract("#login", { pw: "#pw@VALUE", otp: "#otp@Value" })',
    );
    check(
      'redaction is case-insensitive on the attribute name',
      upper[0].pw === '[redacted]' && upper[0].otp === '[redacted]',
      JSON.stringify(upper),
    );

    // A one-time code lives in a plain text input, so excluding only
    // type=password left it fully visible in the ordinary snapshot.
    check(
      'a populated one-time-code value stays out of the snapshot',
      !JSON.stringify(second).includes('123456'),
      JSON.stringify(second.elements.filter((e) => /code/i.test(e.name))),
    );

    // A credential is a credential whatever element holds it. Gating the input
    // branch while the textarea branch copied its value unconditionally left
    // this one fully visible.
    check(
      'a credential textarea stays out of the snapshot',
      !JSON.stringify(second).includes('FAKE_TEXTAREA_CODE'),
      JSON.stringify(second.elements.filter((e) => e.tag === 'textarea')),
    );

    const fullText = await evalInPage(wc, 'window.__nabsunAgent.readText()');
    check(
      'and out of the full-text read of the page',
      !fullText.text.includes('FAKE_TEXTAREA_CODE'),
      fullText.text.slice(0, 200),
    );

    const asText = await evalInPage(
      wc,
      'window.__nabsunAgent.extract("#login", { recovery: "#recovery" })',
    );
    check(
      'and out of text extraction that names it directly',
      asText[0].recovery === '[redacted]',
      JSON.stringify(asText),
    );

    // Three more ways to the same string, each of which the per-field checks
    // above pass while still leaking. The field-value gate looked *down* from a
    // root; these come at it from the root itself, from an ancestor, and from
    // the text walker.
    const rootRead = await evalInPage(wc, 'window.__nabsunAgent.readText("#recovery")');
    check(
      'reading the credential field as the selected root is refused',
      !rootRead.text.includes('FAKE_TEXTAREA_CODE'),
      JSON.stringify(rootRead).slice(0, 200),
    );

    const viaAncestor = await evalInPage(
      wc,
      'window.__nabsunAgent.extract("#login", { all: "." })',
    );
    check(
      'extracting an ancestor does not carry the credential up with it',
      !JSON.stringify(viaAncestor).includes('FAKE_TEXTAREA_CODE'),
      JSON.stringify(viaAncestor).slice(0, 200),
    );

    const searched = await evalInPage(wc, 'window.__nabsunAgent.findText("FAKE_TEXTAREA_CODE")');
    check(
      'and searching the page for it finds nothing to show',
      !JSON.stringify(searched).includes('FAKE_TEXTAREA_CODE'),
      JSON.stringify(searched).slice(0, 200),
    );

    // The same three routes to the ordinary one-time-code input.
    const otpRoot = await evalInPage(wc, 'window.__nabsunAgent.readText("#otp")');
    check(
      'the one-time-code input is refused as a read root too',
      !otpRoot.text.includes('123456'),
      JSON.stringify(otpRoot).slice(0, 200),
    );

    // A credential is not always an <input>. The scrubber removed only
    // input/textarea/select descendants, so a contenteditable div holding a
    // code was redacted when named directly and exposed through its parent —
    // the same secret protected or not depending on the selector used.
    await evalInPage(
      wc,
      `(() => {
         const wrap = document.createElement('div');
         wrap.id = 'rich-wrap';
         wrap.innerHTML = '<div id="rich-otp" autocomplete="one-time-code" contenteditable="true">FAKE_RICH_CODE</div>';
         document.body.appendChild(wrap);
         return true;
       })()`,
    );
    for (const [label, expression] of [
      ['named directly', 'window.__nabsunAgent.readText("#rich-otp").text'],
      ['read through its parent', 'window.__nabsunAgent.readText("#rich-wrap").text'],
      ['extracted from its parent', 'JSON.stringify(window.__nabsunAgent.extract("#rich-wrap", { t: "." }))'],
      ['searched for', 'JSON.stringify(window.__nabsunAgent.findText("FAKE_RICH_CODE"))'],
    ]) {
      const got = String(await evalInPage(wc, expression));
      check(
        `a contenteditable credential stays hidden when ${label}`,
        !got.includes('FAKE_RICH_CODE'),
        got.slice(0, 160),
      );
    }

    // Hidden text must not be folded into a visible control's name. Reading a
    // detached clone lost `innerText`'s rendering semantics and fell back to
    // `textContent`, which includes `display:none` children.
    await evalInPage(
      wc,
      `(() => {
         const b = document.createElement('button');
         b.id = 'mixed';
         b.innerHTML = 'Visible<span style="display:none">HIDDEN_INSTRUCTION</span>';
         document.body.appendChild(b);
         return true;
       })()`,
    );
    const mixed = String(await evalInPage(wc, 'window.__nabsunAgent.readText("#mixed").text'));
    check(
      'hidden text is not folded into visible text',
      mixed.includes('Visible') && !mixed.includes('HIDDEN_INSTRUCTION'),
      JSON.stringify(mixed),
    );

    // ...while a deliberately hidden aria-labelledby target is a *legitimate*
    // accessible name and must survive.
    await evalInPage(
      wc,
      `(() => {
         const host = document.createElement('div');
         host.innerHTML =
           '<span id="lbl" style="display:none">Close dialog</span>' +
           '<button id="labelled" aria-labelledby="lbl"></button>';
         document.body.appendChild(host);
         return true;
       })()`,
    );
    const labelled = await evalInPage(wc, 'window.__nabsunAgent.snapshot({})');
    check(
      'a hidden aria-labelledby target still names its control',
      JSON.stringify(labelled).includes('Close dialog'),
      JSON.stringify(labelled.elements?.slice(-3) ?? []).slice(0, 200),
    );

    // A control that has since been hidden is still connected and still matches
    // its fingerprint. Only an actionability check refuses it.
    const hidden = second.elements.find((e) => e.name === 'Delete everything');
    await evalInPage(
      wc,
      '(() => { document.getElementById("destructive").style.display = "none"; return "hidden"; })()',
    );
    const hiddenClick = await tryInPage(wc, `window.__nabsunAgent.click(${q(hidden.ref)})`);
    const afterHidden = await evalInPage(wc, 'document.getElementById("clicked").textContent');
    check(
      'clicking a now-hidden control is refused',
      /not visible/.test(hiddenClick) && afterHidden !== 'destructive',
      `${hiddenClick} · clicked=${afterHidden}`,
    );

    // The bridge is re-injected per document, which reset the id counter — so a
    // handle from the previous page collided with a fresh one on the next.
    const beforeNav = second.elements.find((e) => e.name === 'Username').ref;
    await wc.loadFile(path.join(root, 'scripts', 'fixtures', 'form.html'));
    await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: bridge }]);
    await evalInPage(wc, 'window.__nabsunAgent.snapshot({})');

    const crossDoc = await tryInPage(wc, `window.__nabsunAgent.click(${q(beforeNav)})`);
    const navResult = await evalInPage(wc, 'document.getElementById("result").textContent');
    check(
      'a handle from a previous document is refused after navigation',
      /navigated away|No element with ref/.test(crossDoc),
      crossDoc,
    );
    check('and it actuates nothing on the new page', navResult === '', JSON.stringify(navResult));

    // The hole under the qualification: a bare number skipped the document
    // check entirely, so click("0") hit the new page's first control while the
    // properly qualified handle was refused.
    for (const bare of ['0', '"0"', '3', 'null', '""', '"abc"', '"deadbeef-0"']) {
      const attempt = await tryInPage(wc, `window.__nabsunAgent.click(${bare})`);
      const after = await evalInPage(wc, 'document.getElementById("result").textContent');
      check(
        `an unqualified ref ${bare} is refused`,
        /Malformed ref|navigated away|No element with ref/.test(attempt) && after === '',
        `${attempt} · #result=${JSON.stringify(after)}`,
      );
    }

    // The positive control: a current, well-formed handle still works, so the
    // checks above are not passing merely because everything is refused.
    const live = await evalInPage(wc, 'window.__nabsunAgent.snapshot({})');
    const liveButton = live.elements.find((e) => e.name === 'Create account');
    await evalInPage(wc, `window.__nabsunAgent.click(${q(liveButton.ref)})`);
    const liveResult = await evalInPage(wc, 'document.getElementById("result").textContent');
    check(
      'a current handle from this document still actuates',
      liveResult.startsWith('submitted:'),
      JSON.stringify(liveResult),
    );

    // Two controls sharing a label, and a link whose destination changed, must
    // not pass as the same element.
    const linkSnap = await evalInPage(wc, 'window.__nabsunAgent.snapshot({})');
    const pricing = linkSnap.elements.find((e) => e.role === 'link');
    await evalInPage(
      wc,
      '(() => { document.querySelector("a[href]").setAttribute("href", "/evil"); return "swapped"; })()',
    );
    const swapped = await tryInPage(wc, `window.__nabsunAgent.click(${q(pricing.ref)})`);
    check(
      'a link whose destination changed fails identity, rather than being followed',
      /has changed since the snapshot/.test(swapped),
      swapped,
    );
  } catch (err) {
    check('harness completed', false, err && err.stack ? err.stack : String(err));
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  app.exit(failures ? 1 : 0);
});
