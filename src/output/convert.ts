import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { marked, Token, Tokens } from 'marked';
import { OutputFormat } from '../common/types';

/** Arabic, Hebrew, Persian… — decides right-to-left layout. */
const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-﻿]/g;
export const isRtl = (text: string) => (text.match(RTL_CHARS)?.length ?? 0) > (text.match(/[A-Za-z]/g)?.length ?? 0);

export interface ConvertInput {
  /** Markdown (or plain) text from the previous step. */
  text: string;
  /** Structured output (JSON) from the previous step, if any. */
  structured?: unknown;
  title?: string;
}

// ---------- markdown helpers ----------

interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

/** Flattens marked inline tokens into styled runs. */
function runs(tokens: Token[] | undefined, style: Omit<Run, 'text'> = {}): Run[] {
  const out: Run[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...runs((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...runs((t as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case 'del':
        out.push(...runs((t as Tokens.Del).tokens, style));
        break;
      case 'codespan':
        out.push({ ...style, text: decode((t as Tokens.Codespan).text), code: true });
        break;
      case 'link':
        out.push(...runs((t as Tokens.Link).tokens, { ...style, link: (t as Tokens.Link).href }));
        break;
      case 'br':
        out.push({ ...style, text: '\n' });
        break;
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...runs(tt.tokens, style));
        else out.push({ ...style, text: decode(tt.text) });
        break;
      }
      default:
        if ('text' in t && typeof (t as any).text === 'string') out.push({ ...style, text: decode((t as any).text) });
    }
  }
  return out;
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const plain = (tokens?: Token[]) => runs(tokens).map((r) => r.text).join('');

/** Agents often wrap a whole answer in one ``` fence; unwrap it so it renders as a document. */
function unwrapFence(md: string) {
  const m = md.trim().match(/^```(?:markdown|md)?\n([\s\S]*)\n```$/);
  return m ? m[1] : md;
}

export function titleOf(input: ConvertInput): string {
  if (input.title?.trim()) return input.title.trim();
  const h = marked.lexer(unwrapFence(input.text)).find((t) => t.type === 'heading') as Tokens.Heading | undefined;
  return h ? plain(h.tokens) : 'Document';
}

/** Rows for spreadsheet-like formats: a JSON array of objects, else markdown tables, else lines. */
function tables(input: ConvertInput): Array<{ name: string; rows: string[][] }> {
  const s = input.structured ?? tryJson(input.text);
  const arr = Array.isArray(s) ? s : s && typeof s === 'object' ? Object.values(s as object).find(Array.isArray) : undefined;
  if (Array.isArray(arr) && arr.length && arr.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    const cols = [...new Set(arr.flatMap((r) => Object.keys(r)))];
    return [{ name: 'Data', rows: [cols, ...arr.map((r: any) => cols.map((c) => cell(r[c])))] }];
  }
  if (s && typeof s === 'object' && !Array.isArray(s)) {
    return [{ name: 'Data', rows: [['Field', 'Value'], ...Object.entries(s as object).map(([k, v]) => [k, cell(v)])] }];
  }
  const found = marked.lexer(unwrapFence(input.text)).filter((t) => t.type === 'table') as Tokens.Table[];
  if (found.length) {
    return found.map((t, i) => ({ name: `Table ${i + 1}`, rows: [t.header.map((h) => plain(h.tokens)), ...t.rows.map((r) => r.map((c) => plain(c.tokens)))] }));
  }
  return [{ name: 'Text', rows: [['Text'], ...input.text.split('\n').filter((l) => l.trim()).map((l) => [l])] }];
}

const cell = (v: unknown) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
function tryJson(t: string): unknown {
  const s = t.trim().replace(/^```(?:json)?\n?|```$/g, '');
  if (!/^[[{]/.test(s)) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// ---------- HTML / PDF ----------

/** Each block picks its own direction, so an Arabic line in an English document reads right to left (and vice versa). */
export const autoDir = (html: string) => html.replace(/<(p|li|h[1-6]|td|th|blockquote|dt|dd|figcaption)(\s[^>]*)?>/gi, (m, tag, attrs = '') => (/\sdir=/i.test(attrs) ? m : `<${tag}${attrs} dir="auto">`));

export const DOC_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  :root { --ink:#1b1f24; --muted:#5b6573; --line:#dfe3e8; --accent:#c4613f; }
  body { font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial, "Geeza Pro", "Arial Unicode MS", sans-serif; color: var(--ink); line-height: 1.55; font-size: 11pt; max-width: 820px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22pt; margin: 0 0 12px; letter-spacing: -0.01em; }
  h2 { font-size: 15pt; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
  h3 { font-size: 12.5pt; margin: 18px 0 6px; }
  p, li { margin: 6px 0; }
  a { color: var(--accent); }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 10pt; }
  th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: start; vertical-align: top; }
  th { background: #f4f1ee; }
  tr:nth-child(even) td { background: #fafafa; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 9.5pt; background: #f3f3f3; padding: 1px 4px; border-radius: 3px; }
  pre { background: #f6f6f6; padding: 10px 12px; border-radius: 6px; overflow-wrap: anywhere; white-space: pre-wrap; }
  pre code { background: none; padding: 0; }
  blockquote { margin: 10px 0; padding: 4px 14px; border-inline-start: 3px solid var(--accent); color: var(--muted); }
  hr { border: 0; border-top: 1px solid var(--line); margin: 18px 0; }
  .meta { color: var(--muted); font-size: 9pt; margin-bottom: 18px; }
`;

export function toHtml(input: ConvertInput): string {
  const md = unwrapFence(input.text);
  const title = titleOf(input);
  const rtl = isRtl(md);
  const body = autoDir(marked.parse(md, { async: false }) as string);
  const withTitle = /^\s*<h1/i.test(body) ? body : `<h1>${escape(title)}</h1>\n${body}`;
  return `<!doctype html><html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><!-- Content can come from the web through agents: never run its scripts (an alert() would also block PDF printing). --><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'"><title>${escape(title)}</title><style>${DOC_CSS}</style></head><body>${withTitle}<div class="meta">${new Date().toLocaleString()}</div></body></html>`;
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Locates a Chrome/Chromium binary for headless HTML → PDF. */
export function findChrome(configured?: string): string | null {
  const candidates = [
    configured,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const ab = join(homedir(), '.agent-browser', 'browsers');
  if (existsSync(ab)) {
    for (const v of readdirSync(ab).sort().reverse()) candidates.push(join(ab, v, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
  }
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}

async function htmlToPdf(html: string, outPath: string, chrome: string) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-canvas-pdf-'));
  try {
    const htmlPath = join(dir, 'doc.html');
    writeFileSync(htmlPath, html);
    // Own profile dir and mock keychain so it never touches (or waits on) the user's Chrome.
    const child = spawn(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--password-store=basic',
        '--use-mock-keychain',
        `--user-data-dir=${join(dir, 'profile')}`,
        '--no-pdf-header-footer',
        `--print-to-pdf=${outPath}`,
        `file://${htmlPath}`,
      ],
      { stdio: 'ignore' },
    );
    // Headless Chrome writes the PDF in a second or two but can linger for many more;
    // treat a PDF whose size has stopped changing as done, then stop Chrome.
    const deadline = Date.now() + 60_000;
    let last = -1;
    let exited = false;
    child.on('exit', () => (exited = true));
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      const size = existsSync(outPath) ? statSync(outPath).size : -1;
      if (size > 0 && size === last) break;
      if (exited && size <= 0) break;
      last = size;
    }
    if (!exited) child.kill('SIGKILL');
    if (!existsSync(outPath) || statSync(outPath).size === 0) throw new Error('Chrome did not produce a PDF');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- PowerPoint ----------

async function toPptx(input: ConvertInput, outPath: string) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  const md = unwrapFence(input.text);
  const rtl = isRtl(md);
  if (rtl) pptx.rtlMode = true;
  const align = rtl ? 'right' : 'left';
  const ACCENT = 'C4613F';
  const INK = '1B1F24';
  const title = titleOf(input);

  const cover = pptx.addSlide();
  cover.background = { color: 'F7F4F1' };
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: ACCENT } });
  cover.addText(title, { x: 0.8, y: 2.4, w: 11.5, h: 1.6, fontSize: 40, bold: true, color: INK, align, fontFace: 'Helvetica' });
  cover.addText(new Date().toLocaleDateString(), { x: 0.8, y: 4.1, w: 11.5, h: 0.5, fontSize: 16, color: '5B6573', align });

  type Item = { kind: 'bullet'; text: string; level: number; ordered?: boolean } | { kind: 'para'; text: string } | { kind: 'table'; rows: string[][] } | { kind: 'code'; text: string };
  const slides: Array<{ title: string; items: Item[] }> = [];
  let cur: { title: string; items: Item[] } | null = null;
  const ensure = () => (cur ??= (slides.push({ title, items: [] }), slides[slides.length - 1]));

  const walkList = (l: Tokens.List, level: number) => {
    for (const it of l.items) {
      const own = it.tokens.filter((t) => t.type !== 'list');
      ensure().items.push({ kind: 'bullet', text: own.map((t) => plain('tokens' in t ? (t as any).tokens : [t])).join(' ').trim(), level, ordered: l.ordered });
      for (const sub of it.tokens.filter((t) => t.type === 'list') as Tokens.List[]) walkList(sub, level + 1);
    }
  };
  for (const t of marked.lexer(md)) {
    if (t.type === 'heading') {
      const h = t as Tokens.Heading;
      if (h.depth === 1 && plain(h.tokens) === title && !slides.length) continue; // already on the cover
      if (h.depth <= 2 || !cur) {
        cur = { title: plain(h.tokens), items: [] };
        slides.push(cur);
      } else ensure().items.push({ kind: 'para', text: plain(h.tokens).toUpperCase() });
    } else if (t.type === 'list') walkList(t as Tokens.List, 0);
    else if (t.type === 'paragraph') ensure().items.push({ kind: 'para', text: plain((t as Tokens.Paragraph).tokens) });
    else if (t.type === 'table') {
      const tb = t as Tokens.Table;
      ensure().items.push({ kind: 'table', rows: [tb.header.map((h) => plain(h.tokens)), ...tb.rows.map((r) => r.map((c) => plain(c.tokens)))] });
    } else if (t.type === 'code') ensure().items.push({ kind: 'code', text: (t as Tokens.Code).text });
    else if (t.type === 'blockquote') ensure().items.push({ kind: 'para', text: plain((t as Tokens.Blockquote).tokens) });
  }

  const MAX_LINES = 9;
  for (const s of slides) {
    // Long sections are split over several slides instead of overflowing.
    const chunks: Item[][] = [[]];
    let lines = 0;
    for (const it of s.items) {
      const cost = it.kind === 'table' ? MAX_LINES : it.kind === 'code' ? Math.min(MAX_LINES, it.text.split('\n').length) : Math.ceil(it.text.length / 110) || 1;
      if (lines + cost > MAX_LINES && chunks[chunks.length - 1].length) {
        chunks.push([]);
        lines = 0;
      }
      chunks[chunks.length - 1].push(it);
      lines += cost;
    }
    chunks.forEach((items, i) => {
      const slide = pptx.addSlide();
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.12, fill: { color: ACCENT } });
      slide.addText(s.title + (chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''), { x: 0.6, y: 0.35, w: 12.1, h: 0.9, fontSize: 28, bold: true, color: INK, align, fontFace: 'Helvetica' });
      let y = 1.45;
      const textItems = items.filter((it) => it.kind === 'bullet' || it.kind === 'para');
      if (textItems.length) {
        const h = Math.min(5.6, textItems.reduce((a, it) => a + 0.45 * (Math.ceil((it as any).text.length / 110) || 1), 0) + 0.3);
        slide.addText(
          textItems.map((it) =>
            it.kind === 'bullet'
              ? { text: (it as any).text, options: { bullet: (it as any).ordered ? { type: 'number', indent: 22 } : { indent: 18 }, indentLevel: (it as any).level, breakLine: true, paraSpaceAfter: 6 } }
              : { text: (it as any).text, options: { breakLine: true, paraSpaceAfter: 8 } },
          ),
          { x: 0.7, y, w: 11.9, h, fontSize: 18, color: '2B3138', valign: 'top', align, fontFace: 'Helvetica' },
        );
        y += h + 0.1;
      }
      for (const it of items) {
        if (it.kind === 'table') {
          const [head, ...body] = it.rows;
          slide.addTable(
            [head.map((c) => ({ text: c, options: { bold: true, fill: { color: 'F4F1EE' } } })), ...body.map((r) => r.map((c) => ({ text: c })))],
            { x: 0.7, y, w: 11.9, fontSize: 13, color: INK, border: { type: 'solid', color: 'DFE3E8', pt: 1 }, align },
          );
          y += 0.45 * it.rows.length + 0.2;
        } else if (it.kind === 'code') {
          slide.addText(it.text, { x: 0.7, y, w: 11.9, h: Math.min(5.5, 0.3 * it.text.split('\n').length + 0.3), fontSize: 12, fontFace: 'Menlo', color: '2B3138', fill: { color: 'F3F3F3' }, valign: 'top' });
        }
      }
    });
  }
  await pptx.writeFile({ fileName: outPath });
}

// ---------- Word ----------

async function toDocx(input: ConvertInput, outPath: string) {
  const d = require('docx');
  const md = unwrapFence(input.text);
  const rtl = isRtl(md);
  const HEADINGS = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6];
  const textRuns = (rs: Run[]) =>
    rs.map((r) =>
      r.link
        ? new d.ExternalHyperlink({ link: r.link, children: [new d.TextRun({ text: r.text, style: 'Hyperlink', bold: r.bold, italics: r.italic, rightToLeft: rtl })] })
        : new d.TextRun({ text: r.text, bold: r.bold, italics: r.italic, font: r.code ? 'Menlo' : undefined, rightToLeft: rtl, break: r.text === '\n' ? 1 : undefined }),
    );
  const children: any[] = [];
  const list = (l: Tokens.List, level: number) => {
    for (const it of l.items) {
      const own = it.tokens.filter((t) => t.type !== 'list');
      children.push(
        new d.Paragraph({
          children: textRuns(own.flatMap((t) => runs('tokens' in t ? (t as any).tokens : [t]))),
          ...(l.ordered ? { numbering: { reference: 'num', level } } : { bullet: { level } }),
          bidirectional: rtl,
        }),
      );
      for (const sub of it.tokens.filter((t) => t.type === 'list') as Tokens.List[]) list(sub, level + 1);
    }
  };
  const tokens = marked.lexer(md);
  if (!tokens.some((t) => t.type === 'heading' && (t as Tokens.Heading).depth === 1)) {
    children.push(new d.Paragraph({ heading: d.HeadingLevel.TITLE, children: [new d.TextRun({ text: titleOf(input), rightToLeft: rtl })], bidirectional: rtl }));
  }
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        children.push(new d.Paragraph({ heading: HEADINGS[h.depth - 1], children: textRuns(runs(h.tokens)), bidirectional: rtl }));
        break;
      }
      case 'paragraph':
        children.push(new d.Paragraph({ children: textRuns(runs((t as Tokens.Paragraph).tokens)), spacing: { after: 120 }, bidirectional: rtl }));
        break;
      case 'list':
        list(t as Tokens.List, 0);
        break;
      case 'blockquote':
        children.push(new d.Paragraph({ children: textRuns(runs((t as Tokens.Blockquote).tokens)), indent: { left: 400 }, bidirectional: rtl }));
        break;
      case 'code':
        for (const line of (t as Tokens.Code).text.split('\n')) {
          children.push(new d.Paragraph({ children: [new d.TextRun({ text: line || ' ', font: 'Menlo', size: 18 })], shading: { type: d.ShadingType.CLEAR, fill: 'F3F3F3' } }));
        }
        break;
      case 'table': {
        const tb = t as Tokens.Table;
        const row = (cells: Tokens.TableCell[], head: boolean) =>
          new d.TableRow({
            tableHeader: head,
            children: cells.map(
              (c) =>
                new d.TableCell({
                  children: [new d.Paragraph({ children: textRuns(runs(c.tokens).map((r) => ({ ...r, bold: r.bold || head }))), bidirectional: rtl })],
                  shading: head ? { type: d.ShadingType.CLEAR, fill: 'F4F1EE' } : undefined,
                }),
            ),
          });
        children.push(new d.Table({ rows: [row(tb.header, true), ...tb.rows.map((r) => row(r, false))], width: { size: 100, type: d.WidthType.PERCENTAGE }, visuallyRightToLeft: rtl }));
        children.push(new d.Paragraph({ text: '' }));
        break;
      }
      case 'hr':
        children.push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: 'DFE3E8' } } }));
        break;
    }
  }
  const doc = new d.Document({
    creator: 'Agent Canvas',
    title: titleOf(input),
    numbering: {
      config: [{ reference: 'num', levels: [0, 1, 2, 3].map((level) => ({ level, format: d.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: d.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 260 } } } })) }],
    },
    styles: { default: { document: { run: { font: rtl ? 'Arial' : 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  writeFileSync(outPath, await d.Packer.toBuffer(doc));
}

// ---------- Excel / CSV ----------

async function toXlsx(input: ConvertInput, outPath: string) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  for (const t of tables(input)) {
    const ws = wb.addWorksheet(t.name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1, rightToLeft: isRtl(t.rows.flat().join(' ')) }] });
    t.rows.forEach((r) => ws.addRow(r.map((v) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v))));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F1EE' } };
    ws.columns.forEach((c: any, i: number) => (c.width = Math.min(60, Math.max(10, ...t.rows.map((r) => (r[i] ?? '').length + 2)))));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: t.rows[0].length } };
  }
  await wb.xlsx.writeFile(outPath);
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// ---------- entry point ----------

