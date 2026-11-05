#!/usr/bin/env node
// publish-check: what is wrong with your package before you publish it.
// Reads a package folder (package.json, .npmignore / .gitignore, the files on disk), works out the files
// npm would pack and reports every broken entry point. Never runs npm, never runs the package's code,
// never changes a file. Plain Node 22, built-in modules only.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const VERSION = '0.1.0';
const USAGE = 'usage: publish-check [dir] [--json] [--list] [--fail-on error|warning|none] [--max-size <bytes>]';

// ---------------------------------------------------------------- JSON with the keys in written order

const KEYS = new WeakMap(); // object -> its keys in the order they are written

// Reads text that JSON.parse has already accepted. Objects keep the written order of their keys
// (a plain object would put keys like "1" first).
function parseOrdered(text) {
  let i = 0;
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
  const str = () => {
    const s = i;
    i++;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(s, i));
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const o = Object.create(null);
      const keys = [];
      KEYS.set(o, keys);
      ws();
      if (text[i] === '}') { i++; return o; }
      for (;;) {
        ws();
        const k = str();
        ws();
        i++; // :
        const v = value();
        if (!(k in o)) keys.push(k);
        o[k] = v;
        ws();
        if (text[i++] !== ',') break;
      }
      return o;
    }
    if (c === '[') {
      i++;
      const a = [];
      ws();
      if (text[i] === ']') { i++; return a; }
      for (;;) {
        a.push(value());
        ws();
        if (text[i++] !== ',') break;
      }
      return a;
    }
    if (c === '"') return str();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    const m = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    m.lastIndex = i;
    const r = m.exec(text);
    i = m.lastIndex;
    return Number(r[0]);
  };
  return value();
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keysOf = (o) => KEYS.get(o) ?? Object.keys(o);

// JSON text; indent = 0 gives one line.
function ser(v, indent = 0, level = 0) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const nl = indent ? '\n' + ' '.repeat(indent * (level + 1)) : '';
  const end = indent ? '\n' + ' '.repeat(indent * level) : '';
  const sep = indent ? ',' + nl : ',';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return '[' + nl + v.map((x) => ser(x, indent, level + 1)).join(sep) + end + ']';
  }
  const keys = keysOf(v);
  if (keys.length === 0) return '{}';
  return '{' + nl + keys.map((k) => JSON.stringify(k) + (indent ? ': ' : ':') + ser(v[k], indent, level + 1)).join(sep) + end + '}';
}

// ---------------------------------------------------------------- the tokenizer ("Reading the code")

const REGEX_AFTER_NAME = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const WS_RE = /\s/;
const isWs = (c) => c === 32 || (c >= 9 && c <= 13) || (c > 127 && WS_RE.test(String.fromCharCode(c)));
const isDigit = (c) => c >= 48 && c <= 57;
const isAsciiLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameStart = (c) => isAsciiLetter(c) || c === 95 || c === 36 || (c > 127 && !isWs(c));
const isNameCont = (c) => isNameStart(c) || isDigit(c);
const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE_OF = { ')': '(', ']': '[', '}': '{' };

function regexAllowed(prev) {
  if (prev === null) return true;
  if (prev.k === 'p') return !(prev.v === ')' || prev.v === ']' || prev.v === '}' || prev.v === '<');
  if (prev.k === 'n') return REGEX_AFTER_NAME.has(prev.v);
  return false;
}

