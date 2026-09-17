/**
 * Exercises the browser as a *browser*: real navigation over HTTP, history,
 * error pages, zoom, tab cycling, reopening a closed tab, session restore and
 * downloads — all against a throwaway local server so the run is deterministic
 * and works offline.
 *
 *   node_modules/electron/dist/electron.exe dist/test/browsing-harness.js
 */
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseWindow, BrowserWindow, app, ipcMain, protocol, session } from 'electron';
import { DownloadManager } from '../main/downloads';
import { ChromeExtensionManager } from '../main/integrations/extensions';
import { HistoryStore } from '../main/history';
import { registerInternalProtocol } from '../main/internalPages';
import { handleCommand, suggestedFileName, type IpcDeps } from '../main/ipc';
import { PasswordStore } from '../main/passwords';
import { MIGRATION_MARKER, migrateProfile, rewriteInternalUrl } from '../main/rebrand';
import { applyPermissionPolicy } from '../main/security';
import { SettingsStore } from '../main/store';
import { TabManager, delay } from '../main/tabs';

// The app disables these too: in a browser they report on the websites the
// user visits, not on the application, so they bury the harness output.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// Must match the real app: without this `nabsun://` is an opaque scheme, and
// `getURL()` on those pages comes back empty.
protocol.registerSchemesAsPrivileged([
  { scheme: 'nabsun', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures++;
}

/** Waits for a condition, so tests never depend on a fixed sleep. */
async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  return false;
}

function startServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    // Close each socket: Chromium allows only six connections per host, and
    // lingering keep-alive sockets from closed tabs would stall later loads.
    res.setHeader('Connection', 'close');
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Home Page</title><h1>Home</h1><a id="next" href="/page2">Go to page two</a>');
    } else if (req.url === '/page2') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Page Two</title><h1>Second page</h1>');
    } else if (req.url === '/self-closing') {
      // What an expired session does at the end of an SSO or logout flow.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<title>Session over</title><h1>Signed out</h1>
         <script>setTimeout(() => window.close(), 50);</script>`,
      );
    } else if (req.url === '/login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<title>Sign in</title><h1>Sign in</h1>
         <form id="f" action="/done" method="get">
           <label for="email">Email</label>
           <input id="email" name="email" type="text" />
           <input id="pw" name="password" type="password" />
           <button type="submit">Log in</button>
         </form>`,
      );
    } else if (req.url === '/file.txt') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="notes.txt"',
        'content-length': '11',
      });
      res.end('hello world');
    } else {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<title>Missing</title>not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-browse-'));
  app.setPath('userData', tmp);
  // Keep downloads out of the real Downloads folder.
  const downloadDir = path.join(tmp, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });
  app.setPath('downloads', downloadDir);

  const { server, origin } = await startServer();
  const history = new HistoryStore();
  const downloads = new DownloadManager();

  const ses = session.fromPartition('persist:browse-harness');
  // Populated, and hostile. The old fixture was `[]`, which has no quotes to
  // corrupt — so HTML-escaping the JSON inside a <script> block went unnoticed
  // while it broke every real history page.
  const historyFixture = JSON.stringify([
    {
      url: 'http://example.com/a?x=1&y=2',
      title: 'A "quoted" & <tagged> title </script><b>x</b>',
      visitedAt: Date.now(),
    },
    { url: 'http://example.com/b', title: 'Second entry', visitedAt: Date.now() },
  ]);
  registerInternalProtocol(
    ses,
    // THEME is what the shipped app substitutes; without it the attribute
    // would keep its literal placeholder and the theme check below would be
    // testing a state no user ever sees.
    () => ({ HISTORY_JSON: historyFixture, TOP_SITES_JSON: '[]', THEME: 'light' }),
    path.join(__dirname, '..', 'pages'),
  );
  downloads.attach(ses);
  // The same policy the real app applies, so this harness tests what ships.
  applyPermissionPolicy(ses);

  const window = new BaseWindow({ show: false, width: 1200, height: 800 });
  const tabs = new TabManager({
    window,
    preloadPath: path.join(__dirname, '..', 'preload', 'page.js'),
    partition: 'persist:browse-harness',
    history,
    homepage: `${origin}/`,
    onFindResult: () => {},
  });
  tabs.setBounds({ x: 0, y: 0, width: 1200, height: 800 });

  try {
    /* ------------------------------------------------------- navigation -- */

    const tab = tabs.create(`${origin}/`);
    await until(() => tab.wc.getTitle() === 'Home Page');
    check('a page loads over HTTP', tab.wc.getTitle() === 'Home Page', tab.wc.getTitle());

    /* ------------------------------------------------- site permissions -- */
    // Capabilities are denied by default. The old handler named six permissions
    // to refuse and granted everything else, so a page could take the camera
    // and microphone without anyone being asked.
    const camera = await tab.wc.executeJavaScript(
      `navigator.mediaDevices.getUserMedia({ video: true })
         .then(() => 'granted').catch((e) => 'denied:' + e.name)`,
    );
    check('an unrequested camera grab is denied', String(camera).startsWith('denied'), String(camera));

    const microphone = await tab.wc.executeJavaScript(
      `navigator.mediaDevices.getUserMedia({ audio: true })
         .then(() => 'granted').catch((e) => 'denied:' + e.name)`,
    );
    check('an unrequested microphone grab is denied', String(microphone).startsWith('denied'), String(microphone));

    // Weaker than it looks: geolocation also fails without a location provider
    // configured, so this passes under a permissive policy too. Kept as an
    // outcome check, not counted as evidence that the policy works — camera and
    // microphone above are the ones that discriminate.
    const geo = await tab.wc.executeJavaScript(
      `new Promise((res) => navigator.geolocation.getCurrentPosition(
         () => res('granted'), (e) => res('denied:' + e.code)))`,
    );
    check('geolocation is denied', String(geo).startsWith('denied'), String(geo));

    // permissions.query() must agree with the request handler, or a page is
    // told it holds a capability the browser will actually refuse.
    const queried = await tab.wc.executeJavaScript(
      `navigator.permissions.query({ name: 'camera' })
         .then((s) => s.state).catch((e) => 'error:' + e.name)`,
    );
    check('permissions.query reports the camera as denied', queried === 'denied', String(queried));

    tabs.navigate(tab.id, `${origin}/page2`);
    await until(() => tab.wc.getURL().endsWith('/page2') && !tab.wc.isLoading());
    check('navigating to another page works', tab.wc.getTitle() === 'Page Two', tab.wc.getTitle());

    check('back becomes available', tab.wc.navigationHistory.canGoBack());
    tab.wc.navigationHistory.goBack();
    await until(() => tab.wc.getURL().endsWith('/') && !tab.wc.isLoading());
    check('back returns to the previous page', tab.wc.getTitle() === 'Home Page', tab.wc.getTitle());

    check('forward becomes available', tab.wc.navigationHistory.canGoForward());
    tab.wc.navigationHistory.goForward();
    await until(() => tab.wc.getURL().endsWith('/page2'));
    check('forward returns to the later page', tab.wc.getURL().endsWith('/page2'));

    /* ------------------------------------------- background tabs load -- */

    // Ctrl+clicking a link, or the agent researching quietly, both depend on a
    // tab that is never shown still loading to completion.
    const bg = tabs.create(`${origin}/page2`, { background: true });
    const bgLoaded = await until(() => bg.wc.getTitle() === 'Page Two' && !bg.wc.isLoading(), 20_000);
    check(
      'a background tab loads without being shown',
      bgLoaded,
      `loading=${bg.wc.isLoading()} url=${JSON.stringify(bg.wc.getURL())}`,
    );
    tabs.close(bg.id);

    /* ------------------------------------------ a page that closes itself -- */

    // A page ending its own webContents used to leave the Tab in the list with
    // `view.webContents` undefined. The next coalesced update walked it and
    // threw "Cannot read properties of undefined (reading 'getURL')" out of a
    // getter, in the main process, which Electron shows as a fatal dialog.
    const tabCountBefore = tabs.all.length;
    const selfClosing = tabs.create(`${origin}/self-closing`);
    const selfClosingId = selfClosing.id;
    const wentAway = await until(() => !tabs.all.some((t) => t.id === selfClosingId), 15_000);
    check('a page that calls window.close() removes its own tab', wentAway, `tabs=${tabs.all.length}`);

    // The crash was in the getter the shell reads on every update, so read it.
    let statesThrew: string | null = null;
    try {
      void tabs.states;
      // Give the coalesced update the 16ms it waits for, then read again: the
      // original failure happened on that timer, not on the close itself.
      await new Promise((r) => setTimeout(r, 80));
      void tabs.states;
    } catch (err: unknown) {
      statesThrew = err instanceof Error ? err.message : String(err);
    }
    check('reading tab state after it survives the close', statesThrew === null, String(statesThrew));
    check('the tab list is back to where it started', tabs.all.length === tabCountBefore, `${tabs.all.length} vs ${tabCountBefore}`);

    /* ---------------------------------------------------------- history -- */

    const recorded = history.search('', 20);
    check(
      'visits are recorded in history',
      recorded.some((h) => h.url.endsWith('/page2')) && recorded.some((h) => h.title === 'Home Page'),
      JSON.stringify(recorded.map((h) => `${h.title}|${h.url}`)),
    );

    /* ------------------------------------------------------ error pages -- */

    const badUrl = 'http://this-host-does-not-exist.invalid/';
    const errTab = tabs.create(badUrl);
    const readBody = () =>
      errTab.wc.executeJavaScript('document.body.innerText').catch(() => '') as Promise<string>;

    let errText = '';
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      errText = await readBody();
      if (/Try again/.test(errText)) break;
      await delay(200);
    }

    // The address bar must still show what the user asked for.
    check(
      'a failed navigation keeps the failed URL in the address bar',
      errTab.state.url === badUrl,
      `state.url=${JSON.stringify(errTab.state.url)}`,
    );
    check('the tab records the failure', Boolean(errTab.error), String(errTab.error));
    check(
      'the error page explains the failure in plain language',
      // "Try again" is ours; Chromium's built-in page says "Reload", so this
      // cannot pass against the default error page.
      /Try again/.test(String(errText)) && /can't be found/i.test(String(errText)),
      String(errText).replace(/\s+/g, ' ').slice(0, 200),
    );
    tabs.close(errTab.id);

    /* ------------------------------------------------------- the rebrand -- */
    // A rename that loses the profile is data loss with a new icon, and the
    // former scheme is written into bookmarks, history and restored sessions.

    const oldProfile = path.join(tmp, 'rebrand-appdata', 'SmartBrowser');
    fs.mkdirSync(path.join(oldProfile, 'Partitions', 'smartbrowser'), { recursive: true });
    fs.writeFileSync(path.join(oldProfile, 'passwords.json'), '{"logins":[{"id":"kept"}]}', 'utf8');
    fs.writeFileSync(path.join(oldProfile, 'Partitions', 'smartbrowser', 'Cookies'), 'x', 'utf8');
    const newProfile = path.join(tmp, 'rebrand-appdata', 'Nabsun');

    const moved = migrateProfile(path.join(tmp, 'rebrand-appdata'), newProfile);
    check('an existing profile is carried over, not abandoned', moved !== null, String(moved));
    check(
      'saved passwords survive the rename',
      fs.existsSync(path.join(newProfile, 'passwords.json')),
      newProfile,
    );
    check(
      'and the session partition moves with it, so logins are not lost',
      fs.existsSync(path.join(newProfile, 'Partitions', 'nabsun', 'Cookies')),
      fs.readdirSync(path.join(newProfile, 'Partitions')).join(','),
    );

    // Running again must not clobber a profile the user has since built up.
    fs.mkdirSync(path.join(tmp, 'rebrand-appdata', 'SmartBrowser'), { recursive: true });
    fs.writeFileSync(path.join(newProfile, 'passwords.json'), '{"logins":[{"id":"newer"}]}', 'utf8');
    migrateProfile(path.join(tmp, 'rebrand-appdata'), newProfile);
    check(
      'a second run leaves the current profile alone',
      fs.readFileSync(path.join(newProfile, 'passwords.json'), 'utf8').includes('newer'),
      fs.readFileSync(path.join(newProfile, 'passwords.json'), 'utf8'),
    );

    /*
     * The lifecycle case, which is the one that actually shipped broken.
     *
     * Electron creates `userData` as an empty directory while it starts up, so
     * on a real upgrade the destination always exists by the time migration
     * runs. The checks above pass a destination that does not exist yet, which
     * is why they went on passing while no user was ever migrated. This one
     * reproduces what Electron leaves behind.
     */
    const lifecycleRoot = path.join(tmp, 'rebrand-lifecycle');
    const lifecycleOld = path.join(lifecycleRoot, 'SmartBrowser');
    const lifecycleNew = path.join(lifecycleRoot, 'Nabsun');
    fs.mkdirSync(path.join(lifecycleOld, 'Partitions', 'smartbrowser'), { recursive: true });
    fs.writeFileSync(path.join(lifecycleOld, 'history.json'), '["a visited page"]', 'utf8');
    fs.writeFileSync(path.join(lifecycleOld, 'Partitions', 'smartbrowser', 'Cookies'), 'x', 'utf8');
    fs.mkdirSync(lifecycleNew, { recursive: true }); // exactly what Electron does

    const lifecycleMoved = migrateProfile(lifecycleRoot, lifecycleNew);
    check(
      'a profile migrates even though Electron already made the destination',
      lifecycleMoved !== null && fs.existsSync(path.join(lifecycleNew, 'history.json')),
      `moved=${String(lifecycleMoved)} entries=${fs.readdirSync(lifecycleNew).join(',')}`,
    );
    check(
      'and the partition still comes with it',
      fs.existsSync(path.join(lifecycleNew, 'Partitions', 'nabsun', 'Cookies')),
      fs.readdirSync(path.join(lifecycleNew, 'Partitions')).join(','),
    );
    check(
      'a completion marker records that it happened',
      fs.existsSync(path.join(lifecycleNew, MIGRATION_MARKER)),
      fs.readdirSync(lifecycleNew).join(','),
    );

    // With the marker present the old profile must be left where it is, even
    // if one reappears - the user may have reinstalled the old build.
    fs.mkdirSync(path.join(lifecycleOld, 'Partitions'), { recursive: true });
    fs.writeFileSync(path.join(lifecycleOld, 'history.json'), '["stale"]', 'utf8');
    const secondRun = migrateProfile(lifecycleRoot, lifecycleNew);
    check(
      'the marker stops a second migration over live data',
      secondRun === null &&
        fs.readFileSync(path.join(lifecycleNew, 'history.json'), 'utf8').includes('a visited page'),
      fs.readFileSync(path.join(lifecycleNew, 'history.json'), 'utf8'),
    );

    // An interrupted copy must not be mistaken for a profile, and must not
    // block the next attempt.
    const resumeRoot = path.join(tmp, 'rebrand-resume');
    const resumeOld = path.join(resumeRoot, 'SmartBrowser');
    const resumeNew = path.join(resumeRoot, 'Nabsun');
    fs.mkdirSync(resumeOld, { recursive: true });
    fs.writeFileSync(path.join(resumeOld, 'history.json'), '["real"]', 'utf8');
    fs.mkdirSync(`${resumeNew}.migrating`, { recursive: true });
    fs.writeFileSync(path.join(`${resumeNew}.migrating`, 'history.json'), '["half copied"]', 'utf8');

    const resumed = migrateProfile(resumeRoot, resumeNew);
    check(
      'an interrupted migration is discarded and retried, not adopted',
      resumed !== null &&
        fs.readFileSync(path.join(resumeNew, 'history.json'), 'utf8').includes('real') &&
        !fs.existsSync(`${resumeNew}.migrating`),
      `moved=${String(resumed)} staging=${fs.existsSync(`${resumeNew}.migrating`)}`,
    );

    check(
      'an old internal URL is rewritten to the new scheme',
      rewriteInternalUrl('smart://history') === 'nabsun://history',
      rewriteInternalUrl('smart://history'),
    );
    check(
      'and an ordinary URL is left alone',
      rewriteInternalUrl('https://example.com/smart://x') === 'https://example.com/smart://x',
      rewriteInternalUrl('https://example.com/smart://x'),
    );

    // The old scheme still has to load, or every bookmark saved before the
    // rename breaks.
    const legacyTab = tabs.create('smart://about');
    await until(() => !legacyTab.wc.isLoading() && legacyTab.wc.getTitle().length > 0, 20_000);
    const legacyText = String(await legacyTab.wc.executeJavaScript('document.body.innerText'));
    check(
      'a bookmark saved under the former scheme still opens',
      legacyText.includes('Nabsun'),
      `${legacyTab.wc.getURL()} -> ${JSON.stringify(legacyText.slice(0, 80))}`,
    );
    tabs.close(legacyTab.id);

    /* ------------------------------------------- ordinary browser bits -- */
    // Back, forward, home and save-page had implementations reachable only from
    // the toolbar or not at all. These drive the same command dispatcher the
    // menu accelerators and the mouse's side buttons use.

    // handleCommand only reaches tabs and settings for these, so a partial
    // shell is honest here: the point is to exercise the real dispatcher the
    // menu accelerators and side buttons call, not to rebuild a window.
    const settings = new SettingsStore();
    settings.set({ homepage: `${origin}/` });
    const ipcDeps = {
      win: { tabs, window, send: () => {}, toggleSidebar: () => {} },
      settings,
    } as unknown as IpcDeps;

    const navTab = tabs.create(`${origin}/`);
    await until(() => !navTab.wc.isLoading() && navTab.wc.getTitle() === 'Home Page', 20_000);
    tabs.activate(navTab.id);
    tabs.navigate(navTab.id, `${origin}/page2`);
    await until(() => navTab.wc.getURL().includes('/page2'), 20_000);

    handleCommand(ipcDeps, 'back');
    await until(() => !navTab.wc.getURL().includes('/page2'), 20_000);
    check('Back returns to the previous page', !navTab.wc.getURL().includes('/page2'), navTab.wc.getURL());

    handleCommand(ipcDeps, 'forward');
    await until(() => navTab.wc.getURL().includes('/page2'), 20_000);
    check('Forward returns to the next page', navTab.wc.getURL().includes('/page2'), navTab.wc.getURL());

    // At the start of history, Back must do nothing rather than throw.
    handleCommand(ipcDeps, 'back');
    await until(() => !navTab.wc.getURL().includes('/page2'), 20_000);
    const atStart = navTab.wc.getURL();
    handleCommand(ipcDeps, 'back');
    await delay(400);
    check(
      'Back at the start of history is a no-op, not an error',
      navTab.wc.getURL() === atStart,
      `${atStart} -> ${navTab.wc.getURL()}`,
    );

    tabs.navigate(navTab.id, 'nabsun://about');
    await until(() => navTab.wc.getURL().startsWith('nabsun://about'), 20_000);
    handleCommand(ipcDeps, 'home');
    await until(() => navTab.wc.getURL().startsWith(origin), 20_000);
    check(
      'Home goes to the configured homepage',
      navTab.wc.getURL().startsWith(origin),
      navTab.wc.getURL(),
    );

    // View source only applies to real web pages; on an internal page it must
    // not open a confusing `view-source:nabsun://…` tab.
    tabs.navigate(navTab.id, 'nabsun://about');
    await until(() => navTab.wc.getURL().startsWith('nabsun://about'), 20_000);
    const beforeSource = tabs.all.length;
    handleCommand(ipcDeps, 'view-source');
    await delay(400);
    check(
      'View source is refused on an internal page',
      tabs.all.length === beforeSource,
      `${beforeSource} -> ${tabs.all.length} tabs`,
    );

    tabs.navigate(navTab.id, `${origin}/`);
    await until(() => navTab.wc.getURL().startsWith(origin), 20_000);
    handleCommand(ipcDeps, 'view-source');
    await until(() => tabs.all.some((t) => t.wc.getURL().startsWith('view-source:')), 20_000);
    const sourceTab = tabs.all.find((t) => t.wc.getURL().startsWith('view-source:'));
    check('View source opens the page source for a web page', Boolean(sourceTab), String(sourceTab?.wc.getURL()));
    if (sourceTab) tabs.close(sourceTab.id);

    check(
      'a saved page is named from the title',
      suggestedFileName('http://x/y', 'My Page: Title') === 'My Page Title.html',
      suggestedFileName('http://x/y', 'My Page: Title'),
    );
    check(
      'and falls back to the URL when there is no title',
      suggestedFileName('http://example.com/docs/report.pdf', '') === 'report.pdf',
      suggestedFileName('http://example.com/docs/report.pdf', ''),
    );
    check(
      'and to a generic name when there is neither',
      suggestedFileName('about:blank', '') === 'page.html',
      suggestedFileName('about:blank', ''),
    );
    tabs.close(navTab.id);

    /* -------------------------------------------------- internal pages -- */

    // Every renderer without a CSP makes Electron log a security warning, and
    // the new tab page loads on every tab — so the console filled with them.
    // The fix hashes each inline block rather than allowing 'unsafe-inline',
    // which means a page edit that outruns its hash breaks the page silently.
    // These checks are what makes that loud instead.
    // A marker only the page's own inline script can produce, so this proves
    // the hashed script executed rather than merely that something rendered.
    // `about` has no inline script, so its own static text is the marker.
    const ranMarker: Record<string, string> = {
      home: 'Ask about this page',
      about: 'Nabsun',
      // Rendered from the JSON fixture, so this proves the payload survived
      // substitution and parsed — not merely that the page loaded.
      history: 'Second entry',
    };

    for (const page of ['home', 'about', 'history']) {
      const violations: string[] = [];
      const cspTab = tabs.create(`nabsun://${page}`);
      cspTab.wc.on('console-message', (_e, _level, message) => {
        if (/Content Security Policy|Refused to (execute|apply|load)/i.test(message)) {
          violations.push(message);
        }
      });
      await until(() => !cspTab.wc.isLoading(), 20_000);
      await delay(250);

      const csp = String(
        await cspTab.wc.executeJavaScript(
          'fetch(location.href).then(r => r.headers.get("content-security-policy") || "")',
        ),
      );
      check(
        `nabsun://${page} is served a CSP header`,
        csp.includes("default-src 'none'"),
        JSON.stringify(csp.slice(0, 120)),
      );
      check(
        `nabsun://${page} allows its inline code by hash, not 'unsafe-inline'`,
        !csp.includes('unsafe-inline') && (page === 'about' || csp.includes('sha256-')),
        JSON.stringify(csp.slice(0, 200)),
      );
      check(
        `nabsun://${page} runs its own scripts under that CSP`,
        violations.length === 0,
        violations.join(' | ').slice(0, 300),
      );
      // A policy that blocked everything would also produce no violations, so
      // prove the page's own code actually ran.
      const text = String(await cspTab.wc.executeJavaScript('document.body.innerText'));
      check(
        `nabsun://${page} still renders under it`,
        text.includes(ranMarker[page]),
        `looked for ${JSON.stringify(ranMarker[page])} in ${JSON.stringify(text.trim().slice(0, 160))}`,
      );
      if (page === 'history') {
        // The awkward characters specifically: quotes and ampersands must
        // arrive intact, and a `</script>` in the data must not end the block.
        const rows = Number(
          await cspTab.wc.executeJavaScript('document.querySelectorAll("#list > *").length'),
        );
        check('a populated history page renders its rows', rows >= 2, `${rows} rows`);
        const quoted = String(await cspTab.wc.executeJavaScript('document.body.innerText'));
        check(
          'a title containing quotes, ampersands and markup survives substitution',
          quoted.includes('A "quoted" & <tagged> title'),
          JSON.stringify(quoted.slice(0, 200)),
        );
        check(
          'and a </script> inside the data does not break out of the block',
          violations.length === 0 && rows >= 2,
          violations.join(' | ').slice(0, 200),
        );
      }
      tabs.close(cspTab.id);
    }

    // --- the pages are actually light ---------------------------------------
    // The `theme` setting existed from the beginning and nothing read it, so
    // the browser was dark whatever it said. These assert the rendered result
    // rather than the presence of a stylesheet rule.
    for (const page of ['home', 'about', 'history']) {
      const themeTab = tabs.create(`nabsun://${page}`);
      await until(() => !themeTab.wc.isLoading(), 20_000);
      await delay(150);

      // Resolving `--bg` rather than reading body's background-color: two of
      // these pages paint a gradient, so their background-color is transparent
      // and a naive read scores them as pure black.
      const shade = (await themeTab.wc.executeJavaScript(`
        (() => {
          const root = getComputedStyle(document.documentElement);
          const lum = (value) => {
            const c = (value.match(/\\d+/g) || ['0','0','0']).slice(0, 3).map(Number);
            return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
          };
          // A hex token has to go through the browser to become rgb().
          const probe = document.createElement('span');
          probe.style.color = root.getPropertyValue('--bg').trim();
          document.body.appendChild(probe);
          const bg = lum(getComputedStyle(probe).color);
          probe.remove();
          return {
            bg,
            fg: lum(getComputedStyle(document.body).color),
            theme: document.documentElement.dataset.theme,
          };
        })()
      `)) as { bg: number; fg: number; theme: string };

      check(
        `nabsun://${page} uses the light palette by default`,
        shade.bg > 0.7,
        `--bg luminance ${shade.bg.toFixed(2)}, data-theme=${JSON.stringify(shade.theme)}`,
      );
      // A light background with light text would pass the check above and be
      // unreadable, which is exactly what a half-applied theme looks like.
      check(
        `nabsun://${page} keeps its text readable against it`,
        shade.bg - shade.fg > 0.4,
        `bg ${shade.bg.toFixed(2)} vs text ${shade.fg.toFixed(2)}`,
      );
      tabs.close(themeTab.id);
    }

    const aboutTab = tabs.create('nabsun://about');
    await until(() => !aboutTab.wc.isLoading() && aboutTab.wc.getTitle().includes('About'), 20_000);
    check('nabsun://about loads', aboutTab.wc.getTitle().includes('About'), aboutTab.wc.getTitle());
    check(
      'an internal page reports its own URL',
      aboutTab.wc.getURL().startsWith('nabsun://about'),
      `getURL()=${JSON.stringify(aboutTab.wc.getURL())}`,
    );
    tabs.close(aboutTab.id);

    const histTab = tabs.create('nabsun://history');
    await until(() => !histTab.wc.isLoading() && histTab.wc.getTitle() === 'History', 20_000);
    check('nabsun://history loads', histTab.wc.getTitle() === 'History', histTab.wc.getTitle());
    tabs.close(histTab.id);

    /* --------------------------------------------------------------- zoom */

    tabs.zoom(tab.id, 'in');
    const zoomedIn = tab.wc.getZoomLevel();
    tabs.zoom(tab.id, 'in');
    check('zoom in steps up', tab.wc.getZoomLevel() > zoomedIn, `${zoomedIn} -> ${tab.wc.getZoomLevel()}`);
    tabs.zoom(tab.id, 'reset');
    check('zoom reset returns to 100%', tab.wc.getZoomLevel() === 0, String(tab.wc.getZoomLevel()));

    /* ---------------------------------------------------------- tab model */

    const second = tabs.create(`${origin}/page2`);
    await until(() => !second.wc.isLoading());
    const third = tabs.create(`${origin}/`, { background: true });
    check('tabs open and stay tracked', tabs.all.length === 3, String(tabs.all.length));

    tabs.activate(tab.id);
    tabs.cycle(1);
    check('Ctrl+Tab moves to the next tab', tabs.activeTabId === second.id);
    tabs.cycle(-1);
    check('Ctrl+Shift+Tab moves back', tabs.activeTabId === tab.id);
    tabs.activateByIndex(-1);
    check('Ctrl+9 selects the last tab', tabs.activeTabId === third.id);

    const reorderTarget = tabs.all[0].id;
    tabs.reorder(reorderTarget, 2);
    check('tabs can be reordered', tabs.all[2].id === reorderTarget);

    /* -------------------------------------------------- reopen closed tab */

    const closedUrl = second.wc.getURL();
    const before = new Set(tabs.all.map((t) => t.id));
    tabs.close(second.id);
    check('closing a tab removes it', tabs.all.length === 2, String(tabs.all.length));

    tabs.reopenLast();
    // Identify the *new* tab, so a pre-existing tab on the same URL cannot
    // make this pass by accident.
    const reopened = tabs.all.find((t) => !before.has(t.id));
    await until(() => Boolean(reopened && reopened.wc.getURL() === closedUrl), 10_000);
    check(
      'Ctrl+Shift+T reopens the closed tab at its URL',
      Boolean(reopened) && reopened!.wc.getURL() === closedUrl,
      `reopened=${JSON.stringify(reopened?.wc.getURL())} want=${closedUrl}`,
    );

    /* ------------------------------------------------------ session state */

    // Let every tab finish before snapshotting; a tab mid-load has no URL yet.
    await until(() => tabs.all.every((t) => !t.wc.isLoading()), 15_000);

    const snap = tabs.snapshot();
    check(
      'a session snapshot captures the open tabs',
      snap.urls.length === tabs.all.length && snap.urls.every((u) => /^https?:/.test(u)),
      `snapshot=${JSON.stringify(snap)} live=${JSON.stringify(tabs.all.map((t) => t.wc.getURL()))}`,
    );

    /* ---------------------------------------------------------- downloads */

    tabs.all[0].wc.downloadURL(`${origin}/file.txt`);
    const done = await until(
      () => downloads.list().some((d) => d.state === 'completed'),
      15_000,
    );
    const entry = downloads.list()[0];
    check('a download completes', done && entry?.state === 'completed', JSON.stringify(entry));
    check(
      'the downloaded file is written to disk with its contents',
      Boolean(entry) && fs.existsSync(entry.savePath) &&
        fs.readFileSync(entry.savePath, 'utf8') === 'hello world',
      entry ? entry.savePath : 'no entry',
    );
    check('the download is named from the server', entry?.filename === 'notes.txt', entry?.filename);
    /* --------------------------------------------- chrome extensions ---- */

    const extDir = path.join(__dirname, '..', '..', 'scripts', 'fixtures', 'test-extension');
    const extensions = new ChromeExtensionManager(() => [{ path: extDir, enabled: true }]);
    extensions.attach(ses);
    await extensions.loadAll();

    const status = extensions.status();
    const testExt = status[0];
    check('an unpacked extension loads', Boolean(testExt?.loaded), JSON.stringify(testExt?.error));
    check(
      'its manifest is read',
      testExt?.name === 'Nabsun Test Extension' && testExt.manifestVersion === 3,
      `${testExt?.name} MV${testExt?.manifestVersion}`,
    );
    check('a toolbar action is detected', testExt?.hasAction === true && Boolean(testExt.popupPath));
    check(
      'the action icon is readable for the toolbar',
      testExt?.iconDataUrl?.startsWith('data:image/png;base64,') === true,
    );

    // The real test of an extension host: does a content script run in a page?
    const extTab = tabs.create(`${origin}/`);
    await until(() => !extTab.wc.isLoading() && extTab.wc.getTitle() === 'Home Page', 12_000);
    // A manual loop, because `until` takes a synchronous predicate and an async
    // one would resolve truthy on the first tick.
    let contentScriptResult = '';
    const injectDeadline = Date.now() + 12_000;
    while (Date.now() < injectDeadline) {
      contentScriptResult = String(
        await extTab.wc
          .executeJavaScript(
            `(() => { const m = document.getElementById('__nabsun_extension_marker__');
               return m ? m.dataset.hasStorage + '|' + (m.dataset.runtimeId ? 'has-id' : 'no-id') : ''; })()`,
          )
          .catch(() => ''),
      );
      if (contentScriptResult.startsWith('yes')) break;
      await delay(250);
    }

    check(
      'a content script runs in an ordinary page',
      contentScriptResult.startsWith('yes'),
      contentScriptResult || '(no marker found)',
    );
    check(
      'chrome.runtime and chrome.storage are available to it',
      contentScriptResult === 'yes|has-id',
      contentScriptResult,
    );

    // The popup is a chrome-extension:// document the browser renders itself.
    const ext = extensions.byId(testExt.id);
    let popupText = '';
    if (ext) {
      const popupWin = new BrowserWindow({
        show: false,
        webPreferences: { partition: 'persist:browse-harness' },
      });
      await popupWin.webContents.loadURL(`${ext.url}popup.html`).catch(() => {});
      popupText = String(
        await popupWin.webContents.executeJavaScript('document.body.innerText').catch(() => ''),
      );
      popupWin.destroy();
    }
    check(
      'the action popup renders from chrome-extension://',
      /Test Extension/.test(popupText) && /runtime\.id:/.test(popupText),
      popupText.replace(/\s+/g, ' ').slice(0, 120) || '(extension not loaded)',
    );

    extensions.remove(testExt.id);
    check('an extension can be unloaded', extensions.loaded.length === 0);
    tabs.close(extTab.id);

    /* -------------------------------------------------- saved passwords -- */

    const passwords = new PasswordStore();
    passwords.clearAll();

    check(
      'origins are normalised, and non-web schemes are refused',
      PasswordStore.originOf('https://example.com/login?x=1') === 'https://example.com' &&
        PasswordStore.originOf('file:///c:/x.html') === null,
    );

    passwords.save('https://example.com', 'ada', 'hunter2');
    const stored = passwords.list();
    check('a password is saved with metadata only in the list', stored.length === 1);
    check(
      'the list never carries the password itself',
      !JSON.stringify(stored).includes('hunter2'),
      JSON.stringify(stored[0]),
    );
    check(
      'the password round-trips through encryption',
      passwords.reveal(stored[0].id) === 'hunter2',
    );
    check(
      'it is not written to disk in plaintext',
      !fs.readFileSync(path.join(tmp, 'passwords.json'), 'utf8').includes('hunter2'),
    );

    // The security property that matters: credentials must not cross origins.
    check(
      'autofill matches the exact origin',
      passwords.forOrigin('https://example.com').length === 1 &&
        passwords.forOrigin('http://example.com').length === 0 &&
        passwords.forOrigin('https://evil.example.com').length === 0,
    );

    check('a repeat of the same credential is not re-offered', passwords.isKnown('https://example.com', 'ada', 'hunter2'));
    check('a changed password is recognised as an update', passwords.isUpdate('https://example.com', 'ada'));

    passwords.save('https://example.com', 'ada', 'newpass');
    check(
      'saving the same user again updates rather than duplicates',
      passwords.list().length === 1 && passwords.reveal(passwords.list()[0].id) === 'newpass',
    );

    /* --------------------------------- autofill and capture, in a real page */

    // Wire the same handlers the app registers, so the page preload has
    // something to talk to.
    // A holder, because TypeScript cannot see the assignment inside the IPC callback.
    const capture: { value: { username: string; password: string } | null } = { value: null };
    ipcMain.handle('pw:for-origin', (event) => {
      const from = PasswordStore.originOf(event.sender.getURL());
      if (!from) return null;
      const found = passwords.forOrigin(from);
      return found.length ? found : null;
    });
    ipcMain.on('pw:used', () => {});
    ipcMain.on('pw:capture', (_e, payload: { username: string; password: string }) => {
      capture.value = payload;
    });

    passwords.save(origin, 'ada@example.com', 'correct-horse');

    const loginTab = tabs.create(`${origin}/login`);
    await until(() => !loginTab.wc.isLoading() && loginTab.wc.getTitle() === 'Sign in', 20_000);

    let filled = '';
    const fillDeadline = Date.now() + 15_000;
    while (Date.now() < fillDeadline) {
      filled = String(
        await loginTab.wc
          .executeJavaScript(
            `(() => { const e = document.getElementById('email'), p = document.getElementById('pw');
               return e && p ? e.value + '|' + p.value : ''; })()`,
          )
          .catch(() => ''),
      );
      if (filled.startsWith('ada@example.com|')) break;
      await delay(250);
    }
    check(
      'a saved login is filled into a real sign-in form',
      filled === 'ada@example.com|correct-horse',
      `fields = ${JSON.stringify(filled)}`,
    );

    // Submitting a *different* password must be offered for saving.
    await loginTab.wc.executeJavaScript(
      `(() => { const p = document.getElementById('pw');
         const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         setter.call(p, 'a-new-password');
         p.dispatchEvent(new Event('input', { bubbles: true }));
         document.querySelector('button[type=submit]').click();
         return true; })()`,
    );
    await until(() => capture.value !== null, 15_000);
    check(
      'submitting a sign-in form reports the credential for saving',
      capture.value?.password === 'a-new-password' &&
        capture.value?.username === 'ada@example.com',
      JSON.stringify(capture.value),
    );

    tabs.close(loginTab.id);
    ipcMain.removeHandler('pw:for-origin');
    passwords.clearAll();
    check('saved passwords can be cleared', passwords.list().length === 0);

    /* --------------------------------------------------------- bookmarks -- */

    const bm = history.addBookmark(`${origin}/page2`, 'Page Two');
    check('a bookmark is saved and lands on the bar', bm.onBar === true);
    check('bookmarks are listed', history.bookmarks().some((b) => b.id === bm.id));

    history.updateBookmark(bm.id, { title: 'Renamed', folder: 'Work', onBar: false });
    const updated = history.bookmarks().find((b) => b.id === bm.id)!;
    check(
      'a bookmark can be renamed, foldered and taken off the bar',
      updated.title === 'Renamed' && updated.folder === 'Work' && updated.onBar === false,
      JSON.stringify(updated),
    );
    check('folders are derived from the bookmarks', history.folders().includes('Work'));

    const homeBookmark = history.addBookmark(`${origin}/`, 'Home');
    history.reorderBookmark(homeBookmark.id, 0);
    check('bookmarks can be reordered', history.bookmarks()[0].id === homeBookmark.id);

    check(
      'top sites are one entry per host, ranked',
      history.topSites(5).length > 0 &&
        new Set(history.topSites(5).map((s) => new URL(s.url).hostname)).size ===
          history.topSites(5).length,
    );

    history.removeBookmark(bm.id);
    check('a bookmark can be deleted', !history.bookmarks().some((b) => b.id === bm.id));

    /* ------------------------------------------------ chrome is clickable */

    // The tab strip doubles as the frameless window's drag handle, and a drag
    // region swallows mouse events at the OS level: a control inside it that
    // does not opt out looks fine and is simply dead. That is invisible to DOM
    // tests, so assert the computed region directly.
    const chrome = new BrowserWindow({ show: false, width: 1200, height: 200 });
    await chrome.webContents.loadFile(
      path.join(__dirname, '..', 'renderer', 'shell', 'index.html'),
    );
    const regions = (await chrome.webContents.executeJavaScript(`
      (() => {
        const out = {};
        for (const sel of ['#new-tab', '#win-min', '#win-max', '#win-close']) {
          const el = document.querySelector(sel);
          out[sel] = el ? getComputedStyle(el).getPropertyValue('-webkit-app-region').trim() : 'MISSING';
        }
        return out;
      })()
    `)) as Record<string, string>;

    for (const [sel, region] of Object.entries(regions)) {
      check(
        `${sel} is clickable, not part of the window drag region`,
        region === 'no-drag',
        `-webkit-app-region: ${region || '(empty)'}`,
      );
    }
    chrome.destroy();
  } catch (err) {
    check('harness completed', false, err instanceof Error ? err.stack : String(err));
  } finally {
    server.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  app.exit(failures ? 1 : 0);
});









