import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../publish-check.mjs', import.meta.url));

let TMP;
before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-check-test-')); });
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

let counter = 0;
// Lay a package down: { 'a/b.js': 'text' } (a Buffer is written as it is). Returns its folder.
function pkg(files) {
  const dir = path.join(TMP, 'p' + counter++);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}
function run(args, cwd) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: cwd ?? TMP, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
// A manifest with every metadata field right, so a test sees only what it is about.
const BASE = {
  name: 'demo',
  version: '1.0.0',
  description: 'a demo package',
  license: 'MIT',
  repository: 'git+https://example.com/demo.git',
  engines: { node: '>=22' },
};
const manifest = (extra = {}) => JSON.stringify({ ...BASE, ...extra }, null, 2);
// Run on a folder with --json and return the parsed report.
function report(files, args = []) {
  const dir = pkg(files);
  const r = run([dir, '--json', '--list', '--fail-on', 'none', ...args]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  return JSON.parse(r.out);
}
const short = (rep) => rep.findings.map((f) => `${f.rule} ${f.field} ${JSON.stringify(f.value)}`);
const rulesOf = (rep) => rep.findings.map((f) => f.rule);
// The packed list for a manifest and some files.
const packedList = (extra, files) => report({ 'package.json': manifest(extra), ...files }).list;

// ---------------------------------------------------------------- usage errors

test('usage errors: message on stderr, nothing on stdout, status 2', () => {
  const dir = pkg({ 'package.json': manifest() });
  const other = pkg({ 'package.json': manifest() });
  const file = path.join(dir, 'package.json');
  const cases = [
    ['--bogus'], ['--'], ['-'], ['-x'], ['--fail-on=error'], ['--max-size=10'], ['--JSON'], ['--help'], ['-h'],
    ['--fail-on'], ['--max-size'], [dir, '--fail-on'], [dir, '--max-size'],
    ['--fail-on', 'errors'], ['--fail-on', 'Error'], ['--fail-on', ''], ['--fail-on', '--json'],
    ['--max-size', ''], ['--max-size', '-1'], ['--max-size', '1.5'], ['--max-size', '1e3'], ['--max-size', '10 '], ['--max-size', 'abc'], ['--max-size', '--list'],
    [dir, other], [dir, dir],
    [path.join(TMP, 'does-not-exist')], [file], ['--json', path.join(TMP, 'nope')],
  ];
  for (const args of cases) {
    const r = run(args);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.equal(r.out, '', JSON.stringify(args));
    assert.notEqual(r.err.trim(), '', JSON.stringify(args));
  }
});

test('usage errors win over a good package and a missing package.json', () => {
  const dir = pkg({ 'package.json': manifest() });
  const empty = pkg({ 'x.txt': 'x' });
  assert.equal(run([dir, '--list', '--bogus']).code, 2);
  assert.equal(run([empty, '--fail-on', 'nope']).code, 2);
});

test('an option value is whatever comes next, even a name that looks like an option', () => {
  const dir = pkg({ 'package.json': manifest() });
  // "--list" after --max-size is its value, so it is not digits: a usage error
  assert.equal(run([dir, '--max-size', '--list']).code, 2);
  // "--json" after --fail-on is its value, so it is not a level: a usage error
  assert.equal(run([dir, '--fail-on', '--json']).code, 2);
});

test('options may come before or after the folder and may repeat; the last value wins', () => {
  const dir = pkg({ 'package.json': manifest({ main: 'missing.js' }) });
  assert.equal(run(['--json', dir]).code, 1);
  assert.equal(run([dir, '--json']).code, 1);
  assert.equal(run([dir, '--fail-on', 'none', '--fail-on', 'error']).code, 1);
  assert.equal(run([dir, '--fail-on', 'error', '--fail-on', 'none']).code, 0);
  const small = pkg({ 'package.json': manifest() });
  assert.equal(run([small, '--max-size', '1', '--max-size', '100000']).code, 0);
  assert.equal(run([small, '--max-size', '100000', '--max-size', '1']).code, 1);
  // repeating --json and --list is fine
  const r = run([dir, '--json', '--json', '--list', '--list', '--fail-on', 'none']);
  assert.equal(r.code, 0);
  JSON.parse(r.out);
});

test('the folder: default is the current directory, relative or absolute both work', () => {
  const dir = pkg({ 'package.json': manifest({ main: 'a.js' }), 'a.js': '' });
  const viaCwd = JSON.parse(run(['--json', '--list'], dir).out);
  assert.deepEqual(viaCwd.list, ['a.js', 'package.json']);
  const parent = path.dirname(dir);
  const rel = JSON.parse(run([path.basename(dir), '--json', '--list'], parent).out);
  assert.deepEqual(rel.list, ['a.js', 'package.json']);
  const dotted = JSON.parse(run(['./' + path.basename(dir) + '/', '--json'], parent).out);
  assert.equal(dotted.packed.files, 2);
  const abs = JSON.parse(run([dir, '--json'], os.tmpdir()).out);
  assert.equal(abs.packed.files, 2);
});

// ---------------------------------------------------------------- package.json

test('package-json: missing, invalid, not an object, not a regular file', () => {
  const cases = {
    missing: { 'a.js': 'x' },
    invalid: { 'package.json': '{ "name": ', 'a.js': 'x' },
    empty: { 'package.json': '', 'a.js': 'x' },
    array: { 'package.json': '[]', 'a.js': 'x' },
    string: { 'package.json': '"x"', 'a.js': 'x' },
    number: { 'package.json': '12', 'a.js': 'x' },
    null: { 'package.json': 'null', 'a.js': 'x' },
    trailingComma: { 'package.json': '{"name":"x",}', 'a.js': 'x' },
  };
  for (const [name, files] of Object.entries(cases)) {
    const rep = report(files);
    assert.deepEqual(short(rep), ['package-json null null'], name);
    assert.equal(rep.findings[0].severity, 'error', name);
    assert.deepEqual(rep.packed, { files: 0, size: 0 }, name);
    assert.deepEqual(rep.counts, { error: 1, warning: 0 }, name);
    assert.deepEqual(rep.list, [], name);
  }
  // package.json a folder
  const dir = pkg({ 'package.json/x': 'x' });
  const rep = JSON.parse(run([dir, '--json']).out);
  assert.deepEqual(short(rep), ['package-json null null']);
});

test('package-json: plain output and exit codes', () => {
  const dir = pkg({ 'a.js': 'x' });
  const r = run([dir]);
  assert.equal(r.code, 1);
  const lines = r.out.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '');
  assert.match(lines[0], /^error package-json null: .+ Fix: .+$/);
  assert.equal(lines[1], 'publish-check: 1 errors, 0 warnings, 0 files, 0 bytes');
  assert.equal(run([dir, '--fail-on', 'warning']).code, 1);
  assert.equal(run([dir, '--fail-on', 'none']).code, 0);
  assert.equal(run([dir, '--list']).out.split('\n').length, 3, 'nothing is packed, so no packed lines');
  assert.equal(run([dir, '--max-size', '0']).code, 1);
  assert.deepEqual(short(JSON.parse(run([dir, '--max-size', '0', '--json']).out)), ['package-json null null']);
});

test('package.json: a leading byte-order mark is dropped', () => {
  const rep = report({ 'package.json': '﻿' + manifest({ main: 'a.js' }), 'a.js': '' });
  assert.deepEqual(rep.findings, []);
  assert.deepEqual(rep.list, ['a.js', 'package.json']);
});

test('only the root package.json is read', () => {
  const rep = report({ 'package.json': manifest(), 'sub/package.json': '{ not json' });
  assert.deepEqual(rep.findings, []);
  assert.deepEqual(rep.list, ['package.json', 'sub/package.json']);
});

// ---------------------------------------------------------------- walking

test('walking: .git and node_modules are not entered at any depth; dot files and folders are', () => {
  const list = packedList({}, {
    '.git/config': 'x', 'a/.git/config': 'x', 'node_modules/m/index.js': 'x', 'a/b/node_modules/m.js': 'x',
    '.hidden/file.txt': 'x', '.dotfile': 'x', 'a/b/c/d.txt': 'x', 'empty-folder/.keep-not': 'x',
  });
  assert.deepEqual(list, ['.dotfile', '.hidden/file.txt', 'a/b/c/d.txt', 'empty-folder/.keep-not', 'package.json']);
});

