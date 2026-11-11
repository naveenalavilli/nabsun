import type { Element, Document } from '@xmldom/xmldom';
import type { OfficeJob, WordParagraph } from '../../shared/office';
import { W, R, P, CT, XML, xml, readXml, putXml, pack, openOffice, elements, safeText, type Parts } from './package';

function paragraphContents(paragraph: Element) {
  let text = '';
  const spans: { node: Element; start: number; end: number }[] = [];
  function visit(node: Element) {
    if (node !== paragraph && node.namespaceURI === W && node.localName === 'p') return;
    if (node.namespaceURI === W && node.localName === 't') {
      const value = node.textContent ?? '';
      spans.push({ node, start: text.length, end: text.length + value.length });text += value;return;
    }
    if (node.namespaceURI === W && ['br', 'cr', 'tab'].includes(node.localName ?? '')) { text += node.localName === 'tab' ? '\t' : '\n';return; }
    for (const child of Array.from(node.childNodes)) if (child.nodeType === 1) visit(child as Element);
  }
  visit(paragraph);
  return { text, spans };
}
function appendParagraph(document: Document, paragraph: WordParagraph) {
  const text = safeText(paragraph?.text, 16000), style = paragraph.style ?? 'normal';
  if (!['normal', 'title', 'heading1', 'heading2'].includes(style)) throw Error('Choose normal, title, heading1 or heading2 for a paragraph.');
  const p = document.createElementNS(W, 'w:p');
  if (style !== 'normal') {
    const props = document.createElementNS(W, 'w:pPr'), keep = document.createElementNS(W, 'w:keepNext');
    const named=document.createElementNS(W,'w:pStyle');named.setAttributeNS(W,'w:val',style==='title'?'Title':style==='heading1'?'Heading1':'Heading2');
    props.appendChild(named);props.appendChild(keep);
    if(style!=='title'){const level=document.createElementNS(W,'w:outlineLvl');level.setAttributeNS(W,'w:val',style==='heading1'?'0':'1');props.appendChild(level)}
    p.appendChild(props);
  }
  const run = document.createElementNS(W, 'w:r');
  if (style !== 'normal') {
    const props = document.createElementNS(W, 'w:rPr'), bold = document.createElementNS(W, 'w:b'), size = document.createElementNS(W, 'w:sz');
    size.setAttributeNS(W, 'w:val', style === 'title' ? '40' : style === 'heading1' ? '32' : '26');
    props.appendChild(bold);props.appendChild(size);run.appendChild(props);
  }
  text.split('\n').forEach((line, index) => {
    if (index) run.appendChild(document.createElementNS(W, 'w:br'));
    const node = document.createElementNS(W, 'w:t');node.setAttributeNS(XML, 'xml:space', 'preserve');node.textContent = line;run.appendChild(node);
  });
  p.appendChild(run);return p;
}
function append(document: Document, paragraphs: WordParagraph[]) {
  if (!Array.isArray(paragraphs) || paragraphs.length > 1000) throw Error('Use at most 1000 paragraphs.');
  const body = elements(document, W, 'body')[0];
  if (!body) throw Error('The Word document body is missing.');
  const section = Array.from(body.childNodes).find(node => node.nodeType === 1 && (node as Element).namespaceURI === W && (node as Element).localName === 'sectPr');
  for (const paragraph of paragraphs) body.insertBefore(appendParagraph(document, paragraph), section ?? null);
}
function replace(document: Document, oldText: string, newText: string, all: boolean) {
  safeText(oldText, 4000);safeText(newText, 16000);
  if (!oldText || /[\r\n\t]/.test(oldText + newText)) throw Error('Text replacements must stay within a paragraph and cannot insert tabs or newlines. Append paragraphs for new sections.');
  const matches: { paragraph: Element; start: number }[] = [];
  for (const paragraph of elements(document, W, 'p')) {
    const { text } = paragraphContents(paragraph);
    let start = text.indexOf(oldText);
    while (start >= 0) {
      for (let ancestor = paragraph.parentNode; ancestor?.nodeType === 1; ancestor = ancestor.parentNode) {
        const element = ancestor as Element;
        if (element.namespaceURI !== W) continue;
        if (['ins', 'del', 'moveFrom', 'moveTo'].includes(element.localName ?? ''))
          throw Error('This paragraph is inside tracked changes. Use an accepted-revisions copy.');
        if (element.localName === 'sdt' && elements(element, W, 'lock').some(lock => lock.getAttributeNS(W, 'val') !== 'unlocked'))
          throw Error('This paragraph is inside a locked content control. Use an unlocked copy.');
      }
      if (['fldChar', 'fldSimple', 'instrText', 'ins', 'del', 'moveFrom', 'moveTo'].some(name => elements(paragraph, W, name).length))
        throw Error('This text contains fields or tracked changes. Use a plain-text paragraph or an accepted-revisions copy.');
      matches.push({ paragraph, start });
      start = text.indexOf(oldText, start + oldText.length);
    }
  }
  if (!matches.length) throw Error('The exact text was not found. Read the document again.');
  if (!all && matches.length !== 1) throw Error('The text appears more than once. Use a unique phrase or explicitly request all matches.');
  for (const match of matches.reverse()) {
    const { spans } = paragraphContents(match.paragraph), end = match.start + oldText.length;
    let inserted = false;
    for (const span of spans) {
      if (span.end <= match.start || span.start >= end) continue;
      const value = span.node.textContent ?? '';
      const left = value.slice(0, Math.max(0, match.start - span.start));
      const right = value.slice(Math.max(0, end - span.start));
      span.node.textContent = left + (inserted ? '' : newText) + right;
      span.node.setAttributeNS(XML, 'xml:space', 'preserve');inserted = true;
    }
  }
  return matches.length;
}
export function word(job: Extract<OfficeJob, { kind: 'word' }>, bytes?: Uint8Array) {
  if (job.action === 'create') {
    const parts: Parts = Object.create(null);
    parts['[Content_Types].xml'] = Buffer.from(`<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
    parts['_rels/.rels'] = Buffer.from(`<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`);
    parts['word/_rels/document.xml.rels'] = Buffer.from(`<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/></Relationships>`);
    parts['word/styles.xml'] = Buffer.from(`<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>`);
    const document = xml(`<w:document xmlns:w="${W}"><w:body><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
    if (!job.paragraphs?.length) throw Error('Add at least one paragraph to the new Word document.');
    append(document, job.paragraphs);putXml(parts, 'word/document.xml', document);
    return { bytes: pack(parts), summary: { paragraphsCreated: job.paragraphs.length } };
  }
  if (!bytes) throw Error('Read an existing Word file before editing it.');
  const { parts, main, document } = openOffice(bytes, 'word', job.action === 'edit');
  if (job.action === 'read') {
    const paragraphs = elements(document, W, 'p');
    const offset = Number.isFinite(job.offset) ? Math.max(0, Math.floor(job.offset!)) : 0;
    const limit = Number.isFinite(job.limit) ? Math.max(1, Math.min(100, Math.floor(job.limit!))) : 30;
    return { value: { kind: 'word', totalParagraphs: paragraphs.length, offset, paragraphs: paragraphs.slice(offset, offset + limit).map((paragraph, index) => {
      const text = paragraphContents(paragraph).text;
      return { index: offset + index, text: text.slice(0, 8000), truncated: text.length > 8000 };
    }) } };
  }
  for (const name of Object.keys(parts).filter(name => /(^|\/)settings\.xml$/.test(name)))
    if (elements(readXml(parts, name), W, 'documentProtection').some(node => ['1', 'true', 'on'].includes(node.getAttributeNS(W, 'enforcement') ?? '')))
      throw Error('This Word document is protected. Use an unprotected copy.');
  const replacements = job.replacements ?? [], additions = job.append ?? [];
  if (!Array.isArray(replacements) || replacements.length > 100 || !Array.isArray(additions) || (!replacements.length && !additions.length)) throw Error('Provide text replacements or paragraphs to append.');
  let count = 0;
  for (const change of replacements) count += replace(document, change.oldText, change.newText, change.all === true);
  append(document, additions);putXml(parts, main, document);
  return { bytes: pack(parts), summary: { textMatchesReplaced: count, paragraphsAppended: additions.length } };
}
