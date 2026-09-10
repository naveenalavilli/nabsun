import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Session } from 'electron';
import { FORMER_SCHEME, SCHEME } from './rebrand';

/**
 * Escapes a value being substituted into HTML *text*.
 *
 * Most tokens are version strings and counts, but `MODEL` is free text the user
 * types into Settings and `USER_DATA` is a path — both reach the page as raw
 * markup otherwise.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escapes a value being substituted into a `<script>` block.
 *
 * The contents of a script element are *raw text*: the parser does not decode
 * entities there. HTML-escaping `HISTORY_JSON` therefore turned every quote
 * into `&quot;`, `JSON.parse` threw, and the history page rendered zero rows
 * while the home page silently showed no tiles. Both looked like empty data
 * rather than a bug, and the suite missed it because its fixture was `[]` —
 * which has no quotes to corrupt.
 *
 * The danger in a script block is not `"` but a literal `</script`, which ends
 * the element early. Escaping the angle brackets as JSON `\uXXXX` sequences
 * prevents that and still parses back to the original characters, because these
 * only ever occur inside JSON string literals.
 */
function escapeForScript(value: string): string {
  return value
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    // U+2028/U+2029 are valid in JSON but terminate a line in JS source.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Character ranges that sit inside a `<script>` element's raw text. */
function scriptRanges(html: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const open of html.matchAll(/<script\b[^>]*>/gi)) {
    const start = (open.index ?? 0) + open[0].length;
    const end = html.toLowerCase().indexOf('</script', start);
    ranges.push([start, end === -1 ? html.length : end]);
  }
  return ranges;
}

const sha256 = (text: string): string =>
  `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/**
 * Builds a strict CSP for one of our own pages.
 *
 * Every renderer without a Content-Security-Policy makes Electron log a
 * security warning, and `nabsun://home` is loaded by every new tab, so the
 * console filled with them. The pages carry small inline scripts and styles, so
 * the usual fix would be `'unsafe-inline'` — which silences the warning by
 * granting exactly what it warns about.
 *
 * Instead each inline block is hashed *after* token substitution, so the policy
 * permits precisely the code we shipped and nothing else. It needs no page
 * restructuring and cannot drift: edit a page and its hash follows.
 */
function policyFor(html: string): string {
  const hashes = (tag: 'script' | 'style'): string[] =>
    [...html.matchAll(new RegExp(`<${tag}(?![^>]*\\ssrc=)[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))]
      .map((m) => sha256(m[1]))
      .filter((h, i, all) => all.indexOf(h) === i);

  const script = hashes('script');
  const style = hashes('style');
  return [
    "default-src 'none'",
    `script-src ${script.length ? script.join(' ') : "'none'"}`,
    `style-src ${style.length ? style.join(' ') : "'none'"}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Serves the built-in pages (new tab, about, history, error) from the bundle.
 *
 * This must be registered on the *tab partition's* session, not the global
 * `protocol` module: that one only covers the default session, so tabs running
 * in a named partition would see `nabsun://` as an unknown scheme and hand it to
 * the OS ("We can't open this 'nabsun' link").
 */
export function registerInternalProtocol(
  ses: Session,
  tokens: () => Record<string, string>,
  pagesRoot = path.join(__dirname, '..', 'pages'),
): void {
  const serve = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const name = `${url.hostname || 'home'}${url.pathname === '/' ? '' : url.pathname}`;
    const file = path.join(pagesRoot, `${name.replace(/[^a-z0-9/_-]/gi, '')}.html`);

    // Keep the resolved path inside the pages directory.
    if (!file.startsWith(pagesRoot) || !fs.existsSync(file)) {
      return new Response('<h1>Page not found</h1>', {
        status: 404,
        headers: {
          'content-type': 'text/html',
          'content-security-policy': "default-src 'none'; style-src 'none'",
        },
      });
    }

    // Internal pages have no IPC bridge, so live values are substituted here
    // rather than fetched by the page.
    let html = fs.readFileSync(file, 'utf8');
    if (html.includes('{{')) {
      const values = tokens();
      // Escaping depends on where the placeholder sits. A token in markup needs
      // HTML escaping; the same escaping inside a <script> block corrupts it.
      const inScript = scriptRanges(html);
      html = html.replace(/\{\{(\w+)\}\}/g, (match, key: string, offset: number) => {
        const value = values[key];
        if (value === undefined) return match;
        const scripted = inScript.some(([from, to]) => offset >= from && offset < to);
        return scripted ? escapeForScript(value) : escapeHtml(value);
      });
    }
    return new Response(html, {
      headers: {
        'content-type': 'text/html',
        // Hashed after substitution, so the policy covers what is actually served.
        'content-security-policy': policyFor(html),
      },
    });
  };

  ses.protocol.handle(SCHEME, serve);
  // The former scheme, kept working for URLs saved before the rename — a
  // bookmark or a restored session holding `smart://home` should open, not
  // fail. Both resolve to the same pages; only the new one is ever written.
  ses.protocol.handle(FORMER_SCHEME, serve);
}