test('walking: a folder with no file adds nothing; a file named .git is a file', () => {
  const dir = pkg({ 'package.json': manifest(), 'x.txt': '' });
  fs.mkdirSync(path.join(dir, 'empty', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub-file'), 'x');
  const rep = JSON.parse(run([dir, '--json', '--list']).out);
  assert.deepEqual(rep.list, ['package.json', 'sub-file', 'x.txt']);
  const dir2 = pkg({ 'package.json': manifest(), '.git': 'gitdir: ../x' });
  assert.deepEqual(JSON.parse(run([dir2, '--json', '--list']).out).list, ['.git', 'package.json']);
});

test('walking: symbolic links are not followed and not listed', (t) => {
  const dir = pkg({ 'package.json': manifest({ main: 'link.js' }), 'real.js': 'x', 'folder/inner.js': 'x' });
  try {
    fs.symlinkSync(path.join(dir, 'real.js'), path.join(dir, 'link.js'));
    fs.symlinkSync(path.join(dir, 'folder'), path.join(dir, 'folderlink'));
  } catch {
    t.skip('symbolic links cannot be made here');
    return;
  }
  const rep = JSON.parse(run([dir, '--json', '--list']).out);
  assert.deepEqual(rep.list, ['folder/inner.js', 'package.json', 'real.js']);
  assert.deepEqual(short(rep), ['entry-missing main "link.js"']);
  // a package.json that is a link is not a regular file
  const dir2 = pkg({ 'real.json': manifest() });
  try { fs.symlinkSync(path.join(dir2, 'real.json'), path.join(dir2, 'package.json')); } catch { return; }
  assert.deepEqual(short(JSON.parse(run([dir2, '--json']).out)), ['package-json null null']);
});

test('the package folder may itself be reached through a link', (t) => {
  const dir = pkg({ 'package.json': manifest() });
  const link = path.join(TMP, 'link-to-' + path.basename(dir));
  try { fs.symlinkSync(dir, link, 'junction'); } catch { t.skip('links cannot be made here'); return; }
  assert.equal(JSON.parse(run([link, '--json']).out).packed.files, 1);
});

test('the tool never changes a file', () => {
  const dir = pkg({ 'package.json': manifest({ main: 'a.js', bin: 'b.js' }), 'a.js': 'x', 'b.js': 'y', '.npmignore': 'a.js\n', 'sub/c.txt': 'z' });
  const snap = () => {
    const out = [];
    const go = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { out.push(p + '/'); go(p); } else out.push(p + ':' + fs.readFileSync(p, 'utf8') + ':' + fs.statSync(p).mtimeMs);
      }
    };
    go(dir);
    return out.sort();
  };
  const before = snap();
  run([dir, '--list']);
  run([dir, '--json']);
  assert.deepEqual(snap(), before);
});

// ---------------------------------------------------------------- step 1: left out always

test('step 1: files npm always leaves out', () => {
  const left = {
    '.DS_Store': 'x', 'a/.DS_Store': 'x', '.npmrc': 'x', 'a/.npmrc': 'x', '.npmignore': '', 'a/.npmignore': 'x', '.gitignore': '', 'a/.gitignore': 'x',
    '.lock-wscript': 'x', 'npm-debug.log': 'x', 'a/npm-debug.log': 'x', 'config.gypi': 'x', 'a/config.gypi': 'x',
    '._resource': 'x', 'a/._x': 'x', 'old.orig': 'x', 'a/b.js.orig': 'x',
    '.a.swp': 'x', '.file.swp': 'x', 'sub/.x.swp': 'x', '.wafpickle-7': 'x', 'a/.wafpickle-123': 'x',
    '.svn/entries': 'x', 'a/.svn/entries': 'x', '.hg/store': 'x', 'a/.hg/x': 'x', 'CVS/Root': 'x', 'a/b/CVS/Entries': 'x',
    'package-lock.json': '{}', 'yarn.lock': 'x', 'pnpm-lock.yaml': 'x', 'bun.lockb': 'x',
  };
  const kept = {
    '.swp': 'x', 'a.swp': 'x', '.wafpickle-': 'x', '.wafpickle-12a': 'x', '.wafpickle': 'x', '.orig-not': 'x',
    'a/package-lock.json': '{}', 'a/yarn.lock': 'x', 'a/pnpm-lock.yaml': 'x', 'a/bun.lockb': 'x', 'npm-debug.log.txt': 'x', '.npmrc.bak': 'x', 'x.DS_Store': 'x',
    'a/_x': 'x', '_x': 'x', 'sub/svn/x': 'x',
  };
  const list = packedList({}, { ...left, ...kept });
  assert.deepEqual(list, [...Object.keys(kept), 'package.json'].sort());
  // the folder names are case sensitive (one package each: file systems may fold case)
  assert.deepEqual(packedList({}, { 'cvs/x': '' }), ['cvs/x', 'package.json']);
  assert.deepEqual(packedList({}, { '.SVN/x': '' }), ['.SVN/x', 'package.json']);
  assert.deepEqual(packedList({}, { 'Cvs/x': '', '.Hg/y': '' }), ['.Hg/y', 'Cvs/x', 'package.json']);
});

test('step 1: a left-out file cannot be brought back by files, main, browser or bin', () => {
  const rep = report({
    'package.json': manifest({ files: ['.npmrc', 'package-lock.json', 'a.orig'], main: 'a.orig', browser: '.npmrc', bin: 'package-lock.json' }),
    '.npmrc': 'x', 'package-lock.json': '{}', 'a.orig': 'x',
  });
  assert.deepEqual(rep.list, ['package.json']);
  assert.deepEqual(rep.findings.map((f) => f.rule), ['entry-not-packed', 'entry-not-packed', 'entry-not-packed']);
});

// ---------------------------------------------------------------- step 2 and 3: which files are packed

test('step 2: no files, no ignore file: every candidate is packed', () => {
  assert.deepEqual(packedList({}, { 'a.js': '', 'b/c.js': '', 'tests/t.js': '' }), ['a.js', 'b/c.js', 'package.json', 'tests/t.js']);
});

test('step 2: the .npmignore rule, and an empty .npmignore ignores nothing', () => {
  const files = { 'a.js': '', 'a.log': '', 'x/y/b.log': '', 'build/out.js': '', 'src/build/o.js': '', 'keep.log': '', 'docs/internal/n.md': '', 'docs/pub/n.md': '', 'root.js': '', 'sub/root.js': '' };
  const list = packedList({}, { ...files, '.npmignore': '*.log\n!keep.log\nbuild\ndocs/internal\n/root.js\n' });
  assert.deepEqual(list, ['a.js', 'docs/pub/n.md', 'keep.log', 'package.json', 'sub/root.js']);
  assert.deepEqual(packedList({}, { 'a.js': '', '.npmignore': '' }), ['a.js', 'package.json']);
});

test('step 2: .npmignore wins over .gitignore; .gitignore is used when it is alone', () => {
  const files = { 'a.js': '', 'b.js': '', 'c.js': '' };
  assert.deepEqual(packedList({}, { ...files, '.npmignore': 'a.js\n', '.gitignore': 'b.js\n' }), ['b.js', 'c.js', 'package.json']);
  assert.deepEqual(packedList({}, { ...files, '.gitignore': 'b.js\n' }), ['a.js', 'c.js', 'package.json']);
});

test('step 2: with a files array the ignore files are not read at all', () => {
  const files = { 'a.js': '', 'b.js': '', '.npmignore': 'a.js\n', '.gitignore': 'a.js\n' };
  assert.deepEqual(packedList({ files: ['a.js'] }, files), ['a.js', 'package.json']);
  assert.deepEqual(packedList({ files: [] }, files), ['package.json']);
  // files that is not an array does not count
  assert.deepEqual(packedList({ files: 'a.js' }, files), ['b.js', 'package.json']);
  assert.deepEqual(packedList({ files: { a: 1 } }, { 'a.js': '' }), ['a.js', 'package.json']);
  assert.deepEqual(packedList({ files: null }, { 'a.js': '' }), ['a.js', 'package.json']);
});

test('ignore files: how lines are read', () => {
  const files = { 'a.js': '', 'b.js': '', 'c.js': '', 'd.js': '', '#e.js': '', 'sp ace.js': '' };
  // comments, empty lines, a line of spaces only, trailing \r, spaces and tabs; a backslash is a plain character
  const text = '# a comment\r\n\r\na.js\r\n   \nb.js  \t\n\\#e.js\n#c.js\nd.js \r\n';
  const list = packedList({}, { ...files, '.npmignore': text });
  assert.deepEqual(list, ['#e.js', 'c.js', 'package.json', 'sp ace.js']);
});

test('ignore patterns: anchoring, folders only, leading slashes, stars, question marks', () => {
  const files = {
    'build': 'a file named build', 'x/build': 'nested file', 'dist/a.js': '', 'x/dist/a.js': '', 'lib/dist/z.js': '',
    'a.tmp': '', 'x/.hidden.tmp': '', 'q1.txt': '', 'q22.txt': '', 'x/y/deep.txt': '', 'top.txt': '', 'x/top.txt': '',
  };
  const packed = (lines) => packedList({}, { ...files, '.npmignore': lines });
  const all = Object.keys(files);
  const without = (...gone) => [...all.filter((f) => !gone.includes(f)), 'package.json'].sort();
  assert.deepEqual(packed('build\n'), without('build', 'x/build'));
  assert.deepEqual(packed('build/\n'), without());
  assert.deepEqual(packed('dist/\n'), without('dist/a.js', 'x/dist/a.js', 'lib/dist/z.js'));
  assert.deepEqual(packed('/dist\n'), without('dist/a.js'));
  assert.deepEqual(packed('//dist\n'), without('dist/a.js'));
  assert.deepEqual(packed('lib/dist\n'), without('lib/dist/z.js'));
  assert.deepEqual(packed('*.tmp\n'), without('a.tmp', 'x/.hidden.tmp'));
  assert.deepEqual(packed('q?.txt\n'), without('q1.txt'));
  assert.deepEqual(packed('q??.txt\n'), without('q22.txt'));
  assert.deepEqual(packed('/top.txt\n'), without('top.txt'));
  assert.deepEqual(packed('top.txt\n'), without('top.txt', 'x/top.txt'));
  assert.deepEqual(packed('x/**/deep.txt\n'), without('x/y/deep.txt'));
  assert.deepEqual(packed('**/deep.txt\n'), without('x/y/deep.txt'));
  assert.deepEqual(packed('x/*/deep.txt\n'), without('x/y/deep.txt'));
  assert.deepEqual(packed('x/*/*/deep.txt\n'), without());
  assert.deepEqual(packed('.*\n'), without('x/.hidden.tmp'));
  assert.deepEqual(packed('/\n'), without());
  assert.deepEqual(packed('!\n'), without());
});

