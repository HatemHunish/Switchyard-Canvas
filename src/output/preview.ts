import { execFile } from 'child_process';
import ExcelJS from 'exceljs';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'fs';
import JSZip from 'jszip';
import { marked } from 'marked';
import { extname } from 'path';
import { promisify } from 'util';
import { autoDir, DOC_CSS, isRtl } from './convert';

// Turns a produced file into something the in-app viewer can show. Browsers
// show PDFs, images and media natively; everything else is rendered here into a
// self-contained HTML page that is served with a sandbox CSP (no scripts, no
// same-origin), because content often comes from the web via agents.

const run = promisify(execFile);

export type ViewerKind = 'pdf' | 'image' | 'video' | 'audio' | 'page' | 'none';

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac']);
const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const TEXTUTIL = new Set(['.doc', '.rtf', '.odt', '.rtfd', '.webarchive']);
const CODE = new Set([
  '.txt', '.log', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.php',
  '.sh', '.zsh', '.bash', '.sql', '.css', '.scss', '.yaml', '.yml', '.toml', '.ini', '.env', '.xml', '.graphql', '.vue', '.svelte', '.jsonl', '.ndjson', '.tex', '.srt', '.vtt',
]);

const MAX_TEXT = 2_000_000;
const MAX_ROWS = 2000;
const MAX_SHEET_ROWS = 1000;
const MAX_COLS = 60;

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Security policy for rendered pages: styles and images only, links open in a new tab. */
export const PREVIEW_CSP = "default-src 'none'; img-src data: blob: https:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; sandbox allow-popups allow-popups-to-escape-sandbox";

/** Looks at the first bytes: no NUL and mostly printable = text. */
function looksLikeText(path: string) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (!n) return true;
    const slice = buf.subarray(0, n);
    if (slice.includes(0)) return false;
    const bad = [...slice].filter((b) => b < 9 || (b > 13 && b < 32)).length;
    return bad / n < 0.02;
  } finally {
    closeSync(fd);
  }
}

export function viewerFor(name: string, path: string): ViewerKind {
  const ext = extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (MARKDOWN.has(ext) || CODE.has(ext) || ['.html', '.htm', '.json', '.csv', '.tsv', '.docx', '.xlsx', '.pptx'].includes(ext)) return 'page';
  if (TEXTUTIL.has(ext) && process.platform === 'darwin') return 'page';
  try {
    return statSync(path).size <= MAX_TEXT * 5 && looksLikeText(path) ? 'page' : 'none';
  } catch {
    return 'none';
  }
}


// ---------- page shells ----------

const PAPER_CSS = `
  html { background: #2b3039; }
  body { max-width: 860px; margin: 28px auto; background: #fff; border-radius: 6px; box-shadow: 0 10px 40px #0007; padding: 44px 52px; box-sizing: border-box; }
  img { max-width: 100%; height: auto; }
  @media (max-width: 700px) { body { margin: 0; border-radius: 0; padding: 22px 18px; } }
`;

