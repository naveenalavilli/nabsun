import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { app, BrowserWindow, session } from 'electron';
import { NetworkAuth } from '../main/networkAuth';
app.setPath(
  'userData',
  fs.mkdtempSync(path.join(os.tmpdir(), 'nabsun-network-auth-')),
);
async function main() {
  await app.whenReady();
  let received = 0;
  const server = http.createServer((req, res) => {
    if (
      req.headers.authorization !==
      'Basic ' + Buffer.from('fixture:fixture-secret').toString('base64')
    ) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Fixture private portal"',
      });
      res.end('Sign in required');
      return;
    }
    received++;
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Private fixture</title><h1>Signed in</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ses = session.fromPartition('network-auth-fixture');
  new NetworkAuth(ses).install();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: ses,
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const loading = window.loadURL(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      timer = setInterval(() => {
        const prompt = BrowserWindow.getAllWindows().find(
          (candidate) =>
            candidate !== window && candidate.getTitle() === 'Website sign-in',
        );
        if (prompt) {
          void prompt.webContents
            .executeJavaScript(
              `if(typeof document.querySelector('form')?.onsubmit!=='function')false;else{document.querySelector('#username').value='fixture';document.querySelector('#password').value='fixture-secret';document.querySelector('form').requestSubmit();true}`,
            )
            .then((ready) => {
              if (ready) {
                clearInterval(timer);
                resolve();
              }
            }, reject);
        } else if (Date.now() - started > 15000) {
          clearInterval(timer);
          reject(Error('Native sign-in dialog did not open'));
        }
      }, 30);
    });
    await loading;
    assert.equal(
      await window.webContents.executeJavaScript(
        'document.querySelector("h1").textContent',
      ),
      'Signed in',
    );
    assert.ok(received >= 1);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    console.log(
      'PASS HTTP Basic challenge opens a separate native-owned credential dialog; explicit user submission loads the protected fixture and closes the dialog',
    );
  } finally {
    if (timer) clearInterval(timer);
    for (const candidate of BrowserWindow.getAllWindows()) candidate.destroy();
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
