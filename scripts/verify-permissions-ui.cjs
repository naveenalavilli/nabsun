const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const path = require('node:path');

async function main() {
  const bundle = await build({ entryPoints: [path.join(__dirname, '../src/renderer/shell/settings.ts')], bundle: true, write: false, format: 'iife', globalName: 'SettingsModule' });
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await win.loadURL('data:text/html,<main id="settings-body"></main>');
    await win.webContents.executeJavaScript(`(async () => {
      ${bundle.outputFiles[0].text}
      let settings = { provider: 'local', baseUrls: {}, alwaysAllowTools: [], autoApprove: { safe: true, write: true, dangerous: true } };
      window.nabsun = {
        settings: { set: async patch => {
          await new Promise(r => setTimeout(r, 10));
          return settings = { ...settings, ...patch };
        } },
        config: { paths: async () => ({ userData: '/fixture', soulFile: '/fixture/soul.md' }) }
      };
      const view = new SettingsModule.SettingsView(() => {});
      view.settings = settings;
      document.querySelector('main').append(view.behaviourSection(settings));
      const toggle = (label, checked) => {
        const row = [...document.querySelectorAll('.check')].find(node => node.textContent.includes(label));
        const input = row.querySelector('input');
        input.checked = checked;
        input.dispatchEvent(new Event('change'));
      };
      toggle('Run high-risk actions', false);
      await view.approvalSave;
      toggle('Run read-only actions', false);
      await view.approvalSave;
      if (settings.autoApprove.dangerous || settings.autoApprove.safe) throw Error('Sequential toggles restored a revoked permission');
      toggle('Autopilot', false);
      toggle('Run read-only actions', true);
      await view.approvalSave;
      if (settings.autoApprove.dangerous || settings.autoApprove.write || !settings.autoApprove.safe) throw Error('Rapid toggles lost an edit');
    })()`);
    console.log('PASS sequential and rapid permission toggles preserve revoked permissions');
  } finally { win.destroy(); }
}
main().then(() => app.exit(0), err => { console.error(err); app.exit(1); });
