import { dialog, type WebContents } from 'electron';
import { JsonStore } from './store';

export type SiteCapability =
  | 'camera'
  | 'microphone'
  | 'location'
  | 'notifications'
  | 'clipboard-read';
interface SiteDecision {
  origin: string;
  capability: SiteCapability;
  allowed: boolean;
}
interface PermissionFile {
  decisions: SiteDecision[];
}
export type PermissionPrompt = (
  origin: string,
  capabilities: SiteCapability[],
) => Promise<'once' | 'remember' | 'deny'>;
const valid = new Set<SiteCapability>([
  'camera',
  'microphone',
  'location',
  'notifications',
  'clipboard-read',
]);
function originOf(url: string) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Native prompts have no tool/renderer IPC through which an agent can answer. */
export class SitePermissions {
  private store = new JsonStore<PermissionFile>('site-permissions.json', {
    decisions: [],
  });
  private pending = new Set<string>();
  constructor(
    private prompt: PermissionPrompt = async (origin, capabilities) => {
      const result = await dialog.showMessageBox({
        type: 'question',
        title: 'Site permission',
        message: `Allow ${origin} to use ${capabilities.join(' and ')}?`,
        detail:
          'Only allow this for a website you trust. You can revoke remembered choices in Settings.',
        buttons: ['Block', 'Allow once', 'Always allow on this site'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 2
        ? 'remember'
        : result.response === 1
          ? 'once'
          : 'deny';
    },
  ) {}
  list() {
    const decisions = this.store.get().decisions;
    return Array.isArray(decisions)
      ? decisions.filter(
          (item) =>
            item &&
            typeof item.origin === 'string' &&
            originOf(item.origin) === item.origin &&
            valid.has(item.capability) &&
            typeof item.allowed === 'boolean',
        )
      : [];
  }
  revoke(origin?: string) {
    this.store.commit({
      decisions: origin
        ? this.list().filter((item) => item.origin !== origin)
        : [],
    });
  }
  allowed(origin: string, capability: SiteCapability) {
    return (
      this.list().find(
        (item) => item.origin === origin && item.capability === capability,
      )?.allowed === true
    );
  }
  async request(
    wc: WebContents | null,
    requestingUrl: string,
    capabilities: SiteCapability[],
  ) {
    const origin = originOf(requestingUrl);
    if (
      !wc ||
      wc.isDestroyed() ||
      !origin ||
      !capabilities.length ||
      capabilities.some((capability) => !valid.has(capability))
    )
      return false;
    // Cross-origin subframes cannot borrow top-level stored authority.
    if (originOf(wc.getURL()) !== origin) return false;
    const known = this.list().filter((item) => item.origin === origin);
    if (
      capabilities.some((capability) =>
        known.some((item) => item.capability === capability && !item.allowed),
      )
    )
      return false;
    const missing = capabilities.filter(
      (capability) =>
        !known.some((item) => item.capability === capability && item.allowed),
    );
    if (!missing.length) return true;
    const key = origin + '|' + [...missing].sort().join(',');
    if (this.pending.has(key)) return false;
    this.pending.add(key);
    try {
      const decision = await this.prompt(origin, missing);
      if (wc.isDestroyed() || originOf(wc.getURL()) !== origin) return false;
      if (decision !== 'once') {
        const decisions = this.list().filter(
          (item) =>
            item.origin !== origin || !missing.includes(item.capability),
        );
        this.store.commit({
          decisions: [
            ...decisions,
            ...missing.map((capability) => ({
              origin,
              capability,
              allowed: decision === 'remember',
            })),
          ].slice(-1000),
        });
      }
      return decision !== 'deny';
    } finally {
      this.pending.delete(key);
    }
  }
}