const DARK_CSS = `
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #0d131c; color: #e6ebf2; font: 13px/1.55 ui-monospace, "SF Mono", Menlo, monospace; }
  .wrap { padding: 16px 18px; }
  .note { font-family: system-ui, -apple-system, sans-serif; color: #8291a6; font-size: 12px; margin: 0 0 10px; }
  pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .code { counter-reset: l; }
  .code > span { display: block; padding-inline-start: 4.2em; position: relative; min-height: 1.55em; }
  .code > span::before { counter-increment: l; content: counter(l); position: absolute; inset-inline-start: 0; width: 3.2em; text-align: end; color: #5f6d82; user-select: none; }
  .k { color: #9ec5f4; } .s { color: #8fd6a8; } .n { color: #f0b86e; } .b { color: #d59be8; }
  table { border-collapse: collapse; font: 12.5px/1.4 system-ui, -apple-system, sans-serif; }
  th, td { border: 1px solid #243044; padding: 4px 8px; text-align: start; vertical-align: top; white-space: pre-wrap; max-width: 420px; overflow-wrap: anywhere; }
  thead th { position: sticky; top: 0; background: #161f2d; z-index: 1; }
  td.rn, th.rn { color: #5f6d82; background: #111823; text-align: end; position: sticky; inset-inline-start: 0; }
  tr:nth-child(even) td:not(.rn) { background: #0f1620; }
  nav { font-family: system-ui, -apple-system, sans-serif; position: sticky; top: 0; background: #0d131c; padding: 10px 0; display: flex; gap: 8px; flex-wrap: wrap; z-index: 2; }
  nav a { color: #e6ebf2; text-decoration: none; border: 1px solid #2a374a; border-radius: 6px; padding: 3px 10px; font-size: 12px; }
  h2 { font: 600 14px system-ui, -apple-system, sans-serif; margin: 18px 0 8px; }
  a { color: #9ec5f4; }
`;

function page(title: string, body: string, opts: { paper?: boolean; css?: string; rtl?: boolean } = {}) {
  return `<!doctype html><html lang="${opts.rtl ? 'ar' : 'en'}" dir="${opts.rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"><title>${escapeHtml(title)}</title><style>${
    opts.paper ? DOC_CSS + PAPER_CSS : DARK_CSS
  }${opts.css ?? ''}</style></head><body>${body}</body></html>`;
}

function readText(path: string): { text: string; truncated: boolean } {
  const size = statSync(path).size;
  if (size <= MAX_TEXT) return { text: readFileSync(path, 'utf8'), truncated: false };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(MAX_TEXT);
    readSync(fd, buf, 0, MAX_TEXT, 0);
    return { text: buf.toString('utf8'), truncated: true };
  } finally {
    closeSync(fd);
  }
}

const truncNote = (t: boolean, what = 'the first 2 MB') => (t ? `<p class="note">Large file: showing ${what}. Open it in its app for the rest.</p>` : '');

function codeView(text: string, truncated: boolean, title: string) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').slice(0, 50_000);
  return page(title, `<div class="wrap">${truncNote(truncated)}<pre class="code">${lines.map((l) => `<span dir="auto">${escapeHtml(l)}</span>`).join('')}</pre></div>`);
}

