import type { Session } from 'electron';

/**
 * Site capability policy.
 *
 * Deny by default. Only capabilities that grant no access to the user, their
 * data or their devices are auto-granted; everything else — camera, microphone,
 * screen capture, geolocation, clipboard reads, device access — is refused
 * until there is an origin-scoped prompt to ask with.
 *
 * The set is an allowlist rather than a denylist so that a permission added by
 * a future Chromium arrives denied instead of granted. That is the whole point:
 * the previous denylist named six permissions and silently allowed the rest,
 * `media` included.
 */
export const AUTO_GRANT_PERMISSIONS = new Set([
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'clipboard-sanitized-write',
]);

export function permissionAllowed(permission: string): boolean {
  return AUTO_GRANT_PERMISSIONS.has(permission);
}

/** Origin and permission pairs already reported, so a polling page says it once. */
const reported = new Set<string>();

/**
 * Reports a refusal, at most once per origin and permission.
 *
 * The policy is unchanged - these capabilities are still denied - but saying so
 * on every call buried the console. `permissions.query()` is a passive state
 * read that pages poll continuously: one Google tab produced seventy `media`
 * lines in a single run, which is noise that hides the one denial somebody
 * actually wants to see.
 *
 * So only genuine requests are reported, and only the first of each kind. The
 * set forgets itself once it grows past a session's worth of origins: this is a
 * diagnostic, not an audit log, and an audit log would need to live somewhere
 * better than a console.
 */
function reportDenial(permission: string, origin: string | undefined): void {
  const key = `${origin ?? '?'}|${permission}`;
  if (reported.has(key)) return;
  if (reported.size > 500) reported.clear();
  reported.add(key);
  console.warn(`[security] denied "${permission}" to ${origin || 'an unknown origin'}`);
}

/**
 * Applies the capability policy to a session.
 *
 * Both handlers are required. The request handler answers `getUserMedia()` and
 * friends; the check handler answers `permissions.query()` and decides whether
 * an API is exposed at all. With only the first, a denied capability can still
 * report itself as granted.
 */
export function applyPermissionPolicy(ses: Session): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const allowed = permissionAllowed(permission);
    if (!allowed) reportDenial(permission, details?.requestingUrl ?? wc?.getURL());
    callback(allowed);
  });

  // Deliberately silent. This answers `permissions.query()`, which is a page
  // asking what the answer *would* be rather than asking for anything, and
  // pages poll it on a timer.
  ses.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission));

  // Device pickers (WebUSB, WebHID, Web Serial, Bluetooth) never resolve to a
  // device: there is no UI here for choosing one, and choosing silently is worse.
  ses.setDevicePermissionHandler(() => false);
  ses.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));
}
