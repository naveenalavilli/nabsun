/**
 * A small Markdown renderer that builds DOM nodes directly.
 *
 * Model output is untrusted text — it can contain anything a web page contained,
 * including markup crafted to be executed. Nothing here ever assigns to
 * innerHTML: text reaches the document only through textContent, and the only
 * attribute ever set from model output is an href that has been scheme-checked.
 */

const SAFE_LINK = /^(https?:|mailto:|smart:)/i;

export function renderMarkdown(source: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = /^\s*```(\w+)?\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence[1]) code.dataset.lang = fence[1];
      code.textContent = body.join('\n');
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const el = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      appendInline(el, heading[2]);
      frag.appendChild(el);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      frag.appendChild(document.createElement('hr'));
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const quote = document.createElement('blockquote');
      quote.appendChild(renderMarkdown(body.join('\n')));
      frag.appendChild(quote);
      continue;
    }

    // Table (header row, separator row, then body rows)
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const table = document.createElement('table');
      const head = document.createElement('tr');
      for (const cell of splitRow(line)) {
        const th = document.createElement('th');
        appendInline(th, cell);
        head.appendChild(th);
      }
      table.appendChild(head);
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const tr = document.createElement('tr');
        for (const cell of splitRow(lines[i])) {
          const td = document.createElement('td');
          appendInline(td, cell);
          tr.appendChild(td);
        }
        table.appendChild(tr);
        i++;
      }
      frag.appendChild(table);
      continue;
    }

    // Lists — consecutive items of the same kind, with lazy continuation lines
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[2]) !== ordered) break;
        const parts = [m[3]];
        i++;
        while (i < lines.length && lines[i].trim() && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])) {
          parts.push(lines[i].trim());
          i++;
        }
        const li = document.createElement('li');
        appendInline(li, parts.join(' '));
        list.appendChild(li);
      }
      frag.appendChild(list);
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    const p = document.createElement('p');
    appendInline(p, para.join(' '));
    frag.appendChild(p);
  }

  return frag;
}

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

/** Inline spans: code, bold, italic, links. Everything else stays literal text. */
function appendInline(parent: HTMLElement, text: string): void {
  // Code spans are extracted first so their contents are never re-parsed.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];

    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else if (token.startsWith('*') || token.startsWith('_')) {
      const em = document.createElement('em');
      em.textContent = token.slice(1, -1);
      parent.appendChild(em);
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      parent.appendChild(makeLink(linkMatch[2], linkMatch[1]));
    } else {
      parent.appendChild(makeLink(token, token));
    }
    last = match.index + token.length;
  }

  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

/**
 * Links open in a new browser tab rather than navigating the chrome itself —
 * letting the shell renderer navigate would replace the entire browser UI.
 */
function makeLink(href: string, label: string): Node {
  if (!SAFE_LINK.test(href)) return document.createTextNode(label);
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = label;
  a.title = href;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    void window.nabsun.tabs.create(href);
  });
  return a;
}