export const EXT: Record<OutputFormat, string> = { pdf: 'pdf', pptx: 'pptx', docx: 'docx', xlsx: 'xlsx', html: 'html', md: 'md', csv: 'csv', json: 'json', txt: 'txt' };

/** Writes `input` to `outPath` in `format` with the built-in converters (no Claude usage). */
export async function convert(format: OutputFormat, input: ConvertInput, outPath: string, opts: { chromePath?: string } = {}) {
  switch (format) {
    case 'pdf': {
      const chrome = findChrome(opts.chromePath);
      if (!chrome) throw new Error('PDF needs Google Chrome, Chromium, Edge or Brave installed (or set its path in Settings). Or use "Designed by Claude" mode.');
      return htmlToPdf(toHtml(input), outPath, chrome);
    }
    case 'html':
      return writeFileSync(outPath, toHtml(input));
    case 'pptx':
      return toPptx(input, outPath);
    case 'docx':
      return toDocx(input, outPath);
    case 'xlsx':
      return toXlsx(input, outPath);
    case 'csv':
      return writeFileSync(outPath, '﻿' + tables(input)[0].rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
    case 'json':
      return writeFileSync(outPath, JSON.stringify(input.structured ?? tryJson(input.text) ?? { text: input.text }, null, 2) + '\n');
    case 'md':
    case 'txt':
      return writeFileSync(outPath, unwrapFence(input.text) + '\n');
  }
}
