const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-welcome-test-')));

async function main() {
  const bundles = await Promise.all(['model-picker', 'onboarding'].map(name => build({
    entryPoints: [path.join(__dirname, '../src/renderer/shell', name + '.ts')],
    bundle: true, write: false, format: 'iife', globalName: name === 'onboarding' ? 'Welcome' : 'Models', platform: 'browser',
  })));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL('data:text/html,<main></main>');
    const results = await win.webContents.executeJavaScript(`(async () => {
      ${bundles.map(b => b.outputFiles[0].text).join('\n')}
      const results = [];
      const check = (name, ok) => { if (!ok) throw Error(name); results.push(name); };
      const tick = () => new Promise(r => setTimeout(r, 20));
      let settings = { provider: 'codex-cli', models: { 'codex-cli': '', 'claude-cli': 'opus', local: 'local-model' }, onboardingCompleted: false };
      let fail = false, finished;
      window.nabsun = { settings: {
        get: async () => structuredClone(settings),
        set: async patch => { if (fail) throw Error('Fixture'); settings = { ...settings, ...patch }; return structuredClone(settings); }
      }};
      const main = document.querySelector('main');
      const mount = () => main.replaceChildren(Models.modelPicker(structuredClone(settings), () => {}));
      const choose = value => { const select = main.querySelector('select'); select.value = value; select.dispatchEvent(new Event('change')); };
      mount();
      check('CLI default is selected initially', main.querySelector('select').value === '');
      choose('gpt-6-luna'); await tick();
      check('Codex choice saves without changing Claude', settings.models['codex-cli'] === 'gpt-6-luna' && settings.models['claude-cli'] === 'opus');
      mount(); check('saved selection survives remount', main.querySelector('select').value === 'gpt-6-luna');
      choose('__custom__');
      check('custom model entry receives focus', document.activeElement === main.querySelector('input'));
      main.querySelector('input').value = 'my-model-id';
      main.querySelector('form').dispatchEvent(new Event('submit', {cancelable:true})); await tick();
      check('custom ID persists', settings.models['codex-cli'] === 'my-model-id');
      choose(''); await tick(); check('Default clears the override', settings.models['codex-cli'] === '');
      fail = true; choose('gpt-6-astra'); await tick();
      check('save failure restores selection and leaves retry usable', main.querySelector('select').value === '' && !main.querySelector('select').disabled && main.textContent.includes('Could not save'));
      fail = false; settings.provider = 'claude-cli'; mount();
      choose('sonnet'); await tick(); check('Claude alias saves independently', settings.models['claude-cli'] === 'sonnet' && settings.models['codex-cli'] === '');
      choose('__custom__'); main.querySelector('input').value = '--bad';
      main.querySelector('form').dispatchEvent(new Event('submit', {cancelable:true})); await tick();
      check('invalid custom ID does not change model', settings.models['claude-cli'] === 'sonnet');
      const welcome = new Welcome.OnboardingView(main, (...args) => { finished = args; });
      welcome.render(); fail = true; main.querySelector('[data-action=local]').click(); await tick();
      check('setup failure remains retryable', !finished && !main.querySelector('button').disabled && main.textContent.includes('Could not save'));
      fail = false; main.querySelector('[data-action=local]').click(); await tick();
      check('local setup completes and prefills without sending', settings.onboardingCompleted && settings.provider === 'local' && finished[1] === 'chat' && !!finished[2]);
      welcome.render(); main.querySelector('[data-action=connect]').click(); await tick();
      check('connect opens existing connection manager without changing provider', finished[1] === 'extensions' && settings.provider === 'local');
      settings.provider = 'claude-cli'; welcome.render(); main.querySelector('[data-action=skip]').click(); await tick();
      check('skip preserves existing provider', finished[1] === 'chat' && settings.provider === 'claude-cli');
      return results;
    })()`);
    results.forEach(name => console.log('PASS ' + name));
    await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname, '../src/renderer/shell/styles.css'), 'utf8'));
    await win.webContents.executeJavaScript(`document.querySelector('main').className = 'welcome'; document.querySelector('main').style.height = '100vh';`);
    for (const width of [320, 420]) {
      win.setContentSize(width, 700);
      for (const theme of ['light', 'dark']) {
        await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = '${theme}'`);
        const fits = await win.webContents.executeJavaScript(`(() => {
          const root = document.querySelector('main');
          root.scrollTop = root.scrollHeight;
          const skip = root.querySelector('[data-action=skip]').getBoundingClientRect();
          return root.scrollWidth <= root.clientWidth && skip.bottom <= innerHeight && skip.top >= 0;
        })()`);
        if (!fits) throw Error('Welcome layout overflow: ' + width + ' ' + theme);
        console.log('PASS welcome fits and skip is reachable: ' + width + ' ' + theme);
      }
    }
  } finally { win.destroy(); }
}
main().then(() => app.exit(0), err => { console.error(err); app.exit(1); });
