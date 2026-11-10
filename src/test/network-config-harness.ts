import assert from 'node:assert/strict';
import http from 'node:http';
import { app, session } from 'electron';
import {
  applyBrowserNetwork,
  defaultNetwork,
  validateNetwork,
} from '../main/browserNetwork';
async function main() {
  await app.whenReady();
  const ses = session.fromPartition('network-config-fixture');
  assert.throws(
    () => validateNetwork({ ...defaultNetwork, integratedDomains: '*' }),
    /wildcard/,
  );
  assert.throws(
    () =>
      validateNetwork({
        ...defaultNetwork,
        mode: 'pac',
        pacUrl: 'file:///private/proxy.pac',
      }),
    /HTTP/,
  );
  assert.throws(
    () =>
      validateNetwork({
        ...defaultNetwork,
        mode: 'manual',
        proxy: 'user:secret@proxy.example:8080',
      }),
    /credentials/,
  );
  assert.equal(
    validateNetwork({
      ...defaultNetwork,
      mode: 'manual',
      proxy: 'proxy.example:80',
    }).proxy,
    'proxy.example:80',
  );
  await applyBrowserNetwork(ses, {
    ...defaultNetwork,
    mode: 'manual',
    proxy: '127.0.0.1:18080',
    integratedDomains: 'portal.work.example, *.trusted.work.example',
  });
  assert.equal(
    await ses.resolveProxy('https://example.invalid'),
    'PROXY 127.0.0.1:18080',
  );
  await applyBrowserNetwork(ses, { ...defaultNetwork, mode: 'direct' });
  assert.equal(await ses.resolveProxy('https://example.invalid'), 'DIRECT');
  let port = 18081,
    requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    const selected = port;
    res.setHeader('Content-Type', 'application/x-ns-proxy-autoconfig');
    res.setHeader('Cache-Control', 'no-store');
    setTimeout(
      () =>
        res.end(
          `function FindProxyForURL(url,host){return "PROXY 127.0.0.1:${selected}";}`,
        ),
      50,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const pac = {
      ...defaultNetwork,
      mode: 'pac' as const,
      pacUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/proxy.pac`,
    };
    for (let cycle = 0; cycle < 3; cycle++) {
      port = 18081 + cycle;
      await applyBrowserNetwork(ses, pac);
      assert.equal(
        await ses.resolveProxy('https://example.invalid'),
        `PROXY 127.0.0.1:${port}`,
        'delayed PAC fetch must survive applying settings',
      );
      const before = requests;
      port = 18091 + cycle;
      await applyBrowserNetwork(ses, pac);
      assert.equal(
        await ses.resolveProxy('https://example.invalid'),
        `PROXY 127.0.0.1:${port}`,
        'reapplying the same PAC URL must reload changed script contents',
      );
      assert.ok(
        requests > before,
        'PAC reapplication fetched the script again',
      );
      await applyBrowserNetwork(ses, { ...defaultNetwork, mode: 'direct' });
      assert.equal(await ses.resolveProxy('https://example.invalid'), 'DIRECT');
    }
  } finally {
    await applyBrowserNetwork(ses, defaultNetwork);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  console.log(
    'PASS system/direct/manual/PAC network configuration, explicit integrated sign-in domains, and unsafe configuration refusal',
  );
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
