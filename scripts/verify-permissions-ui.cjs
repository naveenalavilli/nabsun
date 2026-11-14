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
      let settings = { provider: 'local', baseUrls: {}, alwaysAllowTools: [], autoApprove: { safe: true, write: true, dangerous: false } };
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
      const choose = mode => document.querySelector('[data-approval-mode="' + mode + '"]').click();
      choose('ask');
      await view.approvalSave;
      if (settings.autoApprove.write || settings.autoApprove.dangerous) throw Error('Ask mode did not revoke automatic actions');
      choose('full');
      if (document.querySelector('.full-access-confirmation').hidden || settings.approvalMode === 'full') throw Error('Full access enabled without confirmation');
      document.querySelector('.full-access-confirmation .ghost').click();
      if (!document.querySelector('.full-access-confirmation').hidden || settings.autoApprove.dangerous) throw Error('Cancelling full access changed permissions');
      choose('full'); document.querySelector('[data-confirm-full]').click();
      await view.approvalSave;
      if (settings.approvalMode !== 'full' || !settings.autoApprove.dangerous) throw Error('Confirmed full access did not save');
      choose('automatic');
      await view.approvalSave;
      if (settings.approvalMode !== 'automatic' || settings.autoApprove.dangerous || !settings.autoApprove.write) throw Error('Routine mode retained full access');
      choose('ask'); await view.approvalSave;
      if (settings.autoApprove.dangerous || settings.autoApprove.write || !settings.autoApprove.safe) throw Error('Ask mode lost revocation');
      const display = [...document.querySelectorAll('.check')].find(row => row.textContent.includes('Show approval messages')).querySelector('input');
      if (display.checked) throw Error('Approval messages should default to hidden');
      display.checked = true; display.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 30));
      if (!settings.showApprovalMessages) throw Error('Display toggle did not save');
      view.setIntegrationControl('plugins',false);view.setIntegrationControl('mcp',false);await view.integrationSave;
      if(settings.integrationControls.plugins || settings.integrationControls.mcp || !settings.integrationControls.extensions)throw Error('Integration toggles lost a revocation');
      view.setIntegrationControl('extensions',false);view.setIntegrationControl('plugins',true);await view.integrationSave;
      if(!settings.integrationControls.plugins || settings.integrationControls.mcp || settings.integrationControls.extensions)throw Error('Rapid integration toggles restored a disabled integration');
    })()`);
    console.log('PASS approval modes, full-access confirmation/cancel/revocation, display toggle, and integration toggles');
  } finally { win.destroy(); }
}
main().then(() => app.exit(0), err => { console.error(err); app.exit(1); });
