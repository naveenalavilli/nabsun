import fs from 'node:fs';
import path from 'node:path';

/** What the browser used to be called, and what it is called now. */
export const FORMER_APP_NAME = 'SmartBrowser';
export const FORMER_SCHEME = 'smart';
export const APP_NAME = 'Nabsun';
export const SCHEME = 'nabsun';

/**
 * Moves an existing profile from the old product name to the new one.
 *
 * Electron derives `userData` from the application name, so renaming the app
 * silently points it at an empty directory: saved passwords, bookmarks,
 * history, chat sessions, extensions and every logged-in cookie would appear to
 * have vanished, while still sitting on disk under the old name. A rebrand that
 * does this to its users is not a rebrand, it is data loss with a new icon.
 *
 * The whole directory is moved in one step, which carries the session partition
 * — and therefore the cookies — with it. A rename is atomic on the same volume;
 * a copy is the fallback for the case where it is not, and it leaves the
 * original in place rather than risking a half-move.
 *
 * Runs before any store is constructed, and does nothing if the new profile
 * already exists — the user has since used the renamed app, and their current
 * data is the data to keep.
 */
export function migrateProfile(appDataPath: string, userDataPath: string): string | null {
  const former = path.join(appDataPath, FORMER_APP_NAME);

  if (former === userDataPath) return null;
  if (!isDirectory(former)) return null;
  if (isDirectory(userDataPath)) return null;

  try {
    fs.renameSync(former, userDataPath);
  } catch {
    try {
      fs.cpSync(former, userDataPath, { recursive: true });
    } catch (err) {
      console.error('[rebrand] could not migrate the previous profile:', err);
      return null;
    }
  }

  // The session partition lives inside the profile and is named after the old
  // brand too. Without this the browser starts with an empty partition beside
  // the full one, which looks exactly like being signed out of everything.
  const partitions = path.join(userDataPath, 'Partitions');
  const oldPartition = path.join(partitions, FORMER_APP_NAME.toLowerCase());
  const newPartition = path.join(partitions, SCHEME);
  if (isDirectory(oldPartition) && !isDirectory(newPartition)) {
    try {
      fs.renameSync(oldPartition, newPartition);
    } catch (err) {
      console.error('[rebrand] could not migrate the session partition:', err);
    }
  }

  console.log(`[rebrand] moved the ${FORMER_APP_NAME} profile to ${userDataPath}`);
  return former;
}

/**
 * Rewrites internal URLs stored under the old scheme.
 *
 * A bookmark, a history entry or the homepage setting can hold `smart://home`,
 * saved before the rename. The old scheme still resolves (see
 * `registerInternalProtocol`), so nothing breaks without this — but leaving it
 * means the browser shows a name the product no longer has.
 */
export function rewriteInternalUrl(url: string): string {
  return url.startsWith(`${FORMER_SCHEME}://`)
    ? `${SCHEME}://${url.slice(FORMER_SCHEME.length + 3)}`
    : url;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
