const { app, BrowserWindow, nativeTheme } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-theme-test-')));
async function main() {
  const bundle = await build({ entryPoints: [path.join(__dirname, '../src/renderer/shell/appearance.ts')], bundle: true, write: false, format: 'iife', globalName: 'Appearance' });
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 420, height: 700, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadURL('data:text/html,<main></main>');
    await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname, '../src/renderer/shell/styles.css'), 'utf8') + fs.readFileSync(path.join(__dirname, '../src/pages/themes.css'), 'utf8'));
    const results = await win.webContents.executeJavaScript(`(async () => {
      ${bundle.outputFiles[0].text}
      const results = [];
      const check = (name, ok) => { if (!ok) throw Error(name); results.push(name); };
      const tick = () => new Promise(r => setTimeout(r, 0));
      let settings = { theme:'light', appearance:'classic' }, fail = false;
      window.nabsun = {settings: { set: async patch => { if (fail) throw Error('Fixture'); return settings = {...settings,...patch}; } }};
      const main = document.querySelector('main');
      const apply = next => { document.documentElement.dataset.theme = next.theme; document.documentElement.dataset.appearance = next.appearance; };
      const mount = () => main.replaceChildren(Appearance.appearanceSelector(settings, apply));
      apply(settings); mount();
      main.querySelector('[data-appearance=blossom]').click(); await tick();
      check('style saves independently of color mode', settings.appearance === 'blossom' && settings.theme === 'light');
      const select = main.querySelector('select'); select.value = 'dark'; select.dispatchEvent(new Event('change')); await tick();
      check('dark mode preserves style', settings.appearance === 'blossom' && settings.theme === 'dark');
      mount(); check('saved style is selected when reopened', main.querySelector('[data-appearance=blossom]').getAttribute('aria-pressed') === 'true');
      fail = true; main.querySelector('[data-appearance=ocean]').click(); await tick();
      check('failed save leaves prior selection and allows retry', main.querySelector('[data-appearance=blossom]').getAttribute('aria-pressed') === 'true' && !main.querySelector('button').disabled && main.textContent.includes('Could not save'));
      fail = false;
      const luminance = color => {
        const channels = color.match(/[\\d.]+/g).slice(0,3).map(Number).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
        return channels[0]*.2126 + channels[1]*.7152 + channels[2]*.0722;
      };
      const sample = document.createElement('div'); sample.style.cssText = 'color:var(--text);background:var(--bg)'; document.body.append(sample);
      for (const theme of ['light','dark']) for (const appearance of ['classic','playful','blossom','ocean']) {
        apply({theme,appearance});
        const style = getComputedStyle(sample), a = luminance(style.color), b = luminance(style.backgroundColor);
        check(appearance + ' ' + theme + ' body text has accessible contrast', (Math.max(a,b)+.05)/(Math.min(a,b)+.05) >= 4.5);
      }
      main.querySelector('[data-appearance=classic]').click(); await tick();
      check('Classic restores original palette', settings.appearance === 'classic' && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#ff6f42');
      check('theme cards fit a narrow sidebar', main.scrollWidth <= main.clientWidth);
      return results;
    })()`);
    results.forEach(name => console.log('PASS ' + name));
    for (const colorMode of ['light', 'dark']) {
      nativeTheme.themeSource = colorMode;
      const follows = await win.webContents.executeJavaScript(`(async () => {
        const root = document.documentElement;
        root.dataset.appearance = 'ocean';
        root.dataset.theme = '${colorMode}';
        const probe = document.createElement('div'); probe.style.background = 'var(--bg)'; document.body.append(probe);
        const explicit = getComputedStyle(probe).backgroundColor;
        delete root.dataset.theme;
        await new Promise(r => setTimeout(r, 50));
        return explicit === getComputedStyle(probe).backgroundColor;
      })()`);
      if (!follows) throw Error('Follow device loses the chosen style in ' + colorMode);
      console.log('PASS Follow device preserves style in ' + colorMode);
    }
  } finally { win.destroy(); }
}
main().then(() => app.exit(0), err => { console.error(err); app.exit(1); });
