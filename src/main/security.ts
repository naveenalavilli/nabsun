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

export function permissionAllowed(permission: string, origin?: string): boolean {
  if (AUTO_GRANT_PERMISSIONS.has(permission)) return true;
  console.warn(`[security] denied "${permission}" to ${origin || 'an unknown origin'}`);
  return false;
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
    callback(permissionAllowed(permission, details?.requestingUrl ?? wc?.getURL()));
  });

  ses.setPermissionCheckHandler((_wc, permission, origin) =>
    permissionAllowed(permission, origin));

  // Device pickers (WebUSB, WebHID, Web Serial, Bluetooth) never resolve to a
  // device: there is no UI here for choosing one, and choosing silently is worse.
  ses.setDevicePermissionHandler(() => false);
  ses.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));
}