test('ignore patterns: the last matching pattern decides, negations included', () => {
  const files = { 'lib/a.js': '', 'lib/test/b.js': '', 'lib/keep/c.js': '' };
  assert.deepEqual(packedList({}, { ...files, '.npmignore': 'lib\n!lib/keep\n' }), ['lib/keep/c.js', 'package.json']);
  assert.deepEqual(packedList({}, { ...files, '.npmignore': '!lib/keep\nlib\n' }), ['package.json']);
  assert.deepEqual(packedList({}, { ...files, '.npmignore': 'lib/test\n' }), ['lib/a.js', 'lib/keep/c.js', 'package.json']);
  // only one leading "!" is a negation
  assert.deepEqual(packedList({}, { '!!x.js': '', 'x.js': '', '!x.js': '', '.npmignore': '*.js\n!!x.js\n' }), ['!x.js', 'package.json']);
});

test('files patterns: always anchored, folders, stars, negation, order', () => {
  const tree = {
    'a.js': '', 'x/a.js': '', 'lib/a.js': '', 'lib/sub/b.js': '', 'lib/test/t.js': '', 'lib/sub/deep/c.txt': '', 'dist/o.js': '', 'q1.js': '', 'q22.js': '', 'readme-notes.md': '',
  };
  const list = (files) => packedList({ files }, tree);
  assert.deepEqual(list(['*.js']), ['a.js', 'package.json', 'q1.js', 'q22.js']);
  assert.deepEqual(list(['a.js']), ['a.js', 'package.json']);
  assert.deepEqual(list(['/a.js']), ['a.js', 'package.json']);
  assert.deepEqual(list(['./a.js']), ['a.js', 'package.json']);
  assert.deepEqual(list(['lib']), ['lib/a.js', 'lib/sub/b.js', 'lib/sub/deep/c.txt', 'lib/test/t.js', 'package.json']);
  assert.deepEqual(list(['lib/']), ['lib/a.js', 'lib/sub/b.js', 'lib/sub/deep/c.txt', 'lib/test/t.js', 'package.json']);
  assert.deepEqual(list(['./lib/sub']), ['lib/sub/b.js', 'lib/sub/deep/c.txt', 'package.json']);
  assert.deepEqual(list(['lib/*.js']), ['lib/a.js', 'package.json']);
  assert.deepEqual(list(['lib/**/*.js']), ['lib/a.js', 'lib/sub/b.js', 'lib/test/t.js', 'package.json']);
  assert.deepEqual(list(['**/*.js']), ['a.js', 'dist/o.js', 'lib/a.js', 'lib/sub/b.js', 'lib/test/t.js', 'package.json', 'q1.js', 'q22.js', 'x/a.js']);
  assert.deepEqual(list(['**']), Object.keys(tree).concat('package.json').sort());
  assert.deepEqual(list(['q?.js']), ['package.json', 'q1.js']);
  assert.deepEqual(list(['lib', '!lib/test']), ['lib/a.js', 'lib/sub/b.js', 'lib/sub/deep/c.txt', 'package.json']);
  assert.deepEqual(list(['!lib/test', 'lib']), ['lib/a.js', 'lib/sub/b.js', 'lib/sub/deep/c.txt', 'lib/test/t.js', 'package.json']);
  assert.deepEqual(list(['lib', '!lib/test', 'lib/test/t.js']), ['lib/a.js', 'lib/sub/b.js', 'lib/sub/deep/c.txt', 'lib/test/t.js', 'package.json']);
  assert.deepEqual(list(['nothing-matches']), ['package.json']);
  assert.deepEqual(list(['', '/', '//']), ['package.json']);
  assert.deepEqual(list(['lib', 5, null, { a: 1 }, ['x'], true]), ['lib/a.js', 'lib/sub/b.js', 'lib/sub/deep/c.txt', 'lib/test/t.js', 'package.json']);
  // entries are not trimmed
  assert.deepEqual(list(['a.js ']), ['package.json']);
  // a pattern that names a folder with a trailing slash does not match a file of that name
  assert.deepEqual(packedList({ files: ['x/'] }, { x: 'a file' }), ['package.json']);
});

test('patterns: [ ] { } \\ and ! are plain characters; matching is case sensitive', () => {
  const tree = { '[ab].js': '', 'a.js': '', '{x,y}.js': '', 'x.js': '', 'we!rd.js': '', 'Case.js': '' };
  const list = (files) => packedList({ files }, tree);
  assert.deepEqual(list(['[ab].js']), ['[ab].js', 'package.json']);
  assert.deepEqual(list(['{x,y}.js']), ['package.json', '{x,y}.js']);
  assert.deepEqual(list(['we!rd.js']), ['package.json', 'we!rd.js']);
  assert.deepEqual(list(['Case.js']), ['Case.js', 'package.json']);
  assert.deepEqual(list(['case.js']), ['package.json']);
  assert.deepEqual(packedList({}, { ...tree, '.npmignore': '[ab].js\n{x,y}.js\n' }), ['Case.js', 'a.js', 'package.json', 'we!rd.js', 'x.js']);
});

test('patterns: a "**" among other characters is read as "*"; ? is one code point', () => {
  const tree = { 'ab.js': '', 'a/b.js': '', 'axb.js': '', '😀.txt': '', 'ab.txt': '' };
  assert.deepEqual(packedList({ files: ['a**b.js'] }, tree), ['ab.js', 'axb.js', 'package.json']);
  assert.deepEqual(packedList({ files: ['?.txt'] }, tree), ['package.json', '😀.txt']);
  assert.deepEqual(packedList({ files: ['??.txt'] }, tree), ['ab.txt', 'package.json']);
});

test('step 3: always included files', () => {
  // each root name in its own package, to stay safe on case-insensitive file systems
  for (const name of ['README', 'readme.md', 'Readme.TXT', 'LICENSE', 'licence.txt', 'License.md', 'LICENCE', 'readme']) {
    assert.deepEqual(packedList({ files: [] }, { [name]: '', 'other.js': '' }), [name, 'package.json'].sort(), name);
  }
  for (const name of ['README-old.md', 'LICENSES.md', 'LICENSE-MIT', 'docs/README.md', 'READMEmd']) {
    assert.deepEqual(packedList({ files: [] }, { [name]: '' }), ['package.json'], name);
  }
});

test('step 3: main, browser and bin targets are packed whatever the files say', () => {
  const tree = { 'lib/main.js': '', 'lib/browser.js': '', 'bin/a.js': '#!/usr/bin/env node\n', 'bin/b.js': '#!/usr/bin/env node\n', 'lib/other.js': '', 'x.js': '' };
  const m = { files: ['x.js'], main: './lib//main.js', browser: 'lib/browser.js', bin: { a: './bin/a.js', b: 'bin/b.js', c: 5 } };
  const rep = report({ 'package.json': manifest(m), ...tree });
  assert.deepEqual(rep.list, ['bin/a.js', 'bin/b.js', 'lib/browser.js', 'lib/main.js', 'package.json', 'x.js']);
  assert.deepEqual(rep.findings, []);
  const rep2 = report({ 'package.json': manifest({ files: [], bin: 'bin/a.js' }), 'bin/a.js': '#!x\n' });
  assert.deepEqual(rep2.list, ['bin/a.js', 'package.json']);
  // module, types, typings and exports targets are not added
  const rep3 = report({ 'package.json': manifest({ files: [], module: 'm.js', types: 't.d.ts', typings: 'u.d.ts', exports: './e.js' }), 'm.js': '', 't.d.ts': '', 'u.d.ts': '', 'e.js': '' });
  assert.deepEqual(rep3.list, ['package.json']);
  assert.deepEqual(rulesOf(rep3), ['entry-not-packed', 'entry-not-packed', 'entry-not-packed', 'entry-not-packed']);
});

test('step 3: a target outside the package names nothing', () => {
  const rep = report({ 'package.json': manifest({ files: [], main: '../x.js' }), 'x.js': '' });
  assert.deepEqual(rep.list, ['package.json']);
  assert.deepEqual(short(rep), ['entry-outside main "../x.js"']);
});

test('packed.files and packed.size count the packed files and their bytes', () => {
  const text = manifest({ files: ['a.txt', 'sub'] });
  const rep = report({ 'package.json': text, 'a.txt': 'abc', 'sub/b.txt': Buffer.alloc(1000, 1), 'skipped.txt': 'xxxxx', 'sub/ü.txt': 'ü' });
  assert.deepEqual(rep.list, ['a.txt', 'package.json', 'sub/b.txt', 'sub/ü.txt']);
  assert.equal(rep.packed.files, 4);
  assert.equal(rep.packed.size, Buffer.byteLength(text) + 3 + 1000 + 2);
});

test('the sorted list compares code units', () => {
  const list = packedList({}, { 'bb': '', 'B': '', 'a/z': '', 'a.b': '', 'a-b': '', '_x': '', 'Z': '' });
  assert.deepEqual(list, ['B', 'Z', '_x', 'a-b', 'a.b', 'a/z', 'bb', 'package.json']);
});

// ---------------------------------------------------------------- entry rules

