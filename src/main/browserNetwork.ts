import type { Session, ProxyConfig } from 'electron';
export interface BrowserNetworkSettings {
  mode: 'system' | 'direct' | 'pac' | 'manual';
  pacUrl: string;
  proxy: string;
  integratedDomains: string;
}
export const defaultNetwork: BrowserNetworkSettings = {
  mode: 'system',
  pacUrl: '',
  proxy: '',
  integratedDomains: '',
};
export function validateNetwork(
  value: BrowserNetworkSettings,
): BrowserNetworkSettings {
  if (
    !value ||
    !['system', 'direct', 'pac', 'manual'].includes(value.mode) ||
    typeof value.pacUrl !== 'string' ||
    typeof value.proxy !== 'string' ||
    typeof value.integratedDomains !== 'string' ||
    value.pacUrl.length > 2000 ||
    value.proxy.length > 500 ||
    value.integratedDomains.length > 2000
  )
    throw Error('Invalid browser network settings.');
  const clean = {
    ...value,
    pacUrl: value.pacUrl.trim(),
    proxy: value.proxy.trim(),
    integratedDomains: value.integratedDomains.trim(),
  };
  if (clean.mode === 'pac') {
    const url = new URL(clean.pacUrl);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw Error('Use an HTTP(S) PAC URL without credentials.');
  }
  if (clean.mode === 'manual') {
    const url = new URL('http://' + clean.proxy);
    if (
      !url.hostname ||
      !/:\d+$/.test(clean.proxy) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      clean.proxy.includes('://')
    )
      throw Error('Enter a proxy as host:port, without credentials.');
  }
  if (clean.integratedDomains) {
    const domains = clean.integratedDomains
      .split(',')
      .map((domain) => domain.trim());
    if (
      domains.length > 30 ||
      domains.some(
        (domain) =>
          !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(
            domain,
          ),
      )
    )
      throw Error(
        'Enter specific sign-in domains separated by commas. A global wildcard is not allowed.',
      );
    clean.integratedDomains = domains.join(',');
  }
  return clean;
}
export async function applyBrowserNetwork(
  ses: Session,
  value: BrowserNetworkSettings,
) {
  const config = validateNetwork(value);
  const proxy: ProxyConfig =
    config.mode === 'pac'
      ? { mode: 'pac_script', pacScript: config.pacUrl }
      : config.mode === 'manual'
        ? { mode: 'fixed_servers', proxyRules: config.proxy }
        : { mode: config.mode };
  // Close old sockets before changing configuration: doing so afterwards can
  // cancel the PAC fetch started by setProxy and leave resolution empty.
  await ses.closeAllConnections();
  await ses.setProxy(proxy);
  if (config.mode === 'pac') await ses.forceReloadProxyConfig();
  ses.allowNTLMCredentialsForDomains(config.integratedDomains);
}
