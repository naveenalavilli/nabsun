export interface WordParagraph { text: string; style?: 'normal' | 'title' | 'heading1' | 'heading2' }
export type ExcelValue = string | number | boolean | null | { formula: string };
export type OfficeJob =
  | { kind: 'word'; action: 'read'; offset?: number; limit?: number }
  | { kind: 'word'; action: 'create'; paragraphs: WordParagraph[] }
  | { kind: 'word'; action: 'edit'; replacements?: { oldText: string; newText: string; all?: boolean }[]; append?: WordParagraph[] }
  | { kind: 'excel'; action: 'read'; sheet?: string; range?: string }
  | { kind: 'excel'; action: 'create'; sheets: { name: string; rows: ExcelValue[][]; header?: boolean }[] }
  | { kind: 'excel'; action: 'edit'; sheet: string; changes: { cell: string; value: ExcelValue }[] };