test('entry rules: main and the other plain fields', () => {
  const fields = ['main', 'module', 'types', 'typings', 'browser'];
  for (const f of fields) {
    const ok = report({ 'package.json': manifest({ files: ['lib'], [f]: './lib//x.js' }), 'lib/x.js': '' });
    assert.deepEqual(ok.findings, [], f);
    const missing = report({ 'package.json': manifest({ [f]: './nope.js' }) });
    assert.deepEqual(short(missing), [`entry-missing ${f} "./nope.js"`], f);
    const outside = report({ 'package.json': manifest({ [f]: '../x.js' }), 'x.js': '' });
    assert.deepEqual(short(outside), [`entry-outside ${f} "../x.js"`], f);
    const abs = report({ 'package.json': manifest({ [f]: '/etc/x.js' }) });
    assert.deepEqual(short(abs), [`entry-outside ${f} "/etc/x.js"`], f);
    const notPacked = report({ 'package.json': manifest({ files: [], [f]: 'x.js' }), 'x.js': '' });
    const expected = f === 'main' || f === 'browser' ? [] : [`entry-not-packed ${f} "x.js"`];
    assert.deepEqual(short(notPacked), expected, f);
  }
});

test('entry rules: severity, message and fix', () => {
  const rep = report({ 'package.json': manifest({ main: './lib/nope.js', types: '../t.d.ts', module: 'm.js', files: [] }), 'm.js': '' });
  assert.equal(rep.findings.length, 3);
  for (const f of rep.findings) {
    assert.equal(f.severity, 'error');
    assert.match(f.message, /^[^\n]+$/);
    assert.match(f.fix, /^[^\n]+$/);
    assert.ok(f.message.includes(f.value), f.message);
    assert.deepEqual(Object.keys(f), ['rule', 'severity', 'field', 'value', 'message', 'fix']);
  }
});

test('entry rules: main is not resolved the way Node does it', () => {
  const rep = report({ 'package.json': manifest({ main: 'lib' }), 'lib/index.js': '' });
  assert.deepEqual(short(rep), ['entry-missing main "lib"']);
  const rep2 = report({ 'package.json': manifest({ main: 'index' }), 'index.js': '' });
  assert.deepEqual(short(rep2), ['entry-missing main "index"']);
  for (const s of ['.', '', './', '././', '//']) {
    const r = report({ 'package.json': manifest({ main: s }), 'x.js': '' });
    assert.deepEqual(short(r), [`${s.startsWith('/') ? 'entry-outside' : 'entry-missing'} main ${JSON.stringify(s)}`], JSON.stringify(s));
  }
  // backslashes are not special
  const rep3 = report({ 'package.json': manifest({ main: 'lib\\x.js' }), 'lib/x.js': '' });
  assert.deepEqual(short(rep3), ['entry-missing main "lib\\\\x.js"']);
});

test('entry rules: a file below node_modules does not exist; a folder is not a file', () => {
  const rep = report({ 'package.json': manifest({ main: 'node_modules/m/index.js' }), 'node_modules/m/index.js': '' });
  assert.deepEqual(short(rep), ['entry-missing main "node_modules/m/index.js"']);
  const rep2 = report({ 'package.json': manifest({ main: 'lib/' }), 'lib/a.js': '' });
  assert.deepEqual(short(rep2), ['entry-missing main "lib/"']);
});

test('entry rules: an absent field, null, or another type is not a finding', () => {
  const rep = report({ 'package.json': manifest({ main: null, module: 5, types: ['x.d.ts'], typings: { a: 1 }, browser: { './a.js': './b.js', 'x': false }, bin: 12, exports: null }) });
  assert.deepEqual(rep.findings, []);
  const rep2 = report({ 'package.json': manifest({ main: true, exports: 5, bin: null }) });
  assert.deepEqual(rep2.findings, []);
  const rep3 = report({ 'package.json': manifest({ exports: { '.': 5, './a': true, './b': false, './c': null, './d': [null, 7] } }) });
  assert.deepEqual(rep3.findings, []);
});

test('entry rules: "private": true is not looked at', () => {
  assert.deepEqual(report({ 'package.json': manifest({ private: true }) }).findings, []);
});

// ---------------------------------------------------------------- exports

test('exports: a string, nested conditions, arrays and the field names', () => {
  const rep = report({ 'package.json': manifest({ exports: './a.js' }), 'a.js': '' });
  assert.deepEqual(rep.findings, []);
  const rep2 = report({
    'package.json': manifest({
      exports: {
        '.': { import: './esm/i.js', require: ['./cjs/r.js', { default: './cjs/missing.js' }] },
        './sub': { node: { import: './sub/n.js' } },
        './closed': null,
        './pkg.json': './package.json',
      },
    }),
    'esm/i.js': '', 'cjs/r.js': '', 'sub/n.js': '',
  });
  assert.deepEqual(short(rep2), ['entry-missing exports["."]["require"][1]["default"] "./cjs/missing.js"']);
  const rep3 = report({ 'package.json': manifest({ exports: ['./nope.js'] }) });
  assert.deepEqual(short(rep3), ['entry-missing exports[0] "./nope.js"']);
  const rep4 = report({ 'package.json': manifest({ exports: { 'a"b': { 'c\\d': './nope.js' } } }) });
  assert.deepEqual(short(rep4), ['entry-missing exports["a\\"b"]["c\\\\d"] "./nope.js"']);
  const rep5 = report({ 'package.json': manifest({ exports: './nope.js' }) });
  assert.deepEqual(short(rep5), ['entry-missing exports "./nope.js"']);
});

test('exports: form, outside, missing and not packed, in this order', () => {
  const rep = report({
    'package.json': manifest({
      files: ['lib'],
      exports: { a: 'lib/x.js', b: '../x.js', c: './../x.js', d: './lib/../x.js', e: './nope.js', f: './other.js', g: '', h: '.', i: './', j: '/abs.js', k: './lib/x.js', l: '/', m: './lib//x.js', n: './lib/./x.js' },
    }),
    'lib/x.js': '', 'other.js': '', 'x.js': '',
  });
  assert.deepEqual(short(rep), [
    'entry-missing exports["e"] "./nope.js"',
    'entry-missing exports["i"] "./"',
    'entry-not-packed exports["f"] "./other.js"',
    'entry-outside exports["c"] "./../x.js"',
    'entry-outside exports["d"] "./lib/../x.js"',
    'exports-form exports["a"] "lib/x.js"',
    'exports-form exports["b"] "../x.js"',
    'exports-form exports["g"] ""',
    'exports-form exports["h"] "."',
    'exports-form exports["j"] "/abs.js"',
    'exports-form exports["l"] "/"',
  ]);
});

test('exports: "./" and "." — the first rule that fits wins', () => {
  // "./" starts with "./" and has an empty path: entry-missing. "." does not start with "./": exports-form.
  const rep = report({ 'package.json': manifest({ exports: { a: './', b: '.' } }) });
  assert.deepEqual(short(rep), ['entry-missing exports["a"] "./"', 'exports-form exports["b"] "."']);
});

test('exports: a target string that is the same in two places is two findings', () => {
  const rep = report({ 'package.json': manifest({ main: './nope.js', exports: { '.': './nope.js', './x': './nope.js' } }) });
  assert.deepEqual(short(rep), [
    'entry-missing exports["."] "./nope.js"',
    'entry-missing exports["./x"] "./nope.js"',
    'entry-missing main "./nope.js"',
  ]);
});

test('exports: patterns with *', () => {
  const tree = { 'lib/a.js': '', 'lib/deep/b.js': '', 'lib/c.txt': '', 'other/z.js': '' };
  const f = (exports, files) => short(report({ 'package.json': manifest({ files, exports }), ...tree }));
  assert.deepEqual(f({ './*': './lib/*.js' }, ['lib']), []);
  assert.deepEqual(f({ './*': './lib/*.js' }, ['lib/c.txt']), ['entry-not-packed exports["./*"] "./lib/*.js"']);
  assert.deepEqual(f({ './*': './nothing/*.js' }, ['lib']), ['entry-missing exports["./*"] "./nothing/*.js"']);
  assert.deepEqual(f({ './*': './lib/*' }, ['lib']), []);
  assert.deepEqual(f({ './*': './*.js' }, ['lib']), []); // "*" takes "/" too
  assert.deepEqual(f({ './*': './lib/a*.js' }, ['lib']), []);
  assert.deepEqual(f({ './*': './lib/*.mjs' }, ['lib']), ['entry-missing exports["./*"] "./lib/*.mjs"']);
  assert.deepEqual(f({ './*': './lib/*/../*.js' }, ['lib']), ['entry-outside exports["./*"] "./lib/*/../*.js"']);
  assert.deepEqual(f({ './*': 'lib/*.js' }, ['lib']), ['exports-form exports["./*"] "lib/*.js"']);
  assert.deepEqual(f({ './*': '../*.js' }, ['lib']), ['exports-form exports["./*"] "../*.js"']);
  // the rest of a pattern is literal: "." is not a wildcard, regular expression characters are plain
  assert.deepEqual(f({ './*': './lib/a.j*' }, ['lib']), []);
  assert.deepEqual(f({ './*': './lib/(*).js' }, ['lib']), ['entry-missing exports["./*"] "./lib/(*).js"']);
  assert.deepEqual(f({ './*': './lib/aXjs*' }, ['lib']), ['entry-missing exports["./*"] "./lib/aXjs*"']);
});