function jsonView(text: string, truncated: boolean, title: string) {
  let pretty: string;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return codeView(text, truncated, title); // not strict JSON (JSONL, comments…): plain text
  }
  const hl = escapeHtml(pretty).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g, (m, str, colon, lit, n) =>
    str ? (colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`) : lit ? `<span class="b">${lit}</span>` : n ? `<span class="n">${n}</span>` : m,
  );
  return page(title, `<div class="wrap">${truncNote(truncated)}<pre class="code">${hl.split('\n').map((l) => `<span>${l}</span>`).join('')}</pre></div>`);
}

/** RFC 4180-ish: quotes, escaped quotes, newlines inside quotes. */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length > MAX_ROWS) break;
    } else cell += c;
  }
  if (cell !== '' || row.length) (row.push(cell), rows.push(row));
  return rows;
}

function tableView(rows: string[][], title: string, note = '') {
  const [head = [], ...body] = rows;
  const width = Math.min(MAX_COLS, Math.max(head.length, ...body.slice(0, 200).map((r) => r.length)));
  const cells = (r: string[], tag: string) => Array.from({ length: width }, (_, i) => `<${tag} dir="auto">${escapeHtml(r[i] ?? '')}</${tag}>`).join('');
  return page(
    title,
    `<div class="wrap">${note}<table><thead><tr><th class="rn"></th>${cells(head, 'th')}</tr></thead><tbody>${body
      .slice(0, MAX_ROWS)
      .map((r, i) => `<tr><td class="rn">${i + 1}</td>${cells(r, 'td')}</tr>`)
      .join('')}</tbody></table></div>`,
  );
}

const colName = (n: number) => {
  let s = '';
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

async function xlsxView(path: string, title: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const sheets = wb.worksheets;
  const parts = sheets.map((ws, si) => {
    const cols = Math.min(MAX_COLS, ws.columnCount || 1);
    const rows: string[] = [];
    const total = ws.rowCount;
    for (let r = 1; r <= Math.min(total, MAX_SHEET_ROWS); r++) {
      const row = ws.getRow(r);
      const cells = Array.from({ length: cols }, (_, c) => {
        let t = '';
        try {
          t = row.getCell(c + 1).text ?? '';
        } catch {
          t = '';
        }
        return `<td dir="auto">${escapeHtml(t)}</td>`;
      }).join('');
      rows.push(`<tr><td class="rn">${r}</td>${cells}</tr>`);
    }
    const more = total > MAX_SHEET_ROWS ? `<p class="note">Showing the first ${MAX_SHEET_ROWS} of ${total} rows.</p>` : '';
    return `<h2 id="s${si}">${escapeHtml(ws.name)}</h2>${more}<table><thead><tr><th class="rn"></th>${Array.from({ length: cols }, (_, c) => `<th>${colName(c)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  });
  const nav = sheets.length > 1 ? `<nav>${sheets.map((ws, i) => `<a href="#s${i}" target="_self">${escapeHtml(ws.name)}</a>`).join('')}</nav>` : '';
  return page(title, `<div class="wrap">${nav}${parts.join('') || '<p class="note">This workbook has no sheets.</p>'}</div>`);
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Slides as cards: title, text paragraphs (with bullet levels) and pictures. */
async function pptxView(path: string, title: string) {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const slides = Object.keys(zip.files)
    .map((f) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  let budget = 15_000_000;
  const cards: string[] = [];
  for (const m of slides) {
    const xml = await zip.file(m[0])!.async('string');
    const rels = (await zip.file(`ppt/slides/_rels/slide${m[1]}.xml.rels`)?.async('string')) ?? '';
    let heading = '';
    const paras: Array<{ text: string; lvl: number; sz: number }> = [];
    for (const sp of xml.match(/<p:sp>[\s\S]*?<\/p:sp>|<p:sp [\s\S]*?<\/p:sp>|<a:tbl>[\s\S]*?<\/a:tbl>/g) ?? []) {
      const isTitle = /<p:ph[^>]*type="(title|ctrTitle)"/.test(sp);
      for (const p of sp.match(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g) ?? []) {
        const text = unxml((p.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((t) => t.replace(/<\/?a:t>/g, '')).join(''));
        if (!text.trim()) continue;
        const lvl = Number(/lvl="(\d)"/.exec(p)?.[1] ?? 0);
        const sz = Math.max(0, ...[...p.matchAll(/\ssz="(\d+)"/g)].map((x) => Number(x[1])));
        if (isTitle && !heading) heading = text;
        else paras.push({ text, lvl, sz });
      }
    }
    // Decks without title placeholders (e.g. generated ones): the clearly largest first text is the title.
    if (!heading && paras.length) {
      const big = Math.max(...paras.map((x) => x.sz));
      const i = paras.findIndex((x) => x.sz === big);
      if (big >= 2400 && i <= 1 && paras.filter((x) => x.sz === big).length === 1) heading = paras.splice(i, 1)[0].text;
    }
    const pics: string[] = [];
    for (const id of [...xml.matchAll(/r:embed="([^"]+)"/g)].map((x) => x[1])) {
      const target = new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`Target="([^"]+)"[^>]*Id="${id}"`).exec(rels)?.[1];
      if (!target) continue;
      const file = zip.file(`ppt/${target.replace(/^\.\.\//, '')}`);
      const ext = target.split('.').pop()!.toLowerCase();
      if (!file || !MIME[ext]) continue;
      const data = await file.async('base64');
      if ((budget -= data.length) < 0) break;
      pics.push(`<img src="data:${MIME[ext]};base64,${data}" alt="">`);
    }
    cards.push(
      `<section class="slide"><div class="num">${m[1]}</div>${heading ? `<h2 dir="auto">${escapeHtml(heading)}</h2>` : ''}${paras.map((x) => `<p class="lvl${Math.min(x.lvl, 4)}" dir="auto">${escapeHtml(x.text)}</p>`).join('')}${pics.length ? `<div class="pics">${pics.join('')}</div>` : ''}</section>`,
    );
  }
  const css = `
    html, body { background: #2b3039; margin: 0; font-family: -apple-system, "Segoe UI", Arial, "Geeza Pro", sans-serif; }
    .deck { max-width: 900px; margin: 0 auto; padding: 22px 16px; display: grid; gap: 18px; }
    .slide { background: #fff; color: #1b1f24; aspect-ratio: 16 / 9; border-radius: 6px; box-shadow: 0 10px 34px #0007; padding: 34px 44px; position: relative; overflow: hidden; box-sizing: border-box; }
    .slide h2 { margin: 0 0 14px; font-size: 26px; letter-spacing: -0.01em; }
    .slide p { margin: 4px 0; font-size: 16px; line-height: 1.4; }
    .lvl1 { padding-inline-start: 22px; } .lvl2 { padding-inline-start: 44px; } .lvl3, .lvl4 { padding-inline-start: 66px; }
    .num { position: absolute; bottom: 10px; inset-inline-end: 16px; color: #8a929c; font-size: 12px; }
    .pics { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
    .pics img { max-height: 180px; max-width: 48%; object-fit: contain; }
    @media (max-width: 700px) { .slide { aspect-ratio: auto; padding: 20px; } }
  `;
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><title>${escapeHtml(title)}</title><style>${css}</style></head><body><div class="deck">${
    cards.join('') || '<p style="color:#ccc">No slides found.</p>'
  }</div></body></html>`;
}

/** Renders a file into a standalone HTML page for the viewer. */
export async function renderPreview(path: string, name: string): Promise<string> {
  const ext = extname(name).toLowerCase();
  const title = name;
  if (MARKDOWN.has(ext)) {
    const { text, truncated } = readText(path);
    const rtl = isRtl(text);
    return page(title, `${truncNote(truncated)}${autoDir(marked.parse(text, { async: false }) as string)}`, { paper: true, rtl });
  }
  if (ext === '.html' || ext === '.htm') return readText(path).text; // served under the same sandbox CSP
  if (ext === '.json') {
    const { text, truncated } = readText(path);
    return jsonView(text, truncated, title);
  }
  if (ext === '.csv' || ext === '.tsv') {
    const { text, truncated } = readText(path);
    const rows = parseDelimited(text.replace(/^﻿/, ''), ext === '.tsv' ? '\t' : text.split('\n')[0].split(';').length > text.split('\n')[0].split(',').length ? ';' : ',');
    const note = rows.length > MAX_ROWS || truncated ? `<p class="note">Showing the first ${Math.min(rows.length - 1, MAX_ROWS)} rows.</p>` : '';
    return tableView(rows, title, note);
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const r = await mammoth.convertToHtml({ path });
    return page(title, autoDir(r.value) || '<p>(empty document)</p>', { paper: true, rtl: isRtl(r.value.replace(/<[^>]+>/g, '')) });
  }
  if (TEXTUTIL.has(ext) && process.platform === 'darwin') {
    const { stdout } = await run('textutil', ['-convert', 'html', '-stdout', path], { maxBuffer: 30_000_000, timeout: 20_000 });
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(stdout)?.[1] ?? stdout;
    return page(title, autoDir(body), { paper: true, rtl: isRtl(body.replace(/<[^>]+>/g, '')) });
  }
  if (ext === '.xlsx') return xlsxView(path, title);
  if (ext === '.pptx') return pptxView(path, title);
  const { text, truncated } = readText(path);
  return codeView(text, truncated, title);
}
