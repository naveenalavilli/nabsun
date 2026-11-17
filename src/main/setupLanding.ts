export const SETUP_LANDING_URL = 'https://nabsun.com/';

interface LandingTab {
  id: string;
  url: string;
}

interface LandingTabs {
  all: LandingTab[];
  activate(id: string): void;
  create(url: string): LandingTab;
}

/**
 * Put the product site behind first-run/update setup without replacing a
 * restored page. Reuse the exact landing tab when it already exists so an
 * unfinished confirmation cannot accumulate duplicates across launches.
 */
export function showSetupLanding(tabs: LandingTabs): LandingTab {
  const existing = tabs.all.find(tab => {
    try {
      const url = new URL(tab.url);
      return url.protocol === 'https:'
        && (url.hostname === 'nabsun.com' || url.hostname === 'www.nabsun.com')
        && (url.pathname === '/' || url.pathname === '')
        && !url.search
        && !url.hash;
    } catch { return false; }
  });
  if (existing) {
    tabs.activate(existing.id);
    return existing;
  }
  return tabs.create(SETUP_LANDING_URL);
}