test('main and the other fields: a * is not a pattern outside exports', () => {
  const rep = report({ 'package.json': manifest({ main: './lib/*.js' }), 'lib/a.js': '' });
  assert.deepEqual(short(rep), ['entry-missing main "./lib/*.js"']);
});

// ---------------------------------------------------------------- bin

test('bin: a string, an object, and the shebang', () => {
  const rep = report({
    'package.json': manifest({ bin: { ok: 'bin/ok.js', none: './bin/none.js', empty: 'bin/empty.js', bom: 'bin/bom.js', one: 'bin/one.js', 'we"ird': 'bin/ok.js' } }),
    'bin/ok.js': '#!/usr/bin/env node\nconsole.log(1)\n',
    'bin/none.js': 'console.log(1)\n',
    'bin/empty.js': '',
    'bin/bom.js': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('#!/usr/bin/env node\n')]),
    'bin/one.js': '#',
  });
  assert.deepEqual(short(rep), [
    'bin-shebang bin["bom"] "bin/bom.js"',
    'bin-shebang bin["empty"] "bin/empty.js"',
    'bin-shebang bin["none"] "./bin/none.js"',
    'bin-shebang bin["one"] "bin/one.js"',
  ]);
  const str = report({ 'package.json': manifest({ bin: 'cli.js' }), 'cli.js': 'x' });
  assert.deepEqual(short(str), ['bin-shebang bin "cli.js"']);
  const good = report({ 'package.json': manifest({ bin: 'cli.js' }), 'cli.js': '#!x' });
  assert.deepEqual(good.findings, []);
});

test('bin: a missing or unpacked target is reported once, without a shebang finding', () => {
  const rep = report({
    'package.json': manifest({ files: ['keep.txt'], bin: { gone: 'bin/gone.js', out: '../x.js', abs: '/x.js', left: '.DS_Store' } }),
    'keep.txt': '', '.DS_Store': 'no shebang',
  });
  assert.deepEqual(short(rep), [
    'entry-missing bin["gone"] "bin/gone.js"',
    'entry-not-packed bin["left"] ".DS_Store"',
    'entry-outside bin["abs"] "/x.js"',
    'entry-outside bin["out"] "../x.js"',
  ]);
});

test('bin: only a bin target gets the shebang rule', () => {
  const rep = report({ 'package.json': manifest({ main: 'a.js', exports: './b.js' }), 'a.js': 'x', 'b.js': 'x' });
  assert.deepEqual(rep.findings, []);
});

// ---------------------------------------------------------------- type

test('type module: .js entry files that use CommonJS', () => {
  const m = (extra) => manifest({ type: 'module', ...extra });
  const bad = {
    'a.js': "const x = require('x');\n",
    'b.js': 'module.exports = 1;\n',
    'c.js': 'if (x) { const y = require("y"); }\n',
    'd.js': 'const e = module . exports;\n',
    'e.js': '#!/usr/bin/env node\nrequire (  "x" )\n',
  };
  for (const [name, text] of Object.entries(bad)) {
    const rep = report({ 'package.json': m({ main: name }), [name]: text });
    assert.deepEqual(short(rep), [`type-mismatch main ${JSON.stringify(name)}`], name);
  }
  const fine = {
    'a.js': "import x from 'x';\nexport default x;\n",
    'b.js': "// require('x')\n/* module.exports = 1 */\n",
    'c.js': "const s = \"require('x')\"; const t = 'module.exports'; const u = `require('x') ${1}`;\n",
    'd.js': "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst x = require('x');\n",
    'e.js': "obj.require('x'); a?.require('x'); const r = /require('x')/; x.module.exports; foo.module.exports\n",
    'f.js': 'const t = `${/* require(1) */ 1}${"require(2)"}${`${require(3)}`}`;\n',
    'g.js': "const require2 = 1; requireX('x'); require.resolve('x'); module.exp; module .\n exportsX; module;\n",
    'h.js': '#!/usr/bin/env node\nconsole.log(1);\n',
    'i.js': "const r = require;\nconst o = { require: 1 };\n",
  };
  for (const [name, text] of Object.entries(fine)) {
    const rep = report({ 'package.json': m({ main: name }), [name]: text });
    assert.deepEqual(rep.findings, [], name);
  }
});

test('type commonjs: .js entry files that use ES module syntax', () => {
  const m = (extra) => manifest({ type: 'commonjs', ...extra });
  const bad = {
    'a.js': "import x from 'y';\n",
    'b.js': "import 'y';\n",
    'c.js': "import { a } from 'y';\n",
    'd.js': "import * as n from 'y';\n",
    'e.js': 'const u = import.meta.url;\n',
    'f.js': 'function f() { return import.meta.url; }\n',
    'g.js': 'export const a = 1;\n',
    'h.js': 'export default function () {}\n',
    'i.js': 'export { a };\n',
    'j.js': "export * from 'x';\n",
    'k.js': "#!/usr/bin/env node\nimport x from 'y';\n",
    'l.js': "const a = 1;\n\nimport x\n from 'y'\n",
  };
  for (const [name, text] of Object.entries(bad)) {
    const rep = report({ 'package.json': m({ main: name }), [name]: text });
    assert.deepEqual(short(rep), [`type-mismatch main ${JSON.stringify(name)}`], name);
  }
  const fine = {
    'a.js': "const x = require('x');\nmodule.exports = import('y');\n",
    'b.js': "// import x from 'y'\n/* export const a = 1 */\n",
    'c.js': "const s = \"import x from 'y'\"; const t = 'export const a'; const u = `import x from 'y' ${1}`; const r = /export {/;\n",
    'd.js': "async function f() { const m = await import('y'); return import ('z'); }\n",
    'e.js': 'function f() { if (a) { import x from "y"; } }\n', // not at depth 0: outside the rule
    'f.js': 'const o = { import: 1, export: 2 }; o.import; o.export {;\n',
    'g.js': 'const t = `${import.meta.url}`;\n',
    'h.js': 'a.import.meta; a?.import.meta; x.export * y;\n',
    'i.js': 'export;\n',
  };
  for (const [name, text] of Object.entries(fine)) {
    const rep = report({ 'package.json': m({ main: name }), [name]: text });
    assert.deepEqual(rep.findings, [], name);
  }
});

test('type: which targets and files are looked at', () => {
  const esm = "import x from 'y';\nexport default x;\n";
  const cjs = "const x = require('y');\nmodule.exports = x;\n";
  // no type, or another type: nothing
  assert.deepEqual(report({ 'package.json': manifest({ main: 'a.js' }), 'a.js': cjs }).findings, []);
  assert.deepEqual(report({ 'package.json': manifest({ main: 'a.js', type: 'Module' }), 'a.js': cjs }).findings, []);
  assert.deepEqual(report({ 'package.json': manifest({ main: 'a.js', type: 5 }), 'a.js': cjs }).findings, []);
  // .mjs, .cjs, .ts, .JS never
  for (const ext of ['.mjs', '.cjs', '.ts', '.JS', '.jsx']) {
    assert.deepEqual(report({ 'package.json': manifest({ type: 'module', main: 'a' + ext }), ['a' + ext]: cjs }).findings, [], ext);
    assert.deepEqual(report({ 'package.json': manifest({ type: 'commonjs', main: 'a' + ext }), ['a' + ext]: esm }).findings, [], ext);
  }
  // module, types, typings, browser are not looked at
  assert.deepEqual(report({ 'package.json': manifest({ type: 'module', module: 'a.js', browser: 'a.js', types: 'a.js', typings: 'a.js' }), 'a.js': cjs }).findings, []);
  // main, bin and exports (each field is a finding)
  const rep = report({
    'package.json': manifest({ type: 'module', main: 'a.js', bin: { x: './a.js' }, exports: { '.': './a.js', './b': { import: './b.js' }, './c': './c.mjs', './p/*': './p/*.js' } }),
    'a.js': '#!/usr/bin/env node\n' + cjs, 'b.js': 'module.exports = 1', 'c.mjs': cjs, 'p/q.js': cjs,
  });
  assert.deepEqual(short(rep), [
    'type-mismatch bin["x"] "./a.js"',
    'type-mismatch exports["."] "./a.js"',
    'type-mismatch exports["./b"]["import"] "./b.js"',
    'type-mismatch main "a.js"',
  ]);
  // an entry that is missing or not packed is not read
  const rep2 = report({ 'package.json': manifest({ type: 'module', files: [], exports: './a.js' }), 'a.js': cjs });
  assert.deepEqual(short(rep2), ['entry-not-packed exports "./a.js"']);
  // a leading byte-order mark is dropped
  const rep3 = report({ 'package.json': manifest({ type: 'module', main: 'a.js' }), 'a.js': '﻿module.exports = 1' });
  assert.deepEqual(short(rep3), ['type-mismatch main "a.js"']);
});

