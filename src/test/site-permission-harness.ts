import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { app, BrowserWindow } from 'electron';
import { SitePermissions } from '../main/sitePermissions';
import { applyPermissionPolicy } from '../main/security';
app.setPath(
  'userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-permissions-')),
);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
async function main() {
  await app.whenReady();
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Camera fixture</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let prompts = 0;
  const sites = new SitePermissions(async (_origin, capabilities) => {
    prompts++;
    assert.deepEqual(capabilities, ['camera']);
    return 'once';
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'site-permission-fixture',
    },
  });
  applyPermissionPolicy(window.webContents.session, sites);
  try {
    await window.loadURL(origin);
    window.showInactive();
    const camera = await window.webContents.executeJavaScript(
      `navigator.mediaDevices.getUserMedia({video:true}).then(stream=>{const count=stream.getVideoTracks().length;stream.getTracks().forEach(track=>track.stop());return count})`,
    );
    assert.equal(camera, 1);
    assert.equal(prompts, 1);
    assert.equal(sites.allowed(origin, 'camera'), false);
    console.log(
      'PASS camera fixture receives a stream after a user-only allow-once prompt',
    );
    const deny = new SitePermissions(async () => 'deny');
    assert.equal(
      await deny.request(window.webContents, origin, ['camera']),
      false,
    );
    let unexpected = 0;
    const restarted = new SitePermissions(async () => {
      unexpected++;
      return 'remember';
    });
    assert.equal(
      await restarted.request(window.webContents, origin, ['camera']),
      false,
    );
    assert.equal(unexpected, 0);
    assert.equal(
      await restarted.request(window.webContents, 'https://different.example', [
        'microphone',
      ]),
      false,
    );
    restarted.revoke(origin);
    assert.equal(
      await restarted.request(window.webContents, origin, ['camera']),
      true,
    );
    assert.equal(unexpected, 1);
    console.log(
      'PASS remembered denial survives store reconstruction; cross-origin frames cannot borrow grants; Settings revocation restores the prompt',
    );
  } finally {
    window.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