// Token kinds: n name, s string, t template, r regular expression, d number, p punctuator.
// With sub = true the text of a template substitution is read, up to its matching }, and no token is kept.
function tokenize(text, start, sub) {
  const toks = [];
  const n = text.length;
  const stack = [];
  let i = start;
  let braces = 0;
  let prev = null;
  if (!sub && text.charCodeAt(0) === 35 && text.charCodeAt(1) === 33) {
    const j = text.indexOf('\n');
    i = j < 0 ? n : j;
  }
  const emit = (tok) => { prev = tok; if (!sub) toks.push(tok); };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isWs(c)) { i++; continue; }
    const s = i;
    if (c === 47) {
      const d = text.charCodeAt(i + 1);
      if (d === 47) {
        const j = text.indexOf('\n', i + 2);
        i = j < 0 ? n : j;
        continue;
      }
      if (d === 42) {
        const j = text.indexOf('*/', i + 2);
        i = j < 0 ? n : j + 2;
        continue;
      }
      if (regexAllowed(prev)) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const e = text.charCodeAt(j);
          if (e === 92) { j += 2; continue; }
          if (e === 10) break;
          if (inClass) { if (e === 93) inClass = false; } else if (e === 91) inClass = true; else if (e === 47) { j++; break; }
          j++;
        }
        if (j > n) j = n;
        while (j < n && isAsciiLetter(text.charCodeAt(j))) j++;
        i = j;
        emit({ k: 'r', v: text.slice(s, j), d: 0 });
        continue;
      }
      i++;
      emit({ k: 'p', v: '/', d: 0 });
      continue;
    }
    if (c === 39 || c === 34) {
      let j = i + 1;
      while (j < n) {
        const e = text.charCodeAt(j);
        if (e === 92) { j += 2; continue; }
        if (e === c || e === 10) break;
        j++;
      }
      const end = Math.min(j, n);
      i = j < n && text.charCodeAt(j) === c ? j + 1 : end;
      emit({ k: 's', v: text.slice(s + 1, end), d: 0 });
      continue;
    }
    if (c === 96) {
      let j = i + 1;
      while (j < n) {
        const e = text.charCodeAt(j);
        if (e === 92) { j += 2; continue; }
        if (e === 96) break;
        if (e === 36 && text.charCodeAt(j + 1) === 123) { j = tokenize(text, j + 2, true); continue; }
        j++;
      }
      const end = Math.min(j, n);
      i = j < n && text.charCodeAt(j) === 96 ? j + 1 : end;
      emit({ k: 't', v: text.slice(s + 1, end), d: 0 });
      continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(i + 1)))) {
      const hex = c === 48 && (text.charCodeAt(i + 1) === 120 || text.charCodeAt(i + 1) === 88);
      let j = i + 1;
      while (j < n) {
        const e = text.charCodeAt(j);
        if (isAsciiLetter(e) || isDigit(e) || e === 95 || e === 46) { j++; continue; }
        if ((e === 43 || e === 45) && !hex) {
          const p = text.charCodeAt(j - 1);
          if (p === 101 || p === 69) { j++; continue; }
        }
        break;
      }
      i = j;
      emit({ k: 'd', v: text.slice(s, j), d: 0 });
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < n && isNameCont(text.charCodeAt(j))) j++;
      i = j;
      emit({ k: 'n', v: text.slice(s, j), d: 0 });
      continue;
    }
    let v = text[i];
    if (c === 61 && text.charCodeAt(i + 1) === 62) v = '=>';
    else if (c === 46 && text.charCodeAt(i + 1) === 46 && text.charCodeAt(i + 2) === 46) v = '...';
    else if (c === 63 && text.charCodeAt(i + 1) === 46 && !isDigit(text.charCodeAt(i + 2))) v = '?.';
    i += v.length;
    if (sub) {
      if (v === '{') braces++;
      else if (v === '}') {
        if (braces === 0) return i;
        braces--;
      }
    }
    const tok = { k: 'p', v, d: 0 };
    if (!sub && v.length === 1) {
      if (OPEN[v]) {
        tok.idx = toks.length;
        stack.push(tok);
      } else if (CLOSE_OF[v] && stack.length > 0 && stack[stack.length - 1].v === CLOSE_OF[v]) {
        const o = stack.pop();
        o.m = toks.length;
        tok.m = o.idx;
      }
    }
    emit(tok);
  }
  return sub ? n : toks;
}