test('type: the tokenizer reads comments, regular expressions, templates and strings', () => {
  const m = (text, type = 'module') => report({ 'package.json': manifest({ type, main: 'a.js' }), 'a.js': text }).findings.length;
  assert.equal(m('x = a / b / require("x")'), 1, 'division is not a regular expression');
  assert.equal(m('x = (a) / 2; /require("x")/.test(y)'), 0, 'a regular expression after a ;');
  assert.equal(m('const r = /[/]require(1)/;'), 0, 'a slash in a class does not end the regular expression');
  assert.equal(m('const r = /a\\/require(1)/;'), 0, 'an escaped slash does not end it');
  assert.equal(m('return /require(1)/'), 0);
  assert.equal(m('const s = "a\\"require(1)";'), 0, 'escaped quote');
  assert.equal(m("const s = 'unterminated\nrequire(1)"), 1, 'an unterminated string ends at the line break');
  assert.equal(m('/* open comment require(1)'), 0, 'a comment open to the end');
  assert.equal(m('/* c */ require(1)'), 1);
  assert.equal(m('// c\nrequire(1)'), 1);
  assert.equal(m('const t = `a ${ `b ${ "}" } ${ {}.x } ` } ${ x }`; require(1)'), 1, 'nested templates');
  assert.equal(m('const t = `a \\` ${1} require(1)`;'), 0, 'an escaped backtick');
  assert.equal(m('const t = `${ // }\n1 }`; module.exports = 1'), 1);
  assert.equal(m('x = 1.5e+3; require(1)'), 1);
  assert.equal(m('x = 0xe+require(1)'), 1, 'after a hex number a + is a punctuator');
  assert.equal(m('$require(1); _require(1); réquire(1);'), 0);
  assert.equal(m('a?.b; a ?.5 : require(1)'), 1);
  assert.equal(m('f(...require(1))'), 1);
  assert.equal(m('f(() => require(1))'), 1);
  assert.equal(m('x = a < /require(1)/'), 1, 'after < a slash is a punctuator');
});

// ---------------------------------------------------------------- types first

test('types-order: a types key that is not the first key of a conditions object', () => {
  const t = { 'index.js': '', 'index.d.ts': '', 'index.cjs': '' };
  const bad = report({ 'package.json': manifest({ exports: { '.': { import: './index.js', types: './index.d.ts' } } }), ...t });
  assert.deepEqual(short(bad), ['types-order exports["."]["types"] "./index.d.ts"']);
  assert.equal(bad.findings[0].severity, 'error');
  assert.ok(bad.findings[0].message.includes('./index.d.ts'));
  const good = report({ 'package.json': manifest({ exports: { '.': { types: './index.d.ts', import: './index.js' } } }), ...t });
  assert.deepEqual(good.findings, []);
  const only = report({ 'package.json': manifest({ exports: { '.': { types: './index.d.ts' } } }), ...t });
  assert.deepEqual(only.findings, []);
});

test('types-order: any depth, inside arrays, at the top, and not for subpath objects', () => {
  const t = { 'a.js': '', 'a.d.ts': '' };
  const rep = report({
    'package.json': manifest({
      exports: {
        '.': { node: { import: { default: './a.js', types: './a.d.ts' }, types: './a.d.ts' } },
        './arr': [{ require: './a.js', types: './a.d.ts' }],
      },
    }),
    ...t,
  });
  assert.deepEqual(short(rep), [
    'types-order exports["."]["node"]["import"]["types"] "./a.d.ts"',
    'types-order exports["."]["node"]["types"] "./a.d.ts"',
    'types-order exports["./arr"][0]["types"] "./a.d.ts"',
  ]);
  const top = report({ 'package.json': manifest({ exports: { import: './a.js', types: './a.d.ts' } }), ...t });
  assert.deepEqual(short(top), ['types-order exports["types"] "./a.d.ts"']);
  // an object that has subpath keys is not a conditions object
  const sub = report({ 'package.json': manifest({ exports: { '.': './a.js', types: './a.d.ts' } }), ...t });
  assert.deepEqual(sub.findings, []);
  const sub2 = report({ 'package.json': manifest({ exports: { import: './a.js', types: './a.d.ts', './x': './a.js' } }), ...t });
  assert.deepEqual(sub2.findings, []);
});

test('types-order: the value is the value of the key, whatever it is; keys are in written order', () => {
  const rep = report({ 'package.json': manifest({ exports: { '.': { import: './a.js', types: { default: './a.d.ts' } }, './n': { default: './a.js', types: null } } }), 'a.js': '', 'a.d.ts': '' });
  assert.deepEqual(short(rep), ['types-order exports["."]["types"] {"default":"./a.d.ts"}', 'types-order exports["./n"]["types"] null']);
  assert.match(rep.findings[0].message, /^[^\n]+$/);
  // integer-like keys keep their place: "types" written first is first
  const text = '{"description":"d","license":"MIT","repository":"r","engines":{"node":">=22"},"exports":{"types":"./a.d.ts","1":"./a.js"}}';
  const first = report({ 'package.json': text, 'a.js': '', 'a.d.ts': '' });
  assert.deepEqual(first.findings, []);
  const text2 = '{"description":"d","license":"MIT","repository":"r","engines":{"node":">=22"},"exports":{"1":"./a.js","types":"./a.d.ts"}}';
  assert.deepEqual(short(report({ 'package.json': text2, 'a.js': '', 'a.d.ts': '' })), ['types-order exports["types"] "./a.d.ts"']);
});

// ---------------------------------------------------------------- metadata

test('metadata: missing fields are warnings with value null', () => {
  const rep = report({ 'package.json': '{"name":"x"}' });
  assert.deepEqual(short(rep), [
    'description-missing description null',
    'engines-node-missing engines.node null',
    'license-missing license null',
    'repository-missing repository null',
  ]);
  for (const f of rep.findings) {
    assert.equal(f.severity, 'warning');
    assert.match(f.message, /^[^\n]+$/);
    assert.match(f.fix, /^[^\n]+$/);
  }
  assert.deepEqual(rep.counts, { error: 0, warning: 4 });
});

test('metadata: null counts as missing; wrong values are invalid with their JSON value', () => {
  const rep = report({ 'package.json': JSON.stringify({ description: null, license: null, repository: null, engines: null }) });
  assert.deepEqual(rulesOf(rep), ['description-missing', 'engines-node-missing', 'license-missing', 'repository-missing']);
  const inv = report({ 'package.json': JSON.stringify({ description: '  \t', license: 5, repository: { type: 'git' }, engines: { node: '' } }) });
  assert.deepEqual(short(inv), [
    'description-invalid description "  \\t"',
    'engines-node-invalid engines.node ""',
    'license-invalid license 5',
    'repository-invalid repository {"type":"git"}',
  ]);
  const inv2 = report({ 'package.json': JSON.stringify({ description: 5, license: ['MIT'], repository: 7, engines: { node: 22 } }) });
  assert.deepEqual(short(inv2), [
    'description-invalid description 5',
    'engines-node-invalid engines.node 22',
    'license-invalid license ["MIT"]',
    'repository-invalid repository 7',
  ]);
  // engines that is not an object, an array, or without node: missing
  for (const engines of ['>=22', ['node'], {}, { npm: '>=9' }, 5, true]) {
    assert.deepEqual(short(report({ 'package.json': manifest({ engines }) })), ['engines-node-missing engines.node null'], JSON.stringify(engines));
  }
  assert.deepEqual(short(report({ 'package.json': manifest({ engines: { node: null } }) })), ['engines-node-missing engines.node null']);
});

test('metadata: valid repository forms and descriptions', () => {
  for (const repository of ['x', ' y ', { url: 'git+https://x.git' }, { type: 'git', url: 'u', directory: 'd' }]) {
    assert.deepEqual(report({ 'package.json': manifest({ repository }) }).findings, [], JSON.stringify(repository));
  }
  for (const repository of ['', '   ', { url: '' }, { url: '  ' }, { url: 5 }, {}, [], ['x'], true, false, 0]) {
    assert.deepEqual(rulesOf(report({ 'package.json': manifest({ repository }) })), ['repository-invalid'], JSON.stringify(repository));
  }
  assert.deepEqual(rulesOf(report({ 'package.json': manifest({ description: '' }) })), ['description-invalid']);
  assert.deepEqual(rulesOf(report({ 'package.json': manifest({ engines: { node: '   ' } }) })), ['engines-node-invalid']);
});

test('metadata: the license expression grammar', () => {
  const valid = [
    'MIT', 'Apache-2.0', '(MIT OR Apache-2.0)', 'GPL-2.0+', 'GPL-2.0-only WITH Classpath-exception-2.0', 'UNLICENSED', ' MIT ', 'MIT AND BSD-3-Clause', 'MIT OR (ISC AND Apache-2.0)',
    '((MIT))', '(MIT) OR (ISC)', 'SEE LICENSE IN LICENSE.txt', 'SEE LICENSE IN  x', 'LicenseRef-custom', 'A', '0BSD', '(GPL-2.0+ WITH Classpath-exception-2.0 OR MIT)', 'MIT OR ISC OR Zlib', 'MIT\tOR\nISC', '(MIT)AND(ISC)',
  ];
  for (const license of valid) assert.deepEqual(report({ 'package.json': manifest({ license }) }).findings, [], JSON.stringify(license));
  const invalid = [
    'Apache 2', 'MIT OR', '(MIT', 'MIT)', 'MIT MIT', '', '   ', 'OR MIT', 'AND', 'WITH', 'MIT WITH', 'MIT WITH WITH', 'MIT AND OR ISC', '()', 'MIT OR ()', 'MIT+ +', '+MIT', '-MIT', '.MIT', 'MIT++', 'MIT WITH A WITH B',
    'SEE LICENSE IN', 'SEE LICENSE IN ', 'SEE LICENSE IN   ', 'see license in x', 'MIT,ISC', 'MIT/ISC', 'MIT_X', 'GPL-2.0+ OR', 'mit and isc', 'MIT (ISC)', '(MIT) (ISC)', 'MIT WITH (X)',
  ];
  for (const license of invalid) assert.deepEqual(short(report({ 'package.json': manifest({ license }) })), [`license-invalid license ${JSON.stringify(license)}`], JSON.stringify(license));
  for (const license of [5, true, {}, [], ['MIT'], { type: 'MIT' }]) {
    assert.deepEqual(rulesOf(report({ 'package.json': manifest({ license }) })), ['license-invalid'], JSON.stringify(license));
  }
});

