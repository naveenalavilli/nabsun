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
      welcome.render();
      check('account connection is optional and collapsed on first visit', !main.querySelector('.welcome-optional').open);
      check('browse-only choice appears before the illustration', !!(main.querySelector('[data-action=skip]').compareDocumentPosition(main.querySelector('.welcome-illustration')) & Node.DOCUMENT_POSITION_FOLLOWING));
      const beforeTour = JSON.stringify(settings);
      main.querySelector('[data-guide-next]').click();
      check('Next opens one task panel with matching accessible tab state', !main.querySelector('#guide-panel-1').hidden && main.querySelector('#guide-panel-0').hidden && main.querySelector('#guide-tab-1').getAttribute('aria-selected') === 'true');
      for (const button of main.querySelectorAll('[data-guide-example]')) {
        button.click();
        check('example ' + button.textContent + ' updates its draft and walkthrough', main.querySelectorAll('[data-guide-example][aria-pressed=true]').length === 1 && main.querySelector('#guide-prompt').textContent.length > 30 && main.querySelectorAll('#guide-task-steps li').length === 3);
      }
      main.querySelector('#guide-tab-1').dispatchEvent(new KeyboardEvent('keydown', { key:'End', bubbles:true }));
      check('keyboard End opens controls and moves tab focus', !main.querySelector('#guide-panel-2').hidden && document.activeElement.id === 'guide-tab-2');
      main.querySelector('#guide-tab-2').dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true }));
      check('keyboard arrows wrap between guide sections', !main.querySelector('#guide-panel-0').hidden && document.activeElement.id === 'guide-tab-0');
      check('exploring the guide does not save settings or start a task', beforeTour === JSON.stringify(settings) && !finished);
      fail = true; main.querySelector('[data-action=local]').click(); await tick();
      check('setup failure remains retryable', !finished && !main.querySelector('button').disabled && main.textContent.includes('Could not save'));
      fail = false; main.querySelector('[data-action=local]').click(); await tick();
      check('local setup completes and prefills without sending', settings.onboardingCompleted && settings.provider === 'local' && finished[1] === 'chat' && !!finished[2]);
      welcome.render(); main.querySelector('.welcome-optional').open = true; main.querySelector('[data-action=connect]').click(); await tick();
      check('connect opens existing connection manager without changing provider', finished[1] === 'extensions' && settings.provider === 'local');
      settings.provider = 'claude-cli'; welcome.render(); main.querySelector('[data-action=skip]').click(); await tick();
      check('browse-only choice preserves the assistant choice without opening chat', finished[1] === 'browse' && settings.provider === 'claude-cli');
      welcome.render(); main.querySelector('#guide-tab-1').click();
      main.querySelector('[data-guide-example="1"]').click();
      const examplePrompt = main.querySelector('#guide-prompt').textContent;
      main.querySelector('[data-action=example]').click(); await tick();
      check('trying an example preserves the assistant and passes only an editable draft', settings.provider === 'claude-cli' && finished[1] === 'chat' && finished[2] === examplePrompt);
      welcome.render(); check('reopening resets the tour without resetting settings', !main.querySelector('#guide-panel-0').hidden && settings.provider === 'claude-cli');

      return results;
    })()`);
    results.forEach(name => console.log('PASS ' + name));
    await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname, '../src/renderer/shell/styles.css'), 'utf8'));
    await win.webContents.executeJavaScript(`document.querySelector('main').className = 'welcome'; document.querySelector('main').style.height = '100vh';`);
    for (const width of [320, 420, 900, 1280]) {
      win.setContentSize(width, 700);
      for (const theme of ['light', 'dark']) {
        await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = '${theme}'`);
        const fits = await win.webContents.executeJavaScript(`(() => {
          document.querySelector('#guide-tab-0').click();
          const root = document.querySelector('main');
          root.querySelector('[data-action=skip]').scrollIntoView({ block: 'center' });
          const skip = root.querySelector('[data-action=skip]').getBoundingClientRect();
          return root.scrollWidth <= root.clientWidth && skip.bottom <= innerHeight && skip.top >= 0;
        })()`);
        if (!fits) throw Error('Welcome layout overflow: ' + width + ' ' + theme);
        console.log('PASS welcome fits and skip is reachable: ' + width + ' ' + theme);
        for (const step of [0,1,2]) {
          const fitsPanel = await win.webContents.executeJavaScript(`(() => {
            document.querySelector('[data-guide-step="${step}"]').click();
            const root = document.querySelector('main');
            const panels = [...document.querySelectorAll('.guide-panel')];
            return root.scrollWidth <= root.clientWidth && panels.filter(panel => !panel.hidden).length === 1;
          })()`);
          if (!fitsPanel) throw Error('Guide section overflow: ' + step + ' ' + width + ' ' + theme);
        }
        console.log('PASS all guide sections fit: ' + width + ' ' + theme);

      }
    }
  } finally { win.destroy(); }
}
main().then(() => app.exit(0), err => { console.error(err); app.exit(1); });
