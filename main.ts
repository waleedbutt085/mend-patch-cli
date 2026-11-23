// mend: apply AI-written edits in four formats to a tree of text files (SPEC.md version 1).
// Node 22, standard library only. In a trial this file hands over to runner.ts at the bottom.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileData {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileData {
  const i = text.indexOf('\n');
  const br = i >= 0 && i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const pieces = text.split(br);
  const final = text.endsWith(br);
  if (final) pieces.pop();
  return { lines: pieces, br, final };
}

function serialize(f: FileData): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; next: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  file(p: string): FileData | null {
    const t = this.get(p);
    return t === null ? null : parseFile(t);
  }
  set(p: string, f: FileData): void {
    this.now.set(p, serialize(f));
  }
  check(...paths: string[]): void {
    for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- section 5: matching lines ----------

const trailWS = (s: string): string => s.replace(/[\t ]+$/, '');
const allWS = (s: string): string => s.replace(/^[\t ]+/, '').replace(/[\t ]+$/, '');
const leadWS = (s: string): string => /^[\t ]*/.exec(s)![0];
const isBlankLine = (s: string): boolean => /^[\t ]*$/.test(s);

function norm(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? trailWS(s) : allWS(s);
}
function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

interface Found {
  pos: number;
  tier: number;
  all: number[];
}

function findBlock(lines: string[], oldLines: string[], start: number, strict: boolean, eofOnly = false): Found | null {
  if (oldLines.length === 0) return null;
  for (const tier of tiers(strict)) {
    const positions: number[] = [];
    for (let i = start; i + oldLines.length <= lines.length; i += 1) {
      if (eofOnly && i + oldLines.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < oldLines.length; j += 1) {
        if (norm(lines[i + j]!, tier) !== norm(oldLines[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { pos: positions[0]!, tier, all: positions };
  }
  return null;
}

function findOneLine(lines: string[], anchor: string, start: number, strict: boolean): number | null {
  for (const tier of tiers(strict)) {
    for (let i = start; i < lines.length; i += 1) {
      if (norm(lines[i]!, tier) === norm(anchor, tier)) return i;
    }
  }
  return null;
}

interface NewLine {
  text: string;
  context: number | null;
  noEol?: boolean;
}

/** Build the replacement lines for a matched block. Context lines come from the file itself. */
function replacement(file: FileData, pos: number, oldLines: string[], n: NewLine[], tier: number): string[] {
  const f = leadWS(file.lines[pos] ?? '');
  const p = leadWS(oldLines[0] ?? '');
  return n.map((x) => {
    if (x.context !== null) return file.lines[pos + x.context]!;
    if (tier === 2 && !isBlankLine(x.text) && x.text.startsWith(p)) return f + x.text.slice(p.length);
    return x.text;
  });
}

function applyBlock(file: FileData, pos: number, oldLines: string[], n: NewLine[], tier: number, endFinal: boolean | null): FileData {
  const lines = file.lines.slice(0, pos).concat(replacement(file, pos, oldLines, n, tier), file.lines.slice(pos + oldLines.length));
  return { lines, br: file.br, final: endFinal === null ? file.final : endFinal };
}

// ---------- section 6: unified diffs ----------

interface HunkLine {
  mark: ' ' | '-' | '+';
  text: string;
  noEol: boolean;
}
interface Hunk {
  a: number;
  body: HunkLine[];
}
interface USection {
  oldPath: string | null;
  newPath: string | null;
  gitOld: string | null;
  gitNew: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
  line: number;
}

function headerPath(raw: string): string {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function hunkBody(lines: string[], start: number): { body: HunkLine[]; next: number } {
  const body: HunkLine[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
    if (l === '') {
      body.push({ mark: ' ', text: '', noEol: false });
      i += 1;
      continue;
    }
    const mark = l[0]!;
    if (mark !== ' ' && mark !== '-' && mark !== '+' && mark !== '\\') break;
    if (mark === '\\') {
      if (body.length > 0) body[body.length - 1]!.noEol = true;
    } else body.push({ mark: mark as ' ' | '-' | '+', text: l.slice(1), noEol: false });
    i += 1;
  }
  while (body.length > 0 && body[body.length - 1]!.mark === ' ' && body[body.length - 1]!.text === '' && !body[body.length - 1]!.noEol) body.pop();
  return { body, next: i };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: null, newPath: null, gitOld: m[1]!, gitNew: m[2]!, creation: false, deletion: false, hunks: [], line: i + 1 };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(l.slice(4));
      const newP = headerPath(lines[i + 1]!.slice(4));
      if (!(cur && cur.hunks.length === 0 && (cur.oldPath === null || cur.oldPath === oldP) && (cur.newPath === null || cur.newPath === newP))) {
        cur = { oldPath: null, newPath: null, gitOld: null, gitNew: null, creation: false, deletion: false, hunks: [], line: i + 1 };
        sections.push(cur);
      }
      cur.oldPath = oldP;
      cur.newPath = newP;
      if (oldP === '/dev/null') cur.creation = true;
      if (newP === '/dev/null') cur.deletion = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = hunkBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]!), body: parsed.body });
      i = parsed.next;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.oldPath = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.newPath = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.creation = true;
      else if (l.startsWith('deleted file mode')) cur.deletion = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((s): Edit => {
    const oldP = s.oldPath ?? s.gitOld;
    const newP = s.newPath ?? s.gitNew;
    const path = oldP ?? newP;
    return (tree: Tree): void => {
      if (path === null) throw new Exit2(`error: parse ${s.line}`);
      tree.check(...(s.creation ? [newP ?? path] : s.deletion ? [oldP ?? path] : [oldP ?? path, newP ?? path]));
      if (s.creation) {
        const target = newP ?? path;
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const content: string[] = [];
        let noEol = false;
        for (const h of s.hunks) for (let j = 0; j < h.body.length; j += 1) {
          if (h.body[j]!.mark === '+') {
            content.push(h.body[j]!.text);
            noEol = h.body[j]!.noEol;
          }
        }
        tree.set(target, { lines: content, br: '\n', final: !(content.length > 0 && noEol) });
        return;
      }
      if (s.deletion) {
        const target = oldP ?? path;
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
        return;
      }
      const source = oldP ?? path;
      const target = newP ?? source;
      if (tree.get(source) === null) throw new Fail('missing', source);
      if (source !== target && tree.get(target) !== null) throw new Fail('exists', target);
      const file0 = tree.file(source)!;
      let file = file0;
      let d = 0;
      for (const h of s.hunks) {
        const O = h.body.filter((x) => x.mark !== '+').map((x) => x.text);
        const n: NewLine[] = h.body.filter((x) => x.mark !== '-').map((x) => ({ text: x.text, context: x.mark === ' ' ? h.body.filter((y) => y.mark !== '+').findIndex((y) => y === x) : null, noEol: x.noEol }));
        if (O.length === 0) {
          const at = Math.min(Math.max(h.a + d, 0), file.lines.length);
          const lines = file.lines.slice(0, at).concat(replacement(file, at, [], n, 0), file.lines.slice(at));
          file = { lines, br: file.br, final: file.final };
          d += n.length;
          continue;
        }
        const found = findBlock(file.lines, O, 0, strict);
        if (found === null) throw new Fail('no-match', source);
        let pos = found.pos;
        let best = Math.abs(pos - (h.a - 1 + d));
        for (const candidate of found.all) {
          const dist = Math.abs(candidate - (h.a - 1 + d));
          if (dist < best) {
            best = dist;
            pos = candidate;
          }
        }
        const atEnd = pos + O.length === file.lines.length;
        const last = n[n.length - 1];
        const endFinal = atEnd && last !== undefined && last.noEol ? false : null;
        file = applyBlock(file, pos, O, n, found.tier, endFinal);
        d += n.length - O.length;
      }
      if (source !== target) {
        tree.now.set(source, null);
        tree.now.set(target, serialize(file));
        tree.moves.push({ old: source, next: target });
      } else tree.set(source, file);
    };
  });
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let blockStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i + 1;
    let path = prevPath;
    for (let j = i - 1; j >= blockStart; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) throw new Exit2(`error: parse ${at}`);
    let eq = -1;
    let repl = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') eq = j;
      else if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repl = j;
        break;
      }
    }
    if (eq < 0 || repl < 0) throw new Exit2(`error: parse ${at}`);
    const oldLines = lines.slice(i + 1, eq);
    const newText = lines.slice(eq + 1, repl);
    const p = path;
    edits.push((tree: Tree): void => {
      tree.check(p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.set(p, { lines: newText, br: '\n', final: true });
        return;
      }
      const file = tree.file(p);
      if (file === null) throw new Fail('missing', p);
      const found = findBlock(file.lines, oldLines, 0, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.all.length > 1) throw new Fail('ambiguous', p);
      const n: NewLine[] = newText.map((t) => ({ text: t, context: null }));
      tree.set(p, applyBlock(file, found.pos, oldLines, n, found.tier, null));
    });
    prevPath = path;
    blockStart = repl + 1;
    i = repl + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------- section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  body: HunkLine[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  move: string | null;
  lines: string[];
  chunks: VChunk[];
  line: number;
}
const isSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const header = lines[i]!;
    if (blank(header)) {
      i += 1;
      continue;
    }
    const at = i + 1;
    if (header.startsWith('*** Add File: ')) {
      const s: VSection = { kind: 'add', path: header.slice(14).trim(), move: null, lines: [], chunks: [], line: at };
      i += 1;
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l === '') s.lines.push('');
        else if (l.startsWith('+')) s.lines.push(l.slice(1));
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (s.lines.length > 0 && s.lines[s.lines.length - 1] === '') s.lines.pop();
      sections.push(s);
      continue;
    }
    if (header.startsWith('*** Delete File: ')) {
      const s: VSection = { kind: 'delete', path: header.slice(17).trim(), move: null, lines: [], chunks: [], line: at };
      i += 1;
      while (i < last && !isSectionStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      sections.push(s);
      continue;
    }
    if (header.startsWith('*** Update File: ')) {
      const s: VSection = { kind: 'update', path: header.slice(17).trim(), move: null, lines: [], chunks: [], line: at };
      i += 1;
      let chunk: VChunk | null = null;
      let sawMove = false;
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith('*** Move to: ')) {
          if (s.chunks.length > 0 || (chunk !== null && chunk.body.length > 0) || sawMove) throw new Exit2(`error: parse ${i + 1}`);
          s.move = l.slice(13).trim();
          sawMove = true;
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          chunk = { anchor: l.slice(2).trim(), body: [], eof: false };
          s.chunks.push(chunk);
          i += 1;
          continue;
        }
        if (l.startsWith('*** End of File')) {
          if (chunk === null) {
            chunk = { anchor: null, body: [], eof: false };
            s.chunks.push(chunk);
          }
          chunk.eof = true;
          i += 1;
          continue;
        }
        if (l.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
        if (blank(l) && chunk === null) {
          i += 1;
          continue;
        }
        if (chunk === null) {
          chunk = { anchor: null, body: [], eof: false };
          s.chunks.push(chunk);
        }
        if (l === '') chunk.body.push({ mark: ' ', text: '', noEol: false });
        else {
          const mark = l[0]!;
          if (mark !== ' ' && mark !== '-' && mark !== '+') throw new Exit2(`error: parse ${i + 1}`);
          chunk.body.push({ mark: mark as ' ' | '-' | '+', text: l.slice(1), noEol: false });
        }
        i += 1;
      }
      for (const c of s.chunks) while (c.body.length > 0 && c.body[c.body.length - 1]!.mark === ' ' && c.body[c.body.length - 1]!.text === '') c.body.pop();
      if (s.chunks.length === 0 && s.move === null) throw new Exit2(`error: parse ${s.line}`);
      if (s.chunks.length === 0) s.chunks.push({ anchor: null, body: [], eof: false });
      sections.push(s);
      continue;
    }
    throw new Exit2(`error: parse ${at}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((s): Edit => {
    const path = s.path;
    const target = s.move ?? s.path;
    return (tree: Tree): void => {
      tree.check(...(s.move === null ? [path] : [path, target]));
      if (s.kind === 'add') {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.set(path, { lines: s.lines, br: '\n', final: true });
        return;
      }
      if (s.kind === 'delete') {
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
        return;
      }
      const original = tree.file(path);
      if (original === null) throw new Fail('missing', path);
      if (s.move !== null && tree.get(target) !== null) throw new Fail('exists', target);
      let file = original;
      let cursor = 0;
      for (const c of s.chunks) {
        let start = cursor;
        if (c.anchor !== null && c.anchor !== '') {
          const at = findOneLine(file.lines, c.anchor, cursor, strict);
          if (at === null) throw new Fail('no-match', path);
          start = at + 1;
        }
        const O = c.body.filter((x) => x.mark !== '+').map((x) => x.text);
        const n: NewLine[] = c.body.filter((x) => x.mark !== '-').map((x) => ({ text: x.text, context: x.mark === ' ' ? c.body.filter((y) => y.mark !== '+').findIndex((y) => y === x) : null, noEol: x.noEol }));
        if (O.length === 0) {
          const at = c.eof ? file.lines.length : Math.min(start, file.lines.length);
          file = { lines: file.lines.slice(0, at).concat(replacement(file, at, [], n, 0), file.lines.slice(at)), br: file.br, final: file.final };
          cursor = at + n.length;
          continue;
        }
        const found = findBlock(file.lines, O, start, strict, c.eof);
        if (found === null) throw new Fail('no-match', path);
        const atEnd = found.pos + O.length === file.lines.length;
        const last = n[n.length - 1];
        const endFinal = atEnd && last !== undefined && last.noEol ? false : null;
        file = applyBlock(file, found.pos, O, n, found.tier, endFinal);
        cursor = found.pos + n.length;
      }
      if (s.move !== null) {
        tree.now.set(path, null);
        tree.now.set(target, serialize(file));
        tree.moves.push({ old: path, next: target });
      } else tree.set(path, file);
    };
  });
}

// ---------- section 9: JSON edits ----------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- sections 1, 2 and 10 ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const rows: Array<{ key: string; line: string }> = [];
  const movedPaths = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.next) === null && tree.now.get(m.next) !== null && tree.now.get(m.next) !== tree.original(m.old)) {
      rows.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
      movedPaths.add(m.old);
      movedPaths.add(m.next);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedPaths.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const v = tree.now.get(p)!;
      if (v === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