// Tokens of a file, each with its depth d.
function tokenizeFile(text) {
  const toks = tokenize(text, 0, false);
  let depth = 0;
  for (const t of toks) {
    if (t.m !== undefined && OPEN[t.v]) { t.d = depth; depth++; }
    else if (t.m !== undefined) { depth--; t.d = depth; }
    else t.d = depth;
  }
  return toks;
}

const isN = (t, v) => !!t && t.k === 'n' && (v === undefined || t.v === v);
const isP = (t, v) => !!t && t.k === 'p' && t.v === v;
const dotBefore = (toks, i) => i > 0 && toks[i - 1].k === 'p' && (toks[i - 1].v === '.' || toks[i - 1].v === '?.');

function usesCommonJS(toks) {
  let hasCreateRequire = false;
  let hasRequireCall = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'n') continue;
    if (t.v === 'createRequire') hasCreateRequire = true;
    else if (t.v === 'require' && !dotBefore(toks, i) && isP(toks[i + 1], '(')) hasRequireCall = true;
    else if (t.v === 'module' && !dotBefore(toks, i) && isP(toks[i + 1], '.') && isN(toks[i + 2], 'exports')) return true;
  }
  return hasRequireCall && !hasCreateRequire;
}

function usesEsm(toks) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'n' || dotBefore(toks, i)) continue;
    const next = toks[i + 1];
    if (t.v === 'import') {
      if (t.d === 0 && !isP(next, '(') && !isP(next, '.')) return true;
      if (isP(next, '.') && isN(toks[i + 2], 'meta')) return true;
    } else if (t.v === 'export') {
      if (t.d === 0 && next && (isP(next, '{') || isP(next, '*') || next.k === 'n')) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- the files of the package folder

function walk(root) {
  const files = new Map(); // path -> size
  const visit = (abs, rel) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const name = e.name;
      const childAbs = abs + '/' + name;
      const childRel = rel === '' ? name : rel + '/' + name;
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (!isDir && !isFile && !e.isSymbolicLink()) {
        try { const st = lstatSync(childAbs); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
      }
      if (isDir) {
        if (name === '.git' || name === 'node_modules') continue;
        visit(childAbs, childRel);
      } else if (isFile) {
        try { files.set(childRel, lstatSync(childAbs).size); } catch { /* vanished */ }
      }
    }
  };
  visit(root, '');
  return files;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- step 1: left out always

const LEFT_OUT_DIRS = new Set(['.svn', '.hg', 'CVS']);
const LEFT_OUT_NAMES = new Set(['.DS_Store', '.npmrc', '.npmignore', '.gitignore', '.lock-wscript', 'npm-debug.log', 'config.gypi']);
const LEFT_OUT_ROOT = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']);

function isLeftOut(path) {
  const parts = path.split('/');
  const last = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i++) if (LEFT_OUT_DIRS.has(parts[i])) return true;
  if (LEFT_OUT_NAMES.has(last) || last.startsWith('._') || last.endsWith('.orig')) return true;
  if (last.startsWith('.') && last.endsWith('.swp') && last.length >= 6) return true;
  if (/^\.wafpickle-[0-9]+$/.test(last)) return true;
  return parts.length === 1 && LEFT_OUT_ROOT.has(last);
}

// ---------------------------------------------------------------- patterns

function partRegExp(part) {
  let src = '';
  let star = false;
  for (const ch of part) {
    if (ch === '*') { if (!star) src += '.*'; star = true; continue; }
    star = false;
    if (ch === '?') src += '.';
    else src += ch.replace(/[\\^$.*+?()[\]{}|\/]/g, '\\$&');
  }
  return new RegExp('^' + src + '$', 'su');
}

