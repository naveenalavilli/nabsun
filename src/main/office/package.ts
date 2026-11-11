import { inflateSync, zipSync } from 'fflate';
import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import path from 'node:path';

export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const P = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const XML = 'http://www.w3.org/XML/1998/namespace';
export type Parts = Record<string, Uint8Array>;
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let n = 0; n < 8; n++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** Validate central/local headers and sizes before bounded DEFLATE allocation. Never extracts to disk. */
export function unpack(bytes: Uint8Array): Parts {
  const data = Buffer.from(bytes);
  if (data.length > 20 * 1024 * 1024) throw Error('Office files are limited to 20 MB.');
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--)
    if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break; }
  if (end < 0) throw Error('Choose an unencrypted .docx or .xlsx file. This file is not a supported Office package.');
  const count = data.readUInt16LE(end + 10), size = data.readUInt32LE(end + 12), start = data.readUInt32LE(end + 16);
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || count !== data.readUInt16LE(end + 8) || count > 1000 || start + size !== end)
    throw Error('Multi-volume, ZIP64 or unusually large Office packages are not supported.');
  const parts: Parts = Object.create(null), seen = new Set<string>();
  let offset = start, total = 0;
  const spans: [number, number][] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) throw Error('Invalid Office ZIP directory.');
    const flags = data.readUInt16LE(offset + 8), method = data.readUInt16LE(offset + 10);
    const checksum = data.readUInt32LE(offset + 16), compressed = data.readUInt32LE(offset + 20), original = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28), extra = data.readUInt16LE(offset + 30), comment = data.readUInt16LE(offset + 32), local = data.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extra + comment > end || flags & 1 || ![0, 8].includes(method) || original > 8 * 1024 * 1024 || (total += original) > 64 * 1024 * 1024)
      throw Error('Encrypted or oversized Office content is not supported.');
    const nameBytes = data.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    const pieces = name.replace(/\/$/, '').split('/');
    if (!name || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || pieces.some(p => !p || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(p)) || seen.has(name.toLowerCase()))
      throw Error('Unsafe or duplicate Office package part.');
    seen.add(name.toLowerCase());
    if (local + 30 > start || data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 6) !== flags || data.readUInt16LE(local + 8) !== method)
      throw Error('Invalid Office ZIP member.');
    const localName = data.readUInt16LE(local + 26), localExtra = data.readUInt16LE(local + 28), payload = local + 30 + localName + localExtra;
    if (!data.subarray(local + 30, local + 30 + localName).equals(nameBytes) || payload + compressed > start || spans.some(([a, b]) => local < b && payload + compressed > a))
      throw Error('Overlapping or invalid Office ZIP members.');
    spans.push([local, payload + compressed]);
    const decoded = method === 0 ? data.subarray(payload, payload + compressed) : inflateSync(data.subarray(payload, payload + compressed), { out: new Uint8Array(original + 1) });
    if (decoded.length !== original || crc32(decoded) !== checksum) throw Error('Office package integrity check failed.');
    if (!name.endsWith('/')) parts[name] = new Uint8Array(decoded);
    offset += 46 + nameLength + extra + comment;
  }
  if (offset !== end) throw Error('Invalid Office ZIP directory size.');
  return parts;
}
export function pack(parts: Parts): Uint8Array {
  const values = Object.values(parts);
  if (values.length > 1000 || values.some(bytes => bytes.length > 8 * 1024 * 1024) || values.reduce((sum, bytes) => sum + bytes.length, 0) > 64 * 1024 * 1024)
    throw Error('The generated Office package exceeds the safe document limits.');
  const result = zipSync(parts, { level: 6 });
  if (result.length > 20 * 1024 * 1024) throw Error('The generated document exceeds 20 MB.');
  return result;
}
export function xml(text: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || text.length > 8 * 1024 * 1024) throw Error('Unsafe or oversized Office XML.');
  return new DOMParser({ onError: (_level, message) => { throw Error('Invalid Office XML: ' + message.slice(0, 150)); } }).parseFromString(text, 'application/xml');
}
export function readXml(parts: Parts, name: string): Document {
  if (!parts[name]) throw Error('A required Office package part is missing.');
  return xml(new TextDecoder('utf-8', { fatal: true }).decode(parts[name]));
}
export function putXml(parts: Parts, name: string, document: Document) {
  parts[name] = Buffer.from(new XMLSerializer().serializeToString(document), 'utf8');
}
export const elements = (document: Document | Element, namespace: string, name: string): Element[] => Array.from(document.getElementsByTagNameNS(namespace, name));
export const childElements = (element: Element): Element[] => Array.from(element.childNodes).filter(node => node.nodeType === 1) as Element[];
export function relationshipPart(part: string) { return path.posix.join(path.posix.dirname(part), '_rels', path.posix.basename(part) + '.rels'); }
export function related(parts: Parts, from: string, id?: string, kind?: string) {
  const rels = from ? relationshipPart(from) : '_rels/.rels';
  if (!parts[rels]) throw Error('Office relationships are missing.');
  const matches = elements(readXml(parts, rels), P, 'Relationship').filter(rel => id ? rel.getAttribute('Id') === id : rel.getAttribute('Type') === R + '/' + kind);
  if (matches.length !== 1) throw Error('The requested Office relationship is missing or ambiguous.');
  const rel = matches[0], raw = rel.getAttribute('Target') ?? '';
  if (rel.getAttribute('TargetMode') === 'External' || /[\\:#?\x00-\x1f]/.test(raw)) throw Error('External Office relationships are not followed.');
  const decoded = decodeURIComponent(raw), target = path.posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(path.posix.dirname(from), decoded));
  if (target.startsWith('../') || !parts[target]) throw Error('Office relationship points outside the package.');
  return target;
}
export function openOffice(bytes: Uint8Array, kind: 'word' | 'excel', editing = false) {
  const parts = unpack(bytes);
  if (Object.keys(parts).some(name => /vbaProject|(^|\/)activeX\//i.test(name))) throw Error('Macro and ActiveX documents are not supported.');
  if (editing && Object.keys(parts).some(name => name.startsWith('_xmlsignatures/'))) throw Error('Editing a signed document would invalidate its signature. Use an unsigned copy.');
  const main = related(parts, '', undefined, 'officeDocument');
  const type = elements(readXml(parts, '[Content_Types].xml'), CT, 'Override').find(item => item.getAttribute('PartName') === '/' + main)?.getAttribute('ContentType');
  const expected = kind === 'word' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  if (type !== expected) throw Error('Use a standard, unencrypted .docx or .xlsx document.');
  const document = readXml(parts, main);
  if (document.documentElement?.namespaceURI !== (kind === 'word' ? W : S)) throw Error('This Office XML variant is not supported.');
  return { parts, main, document };
}
export const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export function safeText(text: unknown, max = 32767): string {
  if (typeof text !== 'string' || text.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(text)) throw Error('Use bounded text without XML control characters.');
  for (const character of text) if (character.length === 1 && /[\ud800-\udfff]/.test(character)) throw Error('Text contains an invalid Unicode surrogate.');
  return text;
}