test('metadata: invalid strings are held in the message', () => {
  const rep = report({ 'package.json': manifest({ license: 'Apache 2', description: '' }) });
  const lic = rep.findings.find((f) => f.rule === 'license-invalid');
  assert.ok(lic.message.includes('Apache 2'));
});

// ---------------------------------------------------------------- secrets, junk, fixtures

test('packed-secret: names that look like secrets, only when packed', () => {
  const secret = ['.env', '.env.local', '.env.production', 'a/.env', '.netrc', '.htpasswd', 'x/credentials.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'k/server.pem', 'a.key', 'b.p12', 'c.pfx', 'd.jks', 'e.keystore', '.env.x.y'];
  const fine = ['.env.example', '.env.sample', '.env.template', 'a/.env.example', 'envfile', 'my.env', 'id_rsa.pub', 'keyfile.txt', 'monkey', 'pem', 'x.pem.txt', 'credentials.json5'];
  const tree = {};
  for (const n of [...secret, ...fine]) tree[n] = 'x';
  const rep = report({ 'package.json': manifest(), ...tree });
  assert.deepEqual(rep.findings.map((f) => f.value), [...secret].sort());
  for (const f of rep.findings) {
    assert.equal(f.rule, 'packed-secret');
    assert.equal(f.severity, 'warning');
    assert.equal(f.field, null);
    assert.ok(f.message.includes(f.value));
  }
  // names are compared in lower case (one package each: file systems may fold case)
  for (const n of ['UP.PEM', 'Big.KEY', 'CREDENTIALS.JSON', 'ID_RSA', '.ENV', '.Env.Prod']) {
    assert.deepEqual(short(report({ 'package.json': manifest(), [n]: 'x' })), [`packed-secret null ${JSON.stringify(n)}`], n);
  }
  assert.deepEqual(report({ 'package.json': manifest(), '.ENV.EXAMPLE': 'x' }).findings, []);
});

test('packed-secret: the same files left out of the pack are not findings', () => {
  const tree = { '.env': 'x', 'a/.env.local': 'x', 'server.pem': 'x', 'ok.js': '', '.netrc': 'x', '.npmrc': 'x', 'keep/.env': 'x' };
  const viaFiles = report({ 'package.json': manifest({ files: ['ok.js'] }), ...tree });
  assert.deepEqual(viaFiles.findings, []);
  const viaIgnore = report({ 'package.json': manifest(), ...tree, '.npmignore': '.env*\n*.pem\n.netrc\n' });
  assert.deepEqual(short(viaIgnore), []);
  const viaGit = report({ 'package.json': manifest(), ...tree, '.gitignore': '.env*\n*.pem\n.netrc\n' });
  assert.deepEqual(short(viaGit), []);
  // .npmrc and .DS_Store are never packed, so never a finding
  const all = report({ 'package.json': manifest(), '.DS_Store': 'x', '.npmrc': 'x' });
  assert.deepEqual(all.findings, []);
  assert.deepEqual(all.list, ['package.json']);
  // .netrc is not left out always: when it is packed it is a finding
  assert.deepEqual(short(report({ 'package.json': manifest(), '.netrc': 'x' })), ['packed-secret null ".netrc"']);
});

test('packed-junk: names and folders', () => {
  const junk = ['thumbs.db', 'desktop.ini', 'a.log', 'x/b.tmp', 'c.bak', 'd.swo', 'e.tsbuildinfo', 'back~', '.idea/w.xml', 'p/.vscode/settings.json', 'coverage/lcov.info', 'a/coverage/x', '.nyc_output/o', '__MACOSX/m'];
  const fine = ['idea/x', 'vscode/x', 'coverage.txt', 'my-coverage/x', 'log', 'a.logx', 'tmp', 'a.tmp.js', 'thumbs.dbx', 'x.swp2', 'nyc_output/x', '__MACOSX2/x'];
  const tree = {};
  for (const n of [...junk, ...fine]) tree[n] = 'x';
  const rep = report({ 'package.json': manifest(), ...tree });
  assert.deepEqual(rep.findings.map((f) => f.rule), junk.map(() => 'packed-junk'));
  assert.deepEqual(rep.findings.map((f) => f.value), [...junk].sort());
  for (const n of ['Thumbs.DB', 'DESKTOP.INI', 'A.LOG', 'X.Tmp']) {
    assert.deepEqual(short(report({ 'package.json': manifest(), [n]: 'x' })), [`packed-junk null ${JSON.stringify(n)}`], n);
  }
  // folders are compared as written
  assert.deepEqual(report({ 'package.json': manifest(), 'COVERAGE/x': 'x', '.IDEA/x': 'x' }).findings, []);
  // not packed: no finding
  assert.deepEqual(report({ 'package.json': manifest({ files: [] }), 'a.log': 'x', '.idea/x': 'x' }).findings, []);
  // npm-debug.log is left out always
  assert.deepEqual(report({ 'package.json': manifest(), 'npm-debug.log': 'x' }).findings, []);
});

test('packed-fixture: large files in test folders', () => {
  const big = Buffer.alloc(102401, 1);
  const edge = Buffer.alloc(102400, 1);
  const folders = ['test', 'tests', '__tests__', 'spec', 'fixtures', '__fixtures__'];
  const tree = {};
  for (const f of folders) tree[`${f}/big.dat`] = big;
  tree['a/test/deep/big.dat'] = big;
  tree['test/edge.dat'] = edge;
  tree['testing/big.dat'] = big;
  tree['big.dat'] = big;
  tree['test.dat'] = big;
  tree['specs/big.dat'] = big;
  const rep = report({ 'package.json': manifest(), ...tree });
  assert.deepEqual(rep.findings.map((f) => f.rule), Array(folders.length + 1).fill('packed-fixture'));
  assert.deepEqual(rep.findings.map((f) => f.value), [...folders.map((f) => `${f}/big.dat`), 'a/test/deep/big.dat'].sort());
  // folder names are compared as written
  assert.deepEqual(report({ 'package.json': manifest(), 'Test/big.dat': big }).findings, []);
  // a file in a test folder that is not packed: nothing
  assert.deepEqual(report({ 'package.json': manifest({ files: ['x'] }), 'test/big.dat': big, 'x': '' }).findings, []);
});

test('a file can have more than one of these findings', () => {
  const rep = report({ 'package.json': manifest(), 'test/secret.key': Buffer.alloc(200000, 1), 'x.js': '' });
  assert.deepEqual(rulesOf(rep), ['packed-fixture', 'packed-secret']);
  const rep2 = report({ 'package.json': manifest(), '.idea/.env': 'x' });
  assert.deepEqual(rulesOf(rep2), ['packed-junk', 'packed-secret']);
});

test('the contents of files are never looked at for secrets', () => {
  const key = '-----BEGIN ' + 'PRIVATE' + ' KEY-----';
  assert.deepEqual(report({ 'package.json': manifest(), 'notes.txt': key + '\nabc\n', 'a.js': 'const t = "AKIAIOSFODNN7EXAMPLE";' }).findings, []);
});

// ---------------------------------------------------------------- --max-size

test('--max-size: package-too-large when the size is over the limit', () => {
  const files = { 'package.json': manifest(), 'a.txt': Buffer.alloc(100, 1) };
  const size = Buffer.byteLength(files['package.json']) + 100;
  const at = report(files, ['--max-size', String(size)]);
  assert.deepEqual(at.findings, []);
  assert.equal(at.packed.size, size);
  const over = report(files, ['--max-size', String(size - 1)]);
  assert.deepEqual(short(over), [`package-too-large null ${size}`]);
  assert.equal(over.findings[0].severity, 'error');
  assert.equal(typeof over.findings[0].value, 'number');
  assert.ok(over.findings[0].message.includes(String(size)));
  assert.match(over.findings[0].message, /^[^\n]+$/);
  assert.match(over.findings[0].fix, /^[^\n]+$/);
  assert.deepEqual(rulesOf(report(files, ['--max-size', '0'])), ['package-too-large']);
  assert.deepEqual(report(files, ['--max-size', '99999999999999999999999999']).findings, []);
  assert.deepEqual(report(files, ['--max-size', '0000' + size]).findings, []);
  assert.deepEqual(report(files).findings, []);
  // files not packed do not count
  const small = report({ 'package.json': manifest({ files: [] }), 'big.bin': Buffer.alloc(5000) }, ['--max-size', String(Buffer.byteLength(manifest({ files: [] })))]);
  assert.deepEqual(small.findings, []);
});

test('--max-size: plain output line uses the size as the subject', () => {
  const dir = pkg({ 'package.json': manifest() });
  const r = run([dir, '--max-size', '1']);
  assert.equal(r.code, 1);
  const lines = r.out.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^error package-too-large \d+: .+ Fix: .+$/);
});

// ---------------------------------------------------------------- output forms

