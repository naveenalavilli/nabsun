import fs from 'node:fs';
import path from 'node:path';

/** What the browser used to be called, and what it is called now. */
export const FORMER_APP_NAME = 'SmartBrowser';
export const FORMER_SCHEME = 'smart';
export const APP_NAME = 'Nabsun';
export const SCHEME = 'nabsun';

/** Written into the new profile once a migration has actually finished. */
export const MIGRATION_MARKER = '.migrated-from-smartbrowser';

/** Where a copy is assembled, so an interrupted one is never mistaken for a profile. */
const STAGING_SUFFIX = '.migrating';

/**
 * Moves an existing profile from the old product name to the new one.
 *
 * Electron derives `userData` from the application name, so renaming the app
 * silently points it at an empty directory: saved passwords, bookmarks,
 * history, chat sessions, extensions and every logged-in cookie would appear to
 * have vanished, while still sitting on disk under the old name. A rebrand that
 * does this to its users is not a rebrand, it is data loss with a new icon.
 *
 * This must run before Electron initialises the profile, and it must not treat
 * the destination existing as proof that migration happened. Those are the same
 * bug seen from two sides: Electron creates `userData` as an empty directory
 * during startup, so a guard that skipped when the destination existed skipped
 * *always*, and no user was ever migrated. The completion marker is what says
 * migration finished; the directory being there says nothing at all.
 *
 * A copy is assembled under a staging name and only then moved into place, so
 * an interrupted run leaves no half-profile to be mistaken for a real one and
 * the next launch simply starts again.
 */
export function migrateProfile(appDataPath: string, userDataPath: string): string | null {
  const former = path.join(appDataPath, FORMER_APP_NAME);
  const staging = `${userDataPath}${STAGING_SUFFIX}`;

  if (former === userDataPath) return null;
  // Already done. This, not the directory's existence, is the real question.
  if (fileExists(path.join(userDataPath, MIGRATION_MARKER))) return null;
  if (!isDirectory(former)) return null;

  // A staging directory left by a run that died partway through is garbage:
  // its contents are an unknown fraction of the source.
  if (isDirectory(staging)) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      console.error('[rebrand] could not clear an interrupted migration:', err);
      return null;
    }
  }

  // A destination with real content belongs to someone who has used the
  // renamed app. Two live profiles must not be merged, so leave it alone and
  // stop asking on every launch.
  if (isDirectory(userDataPath) && hasContent(userDataPath)) {
    markMigrated(userDataPath);
    return null;
  }

  try {
    // Rename cannot land on an existing directory, and Electron may already
    // have made an empty one.
    if (isDirectory(userDataPath)) fs.rmdirSync(userDataPath);
    fs.renameSync(former, userDataPath);
  } catch {
    // A different volume, or the directory was not empty after all. Copy into
    // staging and swap it in, leaving the original untouched either way.
    try {
      fs.cpSync(former, staging, { recursive: true });
      if (isDirectory(userDataPath)) fs.rmdirSync(userDataPath);
      fs.renameSync(staging, userDataPath);
    } catch (err) {
      console.error('[rebrand] could not migrate the previous profile:', err);
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
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

  markMigrated(userDataPath);
  console.log(`[rebrand] moved the ${FORMER_APP_NAME} profile to ${userDataPath}`);
  return former;
}

function markMigrated(userDataPath: string) {
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(
      path.join(userDataPath, MIGRATION_MARKER),
      `${FORMER_APP_NAME} -> ${APP_NAME} at ${new Date().toISOString()}
`,
      'utf8',
    );
  } catch (err) {
    // Without the marker the next launch re-checks and finds a populated
    // destination, which is the same decision by a slower route.
    console.error('[rebrand] could not record migration completion:', err);
  }
}

/** Anything at all besides our own marker. */
function hasContent(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => name !== MIGRATION_MARKER);
  } catch {
    return false;
  }
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
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
