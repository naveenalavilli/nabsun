export const BLOCKED_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googletagservices.com',
  'google-analytics.com',
  'googletagmanager.com',
  'adservice.google.com',
  'scorecardresearch.com',
  'adnxs.com',
  'criteo.com',
  'taboola.com',
  'outbrain.com',
  'quantserve.com',
  'moatads.com',
];

export function isBlockedHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return BLOCKED_HOSTS.some(
      (blocked) => host === blocked || host.endsWith(`.${blocked}`),
    );
  } catch {
    return true;
  }
}