test('--json: one object with the stated fields; list only with --list', () => {
  const dir = pkg({ 'package.json': manifest({ main: 'nope.js' }), 'a.js': 'abc' });
  const r = run([dir, '--json']);
  assert.equal(r.code, 1);
  assert.equal(r.err, '');
  assert.ok(r.out.endsWith('\n'));
  const rep = JSON.parse(r.out);
  assert.equal(rep.tool, 'publish-check');
  assert.equal(rep.version, '0.1.0');
  assert.equal(Array.isArray(rep.findings), true);
  assert.equal('list' in rep, false);
  assert.deepEqual(rep.counts, { error: 1, warning: 0 });
  assert.equal(rep.packed.files, 2);
  assert.equal(rep.packed.size, Buffer.byteLength(manifest({ main: 'nope.js' })) + 3);
  const withList = JSON.parse(run([dir, '--json', '--list']).out);
  assert.deepEqual(withList.list, ['a.js', 'package.json']);
  assert.deepEqual(Object.keys(withList).slice(0, 5), ['tool', 'version', 'findings', 'packed', 'counts']);
});

test('--json: findings are sorted by rule, field, then value; counts agree', () => {
  const rep = report({
    'package.json': JSON.stringify({
      main: 'm.js', module: 'a.js', types: 't.d.ts', license: 'bad one',
      bin: { z: 'zz.js', a: 'aa.js' }, exports: { '.': './x.js', './b': './y.js', './c': '/z.js' },
    }),
    '.env': 'x', 'zz.js': 'no', 'aa.js': 'no', 'a.log': 'x',
  });
  const key = (f) => [f.rule, f.field ?? '', typeof f.value === 'string' ? f.value : JSON.stringify(f.value)];
  const sorted = [...rep.findings].sort((p, q) => {
    const a = key(p);
    const b = key(q);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  });
  assert.deepEqual(rep.findings, sorted);
  assert.ok(rep.findings.length >= 10);
  assert.equal(rep.counts.error, rep.findings.filter((f) => f.severity === 'error').length);
  assert.equal(rep.counts.warning, rep.findings.filter((f) => f.severity === 'warning').length);
  const seen = new Set(rep.findings.map((f) => JSON.stringify(key(f))));
  assert.equal(seen.size, rep.findings.length);
});

test('--json: sorting compares code units; null sorts as the empty string', () => {
  const rep = report({ 'package.json': JSON.stringify({ exports: { B: './1.js', a: './2.js', 'é': './3.js', Z: './4.js' } }) });
  const missing = rep.findings.filter((f) => f.rule === 'entry-missing').map((f) => f.field);
  assert.deepEqual(missing, ['exports["B"]', 'exports["Z"]', 'exports["a"]', 'exports["é"]']);
});

test('plain output: one line per finding, packed lines, then the summary', () => {
  const dir = pkg({
    'package.json': JSON.stringify({ main: 'nope.js', description: 'd', license: 'MIT', repository: 'r', engines: { node: '>=22' } }),
    '.env': 'x', 'b.js': '', 'a/c.js': '',
  });
  const plain = run([dir, '--list']);
  assert.equal(plain.code, 1);
  assert.equal(plain.err, '');
  const json = JSON.parse(run([dir, '--json', '--list']).out);
  const expected = [
    ...json.findings.map((f) => `${f.severity} ${f.rule} ${f.field ?? (typeof f.value === 'string' ? f.value : JSON.stringify(f.value))}: ${f.message} Fix: ${f.fix}`),
    ...json.list.map((p) => `packed ${p}`),
    `publish-check: ${json.counts.error} errors, ${json.counts.warning} warnings, ${json.packed.files} files, ${json.packed.size} bytes`,
  ];
  assert.equal(plain.out, expected.join('\n') + '\n');
  assert.deepEqual(expected.slice(0, 2).map((l) => l.split(': ')[0]), ['error entry-missing main', 'warning packed-secret .env']);
  assert.match(expected[expected.length - 1], /^publish-check: 1 errors, 1 warnings, 4 files, \d+ bytes$/);
  const noList = run([dir]);
  assert.equal(noList.out.split('\n').some((l) => l.startsWith('packed ')), false);
});

test('plain output: a clean package prints only the summary; singular numbers stay plural', () => {
  const dir = pkg({ 'package.json': manifest() });
  const r = run([dir]);
  assert.equal(r.code, 0);
  assert.equal(r.out, `publish-check: 0 errors, 0 warnings, 1 files, ${Buffer.byteLength(manifest())} bytes\n`);
  const l = run([dir, '--list']);
  assert.equal(l.out, `packed package.json\npublish-check: 0 errors, 0 warnings, 1 files, ${Buffer.byteLength(manifest())} bytes\n`);
});

test('plain output: a finding whose field is null shows its value as the subject', () => {
  const dir = pkg({ 'package.json': manifest(), 'server.pem': 'x' });
  const lines = run([dir]).out.split('\n');
  assert.match(lines[0], /^warning packed-secret server\.pem: .+ Fix: .+$/);
});

test('findings: message and fix are one non-empty line, even for odd values', () => {
  const weird = 'a\nb';
  const rep = report({ 'package.json': manifest({ main: weird, types: 'x\r\ny' }) });
  assert.equal(rep.findings.length, 2);
  for (const f of rep.findings) {
    assert.match(f.message, /^[^\n\r]+$/);
    assert.match(f.fix, /^[^\n\r]+$/);
  }
  const dir = pkg({ 'package.json': manifest({ main: weird }) });
  const plain = run([dir]).out.split('\n');
  assert.equal(plain.length, 3);
});

test('every rule has its stated severity', () => {
  const rep = report({
    'package.json': JSON.stringify({
      type: 'module', main: 'm.js', module: '../out.js', types: 'nope.d.ts', typings: 'u.d.ts', bin: 'cli.js',
      exports: { '.': { import: './m.js', types: './nope.d.ts' }, './f': 'f.js' },
      license: 'bad one', repository: '', engines: {}, description: '', files: ['m.js', '.env', 'a.log', 'test'],
    }),
    'm.js': 'module.exports = 1', 'u.d.ts': '', 'cli.js': 'x', 'f.js': '', '.env': 'x', 'a.log': 'x', 'test/big.dat': Buffer.alloc(200000),
  }, ['--max-size', '1']);
  const severity = {};
  for (const f of rep.findings) severity[f.rule] = f.severity;
  assert.deepEqual(severity, {
    'bin-shebang': 'error', 'description-invalid': 'warning', 'engines-node-missing': 'warning', 'entry-missing': 'error', 'entry-not-packed': 'error', 'entry-outside': 'error',
    'exports-form': 'error', 'license-invalid': 'warning', 'package-too-large': 'error', 'packed-fixture': 'warning', 'packed-junk': 'warning', 'packed-secret': 'warning',
    'repository-invalid': 'warning', 'type-mismatch': 'error', 'types-order': 'error',
  });
  assert.deepEqual(rep.counts, { error: rep.findings.filter((f) => f.severity === 'error').length, warning: rep.findings.filter((f) => f.severity === 'warning').length });
});

// ---------------------------------------------------------------- exit codes

test('--fail-on and the exit status', () => {
  const clean = pkg({ 'package.json': manifest() });
  const warn = pkg({ 'package.json': manifest({ license: 'bad one' }) });
  const err = pkg({ 'package.json': manifest({ main: 'nope.js' }) });
  const both = pkg({ 'package.json': manifest({ main: 'nope.js', license: 'bad one' }) });
  const expect = (dir, level, code) => {
    const args = level === undefined ? [dir] : [dir, '--fail-on', level];
    assert.equal(run(args).code, code, `${path.basename(dir)} ${level}`);
    assert.equal(run([...args, '--json']).code, code, `${path.basename(dir)} ${level} json`);
  };
  expect(clean, undefined, 0); expect(clean, 'error', 0); expect(clean, 'warning', 0); expect(clean, 'none', 0);
  expect(warn, undefined, 0); expect(warn, 'error', 0); expect(warn, 'warning', 1); expect(warn, 'none', 0);
  expect(err, undefined, 1); expect(err, 'error', 1); expect(err, 'warning', 1); expect(err, 'none', 0);
  expect(both, undefined, 1); expect(both, 'error', 1); expect(both, 'warning', 1); expect(both, 'none', 0);
});

test('output is printed in full whatever the exit status', () => {
  const dir = pkg({ 'package.json': manifest({ main: 'nope.js' }) });
  const r = run([dir, '--fail-on', 'none']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^error entry-missing main: /);
  assert.match(r.out, /publish-check: 1 errors, 0 warnings, 1 files, \d+ bytes\n$/);
});

// ---------------------------------------------------------------- a whole package

test('a healthy package prints nothing but the summary', () => {
  const rep = report({
    'package.json': manifest({
      type: 'module', main: './index.js', types: './index.d.ts', bin: { demo: 'bin/demo.js' },
      exports: { '.': { types: './index.d.ts', import: './index.js' }, './package.json': './package.json', './internal': null },
      files: ['index.js', 'index.d.ts', 'bin'],
    }),
    'index.js': "export const a = 1;\nconst s = 'require(1)';\n", 'index.d.ts': 'export const a: number;\n', 'bin/demo.js': '#!/usr/bin/env node\nimport "../index.js";\n',
    'LICENSE': 'x', 'README.md': 'x', 'test/t.js': 'x',
  });
  assert.deepEqual(rep.findings, []);
  assert.deepEqual(rep.list, ['LICENSE', 'README.md', 'bin/demo.js', 'index.d.ts', 'index.js', 'package.json']);
});