// One pattern: { neg, anchored, foldersOnly, parts: [{ glob: true } | { re }] | null }
function readPattern(raw, isFiles) {
  let p = raw;
  let neg = false;
  if (p.startsWith('!')) { neg = true; p = p.slice(1); }
  let anchored = isFiles;
  if (isFiles && p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) { p = p.replace(/^\/+/, ''); anchored = true; }
  let foldersOnly = false;
  if (p.endsWith('/')) { p = p.replace(/\/+$/, ''); foldersOnly = true; }
  if (p === '') return { neg, anchored, foldersOnly, parts: null };
  if (!anchored && p.includes('/')) anchored = true;
  const parts = p.split('/').map((s) => (s === '**' ? { glob: true } : { re: partRegExp(s) }));
  return { neg, anchored, foldersOnly, parts };
}

function matchParts(pattern, cand) {
  const P = pattern.length;
  const C = cand.length;
  const memo = new Map();
  const go = (pi, ci) => {
    if (pi === P) return ci === C;
    const key = pi * (C + 1) + ci;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r = false;
    if (pattern[pi].glob) {
      for (let k = ci; k <= C && !r; k++) r = go(pi + 1, k);
    } else {
      r = ci < C && pattern[pi].re.test(cand[ci]) && go(pi + 1, ci + 1);
    }
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

function patternMatches(pat, parts) {
  if (pat.parts === null) return false;
  const n = parts.length;
  if (pat.anchored) {
    for (let k = 1; k <= (pat.foldersOnly ? n - 1 : n); k++) {
      if (matchParts(pat.parts, parts.slice(0, k))) return true;
    }
    return false;
  }
  for (let k = 0; k < (pat.foldersOnly ? n - 1 : n); k++) {
    if (matchParts(pat.parts, [parts[k]])) return true;
  }
  return false;
}

// The last pattern that matches decides: returns null (none matches), or that pattern.
function decide(patterns, path) {
  const parts = path.split('/');
  for (let i = patterns.length - 1; i >= 0; i--) if (patternMatches(patterns[i], parts)) return patterns[i];
  return null;
}

function ignoreLines(text) {
  const out = [];
  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    line = line.replace(/[ \t]+$/, '');
    if (line === '' || line.startsWith('#')) continue;
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------- entry targets

const pathOf = (s) => s.split('/').filter((p) => p !== '' && p !== '.').join('/');
const pointsOutside = (s) => s.startsWith('/') || s.split('/').includes('..');

function globRegExp(s) {
  const rest = s.startsWith('./') ? s.slice(2) : s;
  return new RegExp('^' + rest.split('*').map((x) => x.replace(/[\\^$.*+?()[\]{}|\/]/g, '\\$&')).join('[^]*') + '$');
}

const bracketField = (k) => '[' + JSON.stringify(k) + ']';

function collectTargets(m) {
  const targets = [];
  for (const f of ['main', 'module', 'types', 'typings']) {
    if (typeof m[f] === 'string') targets.push({ field: f, s: m[f], kind: f });
  }
  if (typeof m.browser === 'string') targets.push({ field: 'browser', s: m.browser, kind: 'browser' });
  if (typeof m.bin === 'string') targets.push({ field: 'bin', s: m.bin, kind: 'bin' });
  else if (isObj(m.bin)) {
    for (const k of keysOf(m.bin)) if (typeof m.bin[k] === 'string') targets.push({ field: 'bin' + bracketField(k), s: m.bin[k], kind: 'bin' });
  }
  const down = (v, field) => {
    if (typeof v === 'string') targets.push({ field, s: v, kind: 'exports' });
    else if (Array.isArray(v)) v.forEach((x, i) => down(x, field + '[' + i + ']'));
    else if (isObj(v)) for (const k of keysOf(v)) down(v[k], field + bracketField(k));
  };
  if (m.exports !== undefined) down(m.exports, 'exports');
  return targets;
}

function typesOrder(v, field, out) {
  if (Array.isArray(v)) v.forEach((x, i) => typesOrder(x, field + '[' + i + ']', out));
  else if (isObj(v)) {
    const keys = keysOf(v);
    if (keys.includes('types') && !keys.some((k) => k.startsWith('.')) && keys[0] !== 'types') {
      out.push({ field: field + bracketField('types'), value: v.types });
    }
    for (const k of keys) typesOrder(v[k], field + bracketField(k), out);
  }
}

// ---------------------------------------------------------------- metadata

function validLicense(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.startsWith('SEE LICENSE IN ') && s.slice('SEE LICENSE IN '.length).trim() !== '') return true;
  const toks = s.match(/[()]|[^\s()]+/g) ?? [];
  let i = 0;
  const isId = (t) => t !== undefined && /^[A-Za-z0-9][A-Za-z0-9.-]*\+?$/.test(t) && t !== 'AND' && t !== 'OR' && t !== 'WITH';
  const operand = () => {
    if (toks[i] === '(') {
      i++;
      if (!expr()) return false;
      if (toks[i] !== ')') return false;
      i++;
      return true;
    }
    if (!isId(toks[i])) return false;
    i++;
    if (toks[i] === 'WITH') {
      i++;
      if (!isId(toks[i])) return false;
      i++;
    }
    return true;
  };
  const expr = () => {
    if (!operand()) return false;
    while (toks[i] === 'AND' || toks[i] === 'OR') {
      i++;
      if (!operand()) return false;
    }
    return true;
  };
  return expr() && i === toks.length;
}

const nonBlank = (v) => typeof v === 'string' && v.trim() !== '';

// ---------------------------------------------------------------- findings

// Text for a message that stays on one line: the string itself, or its JSON form when it holds a line break.
const safe = (s) => (/[\n\r\u2028\u2029]/.test(s) ? JSON.stringify(s) : s);
const q = (s) => (/[\n\r\u2028\u2029]/.test(s) ? JSON.stringify(s) : '"' + s + '"');
const asText = (v) => (typeof v === 'string' ? safe(v) : ser(v));

const SEVERITY = { 'package-json': 'error' };
for (const r of ['exports-form', 'entry-outside', 'entry-missing', 'entry-not-packed', 'bin-shebang', 'type-mismatch', 'types-order', 'package-too-large']) SEVERITY[r] = 'error';

function finding(rule, field, value, message, fix, severity) {
  return { rule, severity: severity ?? SEVERITY[rule] ?? 'warning', field, value, message, fix };
}

const SECRET_EXACT = new Set(['.env', '.netrc', '.htpasswd', 'credentials.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
const ENV_OK = new Set(['.env.example', '.env.sample', '.env.template']);
const SECRET_END = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'];
const JUNK_NAMES = new Set(['thumbs.db', 'desktop.ini']);
const JUNK_END = ['.log', '.tmp', '.bak', '.swo', '.tsbuildinfo', '~'];
const JUNK_DIRS = new Set(['.idea', '.vscode', 'coverage', '.nyc_output', '__MACOSX']);
const FIXTURE_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'fixtures', '__fixtures__']);

function check(rootAbs, opts) {
  const findings = [];
  const pkgPath = rootAbs + '/package.json';
  const bad = (why) => {
    findings.push(finding('package-json', null, null, `package.json ${why}`, 'add a valid package.json (a JSON object) at the root of the package folder'));
    return { findings, files: 0, size: 0, list: [] };
  };
  let st;
  try { st = lstatSync(pkgPath); } catch { return bad('does not exist in the package folder'); }
  if (!st.isFile()) return bad('is not a regular file');
  let manifest;
  let text;
  try { text = readFileSync(pkgPath, 'utf8'); } catch { return bad('cannot be read'); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { JSON.parse(text); } catch (e) { return bad('is not valid JSON (' + safe(String(e.message)) + ')'); }
  manifest = parseOrdered(text);
  if (!isObj(manifest)) return bad('is valid JSON but not an object');

  const walked = walk(rootAbs);

  // step 1
  const candidates = [...walked.keys()].filter((p) => !isLeftOut(p));
  const candidateSet = new Set(candidates);

  // step 2
  let chosen;
  let how; // for the fix texts
  if (Array.isArray(manifest.files)) {
    const pats = manifest.files.filter((x) => typeof x === 'string').map((x) => readPattern(x, true));
    chosen = candidates.filter((p) => { const d = decide(pats, p); return d !== null && !d.neg; });
    how = 'files';
  } else {
    let ignoreFile = null;
    if (walked.has('.npmignore')) ignoreFile = '.npmignore';
    else if (walked.has('.gitignore')) ignoreFile = '.gitignore';
    if (ignoreFile !== null) {
      let body = '';
      try { body = readFileSync(rootAbs + '/' + ignoreFile, 'utf8'); } catch { /* unreadable: no lines */ }
      const pats = ignoreLines(body).map((l) => readPattern(l, false));
      chosen = candidates.filter((p) => { const d = decide(pats, p); return !(d !== null && !d.neg); });
      how = ignoreFile;
    } else {
      chosen = candidates.slice();
      how = 'all';
    }
  }
  const packedSet = new Set(chosen);

  // step 3
  packedSet.add('package.json');
  for (const p of candidates) {
    if (p.includes('/')) continue;
    const low = p.toLowerCase();
    if (/^(readme|license|licence)(\.|$)/.test(low)) packedSet.add(p);
  }
  const targets = collectTargets(manifest);
  for (const t of targets) {
    if (t.kind !== 'main' && t.kind !== 'browser' && t.kind !== 'bin') continue;
    if (pointsOutside(t.s)) continue;
    const p = pathOf(t.s);
    if (candidateSet.has(p)) packedSet.add(p);
  }
  const list = [...packedSet].sort(cmp);
  let size = 0;
  for (const p of list) size += walked.get(p);

  // the entry rules
  const readText = (p) => {
    try {
      const s = readFileSync(rootAbs + '/' + p, 'utf8');
      return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    } catch { return ''; }
  };
  const type = manifest.type === 'module' || manifest.type === 'commonjs' ? manifest.type : null;
  const tokenCache = new Map();
  const tokensOf = (p) => {
    if (!tokenCache.has(p)) tokenCache.set(p, tokenizeFile(readText(p)));
    return tokenCache.get(p);
  };
  const notPackedFix = (p, isPattern) => {
    if (!isPattern && isLeftOut(p)) return `npm never packs ${q(p)}; point the field at another file`;
    if (how === 'files') return isPattern ? 'add the files to the files field of package.json' : `add ${q(p)} to the files field of package.json`;
    if (how === '.npmignore' || how === '.gitignore') return isPattern ? `remove the lines of ${how} that ignore these files` : `remove the line of ${how} that ignores ${q(p)}`;
    return isPattern ? 'make sure npm packs these files' : `make sure npm packs ${q(p)}`;
  };
  for (const t of targets) {
    const { field, s } = t;
    const isExports = t.kind === 'exports';
    if (isExports && !s.startsWith('./')) {
      findings.push(finding('exports-form', field, s, `${q(s)} does not start with "./"`, 'start every exports target with "./", for example "./lib/index.js"'));
      continue;
    }
    if (pointsOutside(s)) {
      findings.push(finding('entry-outside', field, s, `${q(s)} points outside the package folder`, 'point it at a file inside the package folder with a relative path such as "./lib/index.js"'));
      continue;
    }
    const isPattern = isExports && s.includes('*');
    let p = null;
    let exists;
    let packed;
    if (isPattern) {
      const re = globRegExp(s);
      exists = [...walked.keys()].some((x) => re.test(x));
      packed = list.some((x) => re.test(x));
    } else {
      p = pathOf(s);
      exists = p !== '' && walked.has(p);
      packed = exists && packedSet.has(p);
    }
    if (!exists) {
      findings.push(finding('entry-missing', field, s, isPattern ? `${q(s)} matches no file in the package folder` : `${q(s)} does not exist in the package folder`, isPattern ? 'create the files the pattern names, or correct the pattern' : `build or create the file, or correct the path in ${field}`));
      continue;
    }
    if (!packed) {
      findings.push(finding('entry-not-packed', field, s, isPattern ? `${q(s)} matches files but npm would not pack any of them` : `${q(s)} exists but npm would not pack it`, notPackedFix(p, isPattern)));
      continue;
    }
    if (isPattern) continue;
    if (t.kind === 'bin') {
      let head = Buffer.alloc(2);
      let got = 0;
      try {
        const fd = openSync(rootAbs + '/' + p, 'r');
        try { got = readSync(fd, head, 0, 2, 0); } finally { closeSync(fd); }
      } catch { /* unreadable: no shebang */ }
      if (got < 2 || head[0] !== 0x23 || head[1] !== 0x21) {
        findings.push(finding('bin-shebang', field, s, `${q(s)} does not begin with "#!"`, 'add a first line such as #!/usr/bin/env node to the file'));
      }
    }
    if (type !== null && (t.kind === 'main' || t.kind === 'bin' || isExports) && p.endsWith('.js')) {
      const toks = tokensOf(p);
      if (type === 'module' && usesCommonJS(toks)) {
        findings.push(finding('type-mismatch', field, s, `${q(s)} is a .js file of a "type": "module" package but it uses CommonJS (require or module.exports)`, 'write it with import and export, or rename it to .cjs'));
      } else if (type === 'commonjs' && usesEsm(toks)) {
        findings.push(finding('type-mismatch', field, s, `${q(s)} is a .js file of a "type": "commonjs" package but it uses ES module syntax (import or export)`, 'write it with require and module.exports, or rename it to .mjs'));
      }
    }
  }

  // types first
  if (manifest.exports !== undefined) {
    const found = [];
    typesOrder(manifest.exports, 'exports', found);
    for (const f of found) {
      findings.push(finding('types-order', f.field, f.value, `"types" is not the first key of its conditions object${typeof f.value === "string" ? " (it points at " + q(f.value) + ")" : ""}, so TypeScript may skip it`, 'move the "types" key to the first place in the conditions object'));
    }
  }

  // metadata
  const meta = (name, field, v, valid, wrong, fix) => {
    if (v === undefined || v === null) findings.push(finding(`${name}-missing`, field, null, `package.json has no ${field}`, fix));
    else if (!valid(v)) findings.push(finding(`${name}-invalid`, field, v, `${typeof v === "string" ? q(v) : asText(v)} ${wrong}`, fix));
  };
  meta('license', 'license', manifest.license, validLicense, 'is not a valid SPDX license expression', 'set "license" to an SPDX id such as "MIT" or "Apache-2.0"');
  meta('repository', 'repository', manifest.repository, (v) => nonBlank(v) || (isObj(v) && nonBlank(v.url)), 'is not a repository string or an object with a "url"', 'set "repository" to the URL of your repository');
  const node = isObj(manifest.engines) ? manifest.engines.node : undefined;
  meta('engines-node', 'engines.node', node, nonBlank, 'is not a non-empty version range', 'set "engines": {"node": ">=22"} (or the range you support)');
  meta('description', 'description', manifest.description, nonBlank, 'is not a non-empty string', 'add a one-line "description" to package.json');

  // files that look like secrets or junk
  for (const p of list) {
    const parts = p.split('/');
    const last = parts[parts.length - 1].toLowerCase();
    const folders = parts.slice(0, -1);
    if (SECRET_EXACT.has(last) || (last.startsWith('.env.') && !ENV_OK.has(last)) || SECRET_END.some((e) => last.endsWith(e))) {
      findings.push(finding('packed-secret', null, p, `${q(p)} looks like a secret or credentials file and would be published`, 'leave it out of the package (files, .npmignore or .gitignore) and rotate the secret if it was ever published'));
    }
    if (JUNK_NAMES.has(last) || JUNK_END.some((e) => last.endsWith(e)) || folders.some((f) => JUNK_DIRS.has(f))) {
      findings.push(finding('packed-junk', null, p, `${q(p)} is an editor, OS or build leftover and would be published`, 'leave it out of the package (files, .npmignore or .gitignore)'));
    }
    if (walked.get(p) > 102400 && folders.some((f) => FIXTURE_DIRS.has(f))) {
      findings.push(finding('packed-fixture', null, p, `${q(p)} is a large test fixture (${walked.get(p)} bytes) and would be published`, 'leave test fixtures out of the package (files, .npmignore or .gitignore)'));
    }
  }

  if (opts.maxSize !== null && BigInt(size) > opts.maxSize) {
    findings.push(finding('package-too-large', null, size, `the packed size is ${size} bytes, over the limit of ${opts.maxSize} bytes`, 'leave out the files users do not need, for example with the files field'));
  }
  return { findings, files: list.length, size, list };
}

// ---------------------------------------------------------------- command line

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { dir: null, json: false, list: false, failOn: 'error', maxSize: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--list') o.list = true;
    else if (a === '--fail-on') {
      if (i + 1 >= argv.length) throw new UsageError('--fail-on needs an argument: error, warning or none');
      const v = argv[++i];
      if (v !== 'error' && v !== 'warning' && v !== 'none') throw new UsageError(`--fail-on must be error, warning or none, not ${JSON.stringify(v)}`);
      o.failOn = v;
    } else if (a === '--max-size') {
      if (i + 1 >= argv.length) throw new UsageError('--max-size needs an argument: a number of bytes');
      const v = argv[++i];
      if (!/^[0-9]+$/.test(v)) throw new UsageError(`--max-size must be digits only, not ${JSON.stringify(v)}`);
      o.maxSize = BigInt(v);
    } else if (a.startsWith('-')) throw new UsageError(`unknown option ${JSON.stringify(a)}`);
    else {
      if (o.dir !== null) throw new UsageError('more than one folder given');
      o.dir = a;
    }
  }
  const dir = o.dir ?? '.';
  let st;
  try { st = statSync(dir); } catch { throw new UsageError(`${JSON.stringify(dir)} does not exist`); }
  if (!st.isDirectory()) throw new UsageError(`${JSON.stringify(dir)} is not a folder`);
  o.root = resolvePath(dir).replace(/\\/g, '/');
  return o;
}

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`publish-check: ${e.message}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const res = check(o.root, o);
  const findings = res.findings.slice();
  const keyOf = (f) => [f.rule, f.field ?? '', typeof f.value === 'string' ? f.value : ser(f.value)];
  findings.sort((a, b) => {
    const x = keyOf(a);
    const y = keyOf(b);
    return cmp(x[0], y[0]) || cmp(x[1], y[1]) || cmp(x[2], y[2]);
  });
  const counts = { error: 0, warning: 0 };
  for (const f of findings) counts[f.severity]++;
  let out;
  if (o.json) {
    const rep = { tool: 'publish-check', version: VERSION, findings, packed: { files: res.files, size: res.size }, counts };
    if (o.list) rep.list = res.list;
    out = ser(rep, 2) + '\n';
  } else {
    out = '';
    for (const f of findings) {
      const subject = f.field !== null ? f.field : asText(f.value);
      out += `${f.severity} ${f.rule} ${subject}: ${f.message} Fix: ${f.fix}\n`;
    }
    if (o.list) for (const p of res.list) out += `packed ${safe(p)}\n`;
    out += `publish-check: ${counts.error} errors, ${counts.warning} warnings, ${res.files} files, ${res.size} bytes\n`;
  }
  process.stdout.write(out);
  const counted = o.failOn === 'none' ? 0 : o.failOn === 'warning' ? counts.error + counts.warning : counts.error;
  process.exitCode = counted > 0 ? 1 : 0;
}

main(process.argv.slice(2));
