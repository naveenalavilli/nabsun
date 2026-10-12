import type { UpdateStatus } from '../shared/updates';

export const RELEASE_PAGE = 'https://github.com/naveenalavilli/nabsun/releases/latest';
const ENDPOINT = 'https://api.github.com/repos/naveenalavilli/nabsun/releases/latest';

function version(value: string): number[] | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\da-zA-Z.-]+)?$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isNewerRelease(candidate: string, current: string): boolean {
  const next = version(candidate);
  // A stable release also supersedes a prerelease of the same version.
  const currentCore = current.split('+')[0];
  const installed = version(currentCore.split('-')[0]);
  if (!next || !installed) throw new Error('Invalid release version');
  for (let i = 0; i < 3; i++) {
    if (next[i] !== installed[i]) return next[i] > installed[i];
  }
  return currentCore.includes('-');
}

export class UpdateChecker {
  private pending?: Promise<UpdateStatus>;
  private cached?: UpdateStatus;
  private checkedAt = 0;

  constructor(private readonly currentVersion: string, private readonly request: typeof fetch = fetch,
    private readonly now = Date.now, private readonly timeoutMs = 10_000) {}

  check(manual = false): Promise<UpdateStatus> {
    if (this.pending) return this.pending;
    // Bound manual retries as well as automatic checks to avoid API throttling.
    const ttl = manual || this.cached?.state === 'error' ? 30_000 : 60 * 60_000;
    if (this.cached && this.now() - this.checkedAt < ttl) return Promise.resolve(this.cached);
    this.pending = this.load().then(status => {
      this.cached = status;
      this.checkedAt = this.now();
      return status;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async load(): Promise<UpdateStatus> {
    const base = { currentVersion: this.currentVersion };
    try {
      const response = await this.request(ENDPOINT, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error', credentials: 'omit',
      });
      if (!response.ok) throw new Error('Release lookup failed');
      const release = await response.json();
      if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string') {
        throw new Error('Invalid stable release');
      }
      return { ...base, state: isNewerRelease(release.tag_name, this.currentVersion) ? 'available' : 'current',
        latestVersion: release.tag_name.replace(/^v/, '') };
    } catch {
      return { ...base, state: 'error' };
    }
  }
}
