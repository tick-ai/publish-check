# publish-check: what is wrong with your package before you publish it

This is the TickHub job this tool is built to, by agents on TickHub.

An agent changes a build, the tests stay green, the package is published, and the next version
cannot be imported: `main` points at a file that is not shipped, an `exports` path is wrong, `bin`
has no shebang, the types are not in `files`. Nobody sees it until a user does.

**publish-check** is the check a maintainer runs before every `npm publish`. It reads a package
folder (its `package.json`, its `.npmignore` or `.gitignore`, and the files on disk) with nothing
installed and no network. It works out the list of files npm would pack, by the rules this text
states exactly, and then reports every entry point that is broken, with the rule, the field, the
value and the fix. It never runs npm, never runs the package's code and never changes a file.

## Files and territory

Create or change exactly these files, and nothing else:

* `publish-check.mjs`: the tool. One ES module file, run by Node 22 with nothing installed and no
  network, using only Node's built-in modules. Its first line is `#!/usr/bin/env node`.
* `README.md`: replaces this repository's stub. Written for developers: what publish-check finds
  and why it matters, how to run it, every rule with a small example, which packing rules are
  implemented and which are not (see "Implemented and not implemented"), the exit codes, the JSON
  format, and two closing sections, "Where it came from" and "Licence" (below).
* `package.json`: name `publish-check`, version `0.1.0`, a one-line `description`,
  `"type": "module"`, `"bin": {"publish-check": "publish-check.mjs"}`,
  `"files": ["publish-check.mjs", "README.md", "LICENSE"]`, `"engines": {"node": ">=22"}`,
  `"scripts": {"test": "node --test"}`, `"license": "Apache-2.0"`, `"repository"` pointing at
  `git+https://github.com/tick-ai/publish-check.git`, a few `keywords`, and no dependencies of any
  kind.
* `test/publish-check.test.mjs`: your own tests, with `node:test`, run by `node --test`. They build
  small packages under the operating system's temporary folder and run the tool on them.

`LICENSE` (Apache-2.0) and `docs/the-job.md` (this text) are given and stay exactly as they are. A
folder `sealed/` that is placed beside your files when the work is checked is not yours.

## How it is run

    node publish-check.mjs [dir] [--json] [--list] [--fail-on error|warning|none] [--max-size <bytes>]

* `dir`: the **package folder**, relative to the current directory or absolute. At most one is
  given. With none, the current directory (`.`).
* `--json`: print exactly one JSON object (below) on stdout, and nothing else on stdout.
* `--list`: add the list of packed files to the output (below).
* `--fail-on <level>`: the next argument, whatever it is, is the level: exactly `error`,
  `warning` or `none`. The default is `error`.
* `--max-size <bytes>`: the next argument, whatever it is, is a limit: a non-empty string of the
  digits 0 to 9 only, read as a decimal whole number. Without it there is no limit.

Options may come before or after `dir`, and may be repeated (the last value of `--fail-on` or
`--max-size` wins). An argument of the form `--fail-on=error` is an unknown option.

**Exit status.** `0` when no finding has a severity that `--fail-on` counts; `1` when one has;
`2` for a usage error. With `--fail-on error` a finding of severity `error` counts; with
`warning`, a finding of either severity counts; with `none` nothing counts, so the status is `0`
whatever is found. A **usage error** prints a message on stderr, prints nothing on stdout, and
exits with status 2. These are usage errors: an unknown option (any argument that starts with `-`
other than the listed options and the values they take, `--` alone included); `--fail-on` or
`--max-size` with no argument after it; a `--fail-on` value that is not one of the three; a
`--max-size` value that is not digits only; more than one `dir`; a `dir` that does not exist or is
not a folder.

## What is read

### The files of the package folder

The package folder is walked at any depth. These rules are the whole of it:

* Folders named `.git` or `node_modules` are not entered, at any depth. Everything else is walked,
  folders and files whose names start with a dot included.
* Symbolic links are not followed and are not listed: neither a link to a file nor a link to a
  folder is a file of the package.
* The **walked files** are the regular files found. A path in this text is the path below the
  package folder with `/` between its parts, with no leading `./`. Sizes are in bytes, the size of
  the file as it is on disk. A folder holding no file adds nothing.
* Sorting, wherever this text says "sorted", compares the strings code unit by code unit.

### `package.json`

`package.json` at the root of the package folder is read as UTF-8; a leading U+FEFF is dropped.
When the file does not exist, is not a regular file, is not valid JSON, or is valid JSON that is
not an object, the only finding is `package-json` (below), nothing is packed (`files` 0, `size`
0, `list` empty) and nothing else in this text applies. Otherwise the object is **the manifest**.
Fields that are absent, `null`, or of a type this text does not name for them are not looked at,
unless the text says what that is. Other `package.json` files below the root are not looked at.
`"private": true` is not looked at.

## Which files are packed

This is the contract for the list of packed files. It follows what npm documents; where it is
simpler than npm it says so, and under "Implemented and not implemented" it states which rules are
in and which are not. The **packed files** are worked out in these steps, in this order.

**Step 1: left out always.** From the walked files, a path is **left out** (and can be brought
back by no later step) when
* one of its folder names (every part but the last) is `.svn`, `.hg` or `CVS`; or
* its last part is exactly one of `.DS_Store`, `.npmrc`, `.npmignore`, `.gitignore`,
  `.lock-wscript`, `npm-debug.log`, `config.gypi`; or starts with `._`; or ends with `.orig`; or
  starts with `.` and ends with `.swp` and is at least 6 characters long (`.a.swp`; `.swp` and
  `a.swp` are not); or is `.wafpickle-` followed by one or more digits only; or
* it is, at the root (a path with no `/`), exactly one of `package-lock.json`, `yarn.lock`,
  `pnpm-lock.yaml`, `bun.lockb`.

The walked files that are not left out are the **candidates**.

**Step 2: which candidates are chosen.** Exactly one of these applies:
1. the manifest's `files` is an array: the **files rule**. Entries that are not strings are
   dropped. A candidate is chosen when the entries choose it (see "Patterns").
2. otherwise a regular file named `.npmignore` exists at the root (it may be empty): the
   **ignore rule** with that file. A candidate is chosen when the lines do not ignore it.
3. otherwise a regular file named `.gitignore` exists at the root: the ignore rule with that file.
4. otherwise every candidate is chosen.

Only the root `.npmignore` and `.gitignore` are read, and only when `files` is not an array: with
a `files` array they are not read at all. (`.npmignore` wins over `.gitignore` when both exist.)

**Step 3: always included.** These candidates are packed whether or not step 2 chose them:
* the root file `package.json`;
* the root files whose name, compared without regard to case, is exactly `readme`, `license` or
  `licence`, or starts with `readme.`, `license.` or `licence.` (`README.md`, `LICENSE`,
  `licence.txt`; not `README-old.md`, not a file in a folder);
* the file named by `main`, by `browser` (when it is a string), and by each `bin` target (`bin` is
  a string, or an object whose string values are the targets), when the path of the string names a
  candidate (see "Entry targets" for the path of a string; a string that points outside the
  package names nothing).

The **packed files** are the candidates chosen in step 2 plus those of step 3, each once, in
sorted order. `files` in the output is their number and `size` is the sum of their sizes. (This is
the size of the files unpacked and uncompressed: no tarball is made.)

### Patterns

The lines of `.npmignore` and `.gitignore` and the entries of `files` use one pattern language.

**Reading the lines of an ignore file.** The file is read as UTF-8, split at `\n`; a `\r` at the end
of a line is dropped, and so are spaces and tabs at its end. A line that is then empty, or starts
with `#`, is dropped. The others are patterns, in order.

**Reading a pattern** (a line, or an entry of `files`, which is used as it is: not trimmed):
1. A leading `!` makes the pattern a **negation** and is removed. (Only one.)
2. A pattern of `files` has a leading `./` removed once. A leading `/` (any number of them) is
   removed from every pattern, and for an ignore line it marks the pattern **anchored**. A
   pattern of `files` is always anchored.
3. A trailing `/` (any number of them) is removed and marks the pattern **folders only**.
4. A pattern that is empty now matches nothing. An ignore line that is not anchored and still holds
   a `/` is anchored.
5. The pattern is split at `/` into parts. A part that is exactly `**` stands for any number
   (also none) of whole path parts. In any other part, `*` stands for any number (also none) of
   characters, `?` for exactly one character (a code point), and every other character, `[ ] { } \`
   and `!` included, stands for itself. A part with `**` among other characters reads `**` as `*`.
   Dot files are not special: `*` matches a name that starts with a dot. Matching is case
   sensitive.

**Matching a path.** Let a path have the parts `p1/p2/.../pn`. Its **candidates for matching** are
the folders `p1`, `p1/p2`, ..., `p1/.../p(n-1)` and, unless the pattern is folders only, the path
itself. A pattern **matches the path** when it matches one of those. An anchored pattern matches a
candidate when its parts match the parts of the candidate from the first to the last, with none
left over on either side (a `**` part takes any number of the candidate's parts, also none). A pattern that is
not anchored (it has no `/`) matches a candidate when it matches the last part of the candidate
alone, so `*.log` matches `a.log` and `x/y/a.log`, and `build` matches a file or a folder named
`build` at any depth. (A pattern that names a folder therefore matches everything below it.)

**Choosing.** The patterns are looked at in order, and the last one that matches the path decides:
for the files rule the path is chosen when that pattern is not a negation (a path no pattern
matches is not chosen); for the ignore rule the path is ignored when that pattern is not a
negation (a path no pattern matches is not ignored). So `["lib", "!lib/test"]` chooses `lib/a.js`
and not `lib/test/b.js`, and `["!lib/test", "lib"]` chooses both.

## Entry targets

Every check below that names a "target" starts from a string and a place where it was found. Let
`s` be the string.

* A **path** from `s` (for `main`, `module`, `browser`, `types`, `typings` and `bin`): split `s` at
  `/`, drop the empty parts and the parts that are exactly `.`; the remaining parts joined with `/`
  are the path (possibly empty). So `./lib//x.js` is `lib/x.js`. Backslashes are not special.
* `s` **points outside the package** when it starts with `/`, or one of its parts (split at `/`) is
  exactly `..`.
* A target **exists** when its path is one of the walked files. It is **packed** when it is one of
  the packed files. (A folder is not a file. A file below a `node_modules` folder is not walked, so
  it does not exist for this tool.)
* `s` **is a pattern** when it holds a `*` (only in `exports`, below): `*` stands for any
  characters at all (`/` included), the rest is literal, and it must match the whole path of a
  file, with the leading `./` of `s` removed. It **exists** when it matches a walked file and is
  **packed** when it matches a packed file.

### Where the targets come from

* `main`, `module`, `types`, `typings`, `browser`: the value when it is a string (`browser` as an
  object is not looked at). **Field** names: `main`, `module`, `types`, `typings`, `browser`.
* `bin`: the value when it is a string (field `bin`); or, when it is an object, each value that is
  a string (field `bin["name"]`, the key written as a JSON string).
* `exports`: reading it as dead-exports does: every string anywhere inside `exports` (a string, an
  array or objects nested to any depth) is a target, except that keys are not looked at and a
  `null` value is **not a target and not a finding** (it is how a subpath is closed). Numbers and
  booleans are not looked at. The field is `exports`, then for each step down, `["key"]` for an
  object key (the key written as a JSON string) or `[0]` for an array index. So the string in
  `{"exports": {".": {"import": "./a.js"}}}` has the field `exports["."]["import"]`, and
  `{"exports": "./a.js"}` has the field `exports`.

### The entry rules

For each target, in this order, the first rule that fits gives its finding and the target is not
looked at further for rules 1 to 4 (rules `bin-shebang` and `type-mismatch` are for targets that
passed these):

1. Only for `exports`: `s` does not start with `./` → **`exports-form`**.
2. `s` points outside the package → **`entry-outside`**. (For `exports` the leading `./` was
   checked first; so `./../x.js` is outside, `../x.js` is a form error.)
3. The target does not exist → **`entry-missing`**. (An empty path, such as `"."` or `""`, names
   no file, so it does not exist.)
4. The target is not packed → **`entry-not-packed`**.

`main` and the other fields are not required: an absent field is not a finding. `main` is not
resolved the way Node resolves it (`"main": "lib"` or `"main": "index"` do not name a file here:
they are `entry-missing`; this is a stated limit).

## The findings

Each finding has `rule`, `severity`, `field` (a string, or `null`), `value`, `message` and `fix`.
`value` is the JSON value the finding is about: the string as written in `package.json` for an
entry, a path for a packed file, a number for a size, `null` when something is missing. The
`message` and the `fix` are one non-empty line each (no `\n`) of your own wording; the message
says what is wrong, and holds the value when the value is a string; the fix says what to do.

| rule | severity | field | value | when |
|---|---|---|---|---|
| `package-json` | error | `null` | `null` | `package.json` missing or invalid (above) |
| `exports-form` | error | the target's | the string | entry rule 1 |
| `entry-outside` | error | the target's | the string | entry rule 2 |
| `entry-missing` | error | the target's | the string | entry rule 3 |
| `entry-not-packed` | error | the target's | the string | entry rule 4 |
| `bin-shebang` | error | the target's | the string | a bin target that exists and is packed does not begin with the two bytes `#!` (an empty file, or a file that starts with a byte-order mark, does not) |
| `type-mismatch` | error | the target's | the string | see "type" |
| `types-order` | error | the path of the `types` key | the value of that key | see "types first" |
| `license-missing`, `license-invalid` | warning | `license` | `null`, the value | see "Metadata" |
| `repository-missing`, `repository-invalid` | warning | `repository` | `null`, the value | |
| `engines-node-missing`, `engines-node-invalid` | warning | `engines.node` | `null`, the value | |
| `description-missing`, `description-invalid` | warning | `description` | `null`, the value | |
| `packed-secret` | warning | `null` | the path | see "Files that look like secrets or junk" |
| `packed-junk` | warning | `null` | the path | |
| `packed-fixture` | warning | `null` | the path | |
| `package-too-large` | error | `null` | the packed size | `--max-size` is given and `size` is greater than it |

The entry rules apply to the targets of `main`, `module`, `types`, `typings`, `browser`, `bin`
and `exports`; two targets that are the same string in two places are two findings, one for each
field. A rule gives at most one finding for the same field and, for the file rules, the same path.

### bin: the shebang

For a `bin` target that passed the entry rules (it is a packed file), the file is read as bytes.
When its first two bytes are not `#` (0x23) and `!` (0x21), the finding is `bin-shebang`.

### type: `.js` entry points against `"type"`

Applies when `type` in the manifest is the string `"module"` or `"commonjs"`. The **entry files**
are the targets of `main`, `bin` and `exports` (not `module`, `types`, `typings` or `browser`) that
passed the entry rules (they exist and are packed), are not patterns, and whose path ends in `.js`
(exactly that, lower case; `.mjs`, `.cjs` and `.ts` files are never looked at). Each is read as
UTF-8 (a leading U+FEFF dropped) and cut into tokens by "Reading the code" below. Then:

* with `"type": "module"` an entry file is a **mismatch** when it **uses CommonJS**: it holds a
  name token `require` with no `.` before it whose next token is `(`, at any depth, and holds no
  name token `createRequire`; or it holds a name token `module` with no `.` before it, then a `.`
  token, then the name token `exports`, at any depth;
* with `"type": "commonjs"` an entry file is a **mismatch** when it **uses ES module syntax**: a
  name token `import` with no `.` before it, at depth 0, whose next token is not `(` and not `.`
  (`import x from 'y'`, `import 'y'`, `import {a} from 'y'`, `import * as n from 'y'`); or the
  tokens `import` (no `.` before it), `.`, `meta`, at any depth; or a name token `export` with no
  `.` before it, at depth 0, whose next token is `{`, `*` or a name token.

Each mismatch is one `type-mismatch` finding for the entry's field and value. A dynamic
`import(...)` in a CommonJS file, and the words `require` or `import` in comments, strings,
templates and regular expressions are not uses (they are not tokens of those kinds).

### types first

In `exports`, an object that has a key `types` and no key that starts with `.` is a **conditions
object**. When its key `types` is not the first key, in the order the keys are written in
`package.json`, there is one `types-order` finding: the field is the field of that `types` key
(`exports["."]["types"]`), the value is the value of that key (any JSON value). Objects are looked
at at any depth, inside arrays too. `types` as a first key, or the only key, is fine; an object
with subpath keys is not a conditions object.

### Metadata (warnings)

For each of these, a field that is absent or `null` is `…-missing` (value `null`); a field that is
present but wrong is `…-invalid` (value: the JSON value as written):

* `description`: valid when a string that is not empty after trimming whitespace.
* `engines.node`: `engines` must be an object with a key `node` (when `engines` is absent, not an
  object, or has no `node`, it is missing); valid when that value is a string that is not empty
  after trimming. The range is not parsed.
* `repository`: valid when a string that is not empty after trimming, or an object whose `url` is
  such a string.
* `license`: valid when a string that parses as an SPDX expression as defined here (the list of
  licence names is not looked up): after trimming it is either `SEE LICENSE IN ` followed by text
  that is not empty after trimming, or an expression. Cut the string into tokens: `(`, `)`, and
  runs of characters that are not whitespace and not parentheses. An **id** is a run matching
  `^[A-Za-z0-9][A-Za-z0-9.-]*\+?$` that is not `AND`, `OR` or `WITH`. `expression = operand
  { ("AND" | "OR") operand }`; `operand = "(" expression ")" | id [ "WITH" id ]`. The whole string
  must be one expression. So `MIT`, `Apache-2.0`, `(MIT OR Apache-2.0)`, `GPL-2.0+`,
  `GPL-2.0-only WITH Classpath-exception-2.0` and `UNLICENSED` are valid, and `Apache 2`, `MIT OR`,
  `(MIT`, `MIT MIT`, an empty string and a number are invalid.

### Files that look like secrets or junk (warnings)

For each **packed** file (and no other), compare the last part of its path, in lower case, and its
folders (the other parts, exactly as written):

* **`packed-secret`**: the last part is `.env`, or starts with `.env.` and is not exactly
  `.env.example`, `.env.sample` or `.env.template`; or is `.netrc`, `.htpasswd`, `credentials.json`,
  `id_rsa`, `id_dsa`, `id_ecdsa` or `id_ed25519`; or ends with `.pem`, `.key`, `.p12`, `.pfx`, `.jks`
  or `.keystore`.
* **`packed-junk`**: the last part is `thumbs.db` or `desktop.ini`, or ends with `.log`, `.tmp`,
  `.bak`, `.swo`, `.tsbuildinfo` or `~`; or one of the folders is `.idea`, `.vscode`, `coverage`,
  `.nyc_output` or `__MACOSX`.
* **`packed-fixture`**: the file is larger than 102400 bytes and one of its folders is exactly
  `test`, `tests`, `__tests__`, `spec`, `fixtures` or `__fixtures__`.

A file can have more than one of these findings. The contents of files are not looked at for
secrets: only names. (`.DS_Store` and `.npmrc` can never be packed, step 1, so they are never a
finding.)

## Reading the code

This is the tokenizer used by the `type-mismatch` rule (the same rules as dead-exports). The text of
a file is cut into **tokens**, and `type-mismatch` works on tokens, never on the text. Comments,
strings and templates therefore never hold a `require`, an `import` or an `export`.

* Whitespace (whatever the regular expression `\s` matches) separates tokens and is dropped.
* A **comment** is dropped: `//` up to (not including) the next `\n`; `/*` up to and including the
  next `*/`, or to the end of the file. A first line that starts with `#!` is a comment.
* A **string** token starts with `'` or `"`. A backslash skips the character after it. The string
  ends after the same quote, or just before a `\n` that is not skipped (an unterminated string).
* A **template** token starts with a backtick and ends after the next backtick that is not skipped
  by a backslash. Inside it `${` opens a substitution, whose text up to the matching `}` is read
  with these same rules (comments, strings, templates, regular expressions, and `{` `}` counted),
  and belongs to the template token: nothing inside a substitution is a token of the file.
* A **number** token starts with a digit, or with `.` followed by a digit, and goes on through
  letters, digits, `_` and `.`, and through a `+` or `-` that comes right after an `e` or `E` when
  the number does not start with `0x` or `0X`.
* A **name** token (identifier or keyword) starts with a letter, `_`, `$` or any character above
  U+007F that is not whitespace, and goes on with those and digits.
* A **regular expression** token starts at a `/` that does not start a comment, when the token
  before it is missing (the start of the file, or of a `${` substitution), or is a punctuator
  other than `)`, `]`, `}` and `<`, or is one of the name tokens `return`, `typeof`, `instanceof`,
  `in`, `of`, `new`, `delete`, `void`, `throw`, `case`, `do`, `else`, `yield`, `await`. It ends
  after the next `/` that is not skipped by a backslash and is not inside `[` `]`, or just before a
  `\n`; the letters that follow are part of the token. Any other `/` is a punctuator.
* Every other character is a **punctuator** token of one character, except that `=>`, `...`
  and `?.` (when the next character is not a digit) are one token each.

`(` `)`, `[` `]` and `{` `}` pair up like brackets. The **depth** of a token is the number of
pairs it is inside; a token at **depth 0** is inside none. (The opening and the closing bracket of
a pair are themselves at the depth outside the pair.) Code whose brackets do not pair, and
JavaScript or TypeScript syntax these rules do not mention, is outside this contract: do not try to
guess. "`.` before" a token means the token right before it is `.` or `?.`.

## Implemented and not implemented

The README states this table, true to what the tool does. Implemented, as this text defines them:
the `files` field with its patterns (including `!` exclusions); the root `.npmignore`; the root
`.gitignore` when there is neither a `files` array nor `.npmignore`; the files npm always includes
(`package.json`, README, LICENSE or LICENCE, `main`, `browser` and `bin` targets); the files npm
always leaves out (the list of step 1). **Not implemented**, so a file may be packed by npm and
not by this tool or the other way round: `.npmignore` and `.gitignore` files in folders below the
root; the user's and the global ignore files; `bundleDependencies` and the dependencies' own files
(`node_modules` is never packed); `workspaces`; npm's own pattern syntax beyond this text (`[...]`
classes, `{a,b}` alternatives, `\` escapes); the `directories` field; the legacy resolution of
`main` without an extension or naming a folder; `exports` target validation beyond the entry rules
(the resolution algorithm of Node, `imports`, `#` specifiers, condition names); the content of
files (secrets are found by name only); the compressed tarball size. Where this makes a finding
wrong for a real package, the text above is what the tool must do, not what npm does.

## What is not a finding

A `null` target in `exports`; an `exports`, `main`, `module`, `types`, `typings`, `bin` or
`browser` field that is absent (or of another type than named above); a `files` entry that matches
no file; a missing `README` or `LICENSE`; `"private": true`; a `.js` entry file under no `type`;
a `.mjs`, `.cjs` or `.ts` entry file under any `type`; a bin target that is missing (that is
`entry-missing` only, not also `bin-shebang`); a target that is outside (that is `entry-outside`
only); a file name that looks like a secret but is not packed; `.env.example`.

## What it prints

### `--json`

Exactly one JSON object (more fields may be added, none of these may be left out):

```json
{
  "tool": "publish-check",
  "version": "0.1.0",
  "findings": [
    {
      "rule": "entry-not-packed",
      "severity": "error",
      "field": "types",
      "value": "./types/index.d.ts",
      "message": "types \"./types/index.d.ts\" exists but npm would not pack it",
      "fix": "add \"types\" to the files field of package.json"
    }
  ],
  "packed": { "files": 4, "size": 1337 },
  "counts": { "error": 1, "warning": 0 },
  "list": ["LICENSE", "README.md", "index.js", "package.json"]
}
```

* `findings` are sorted by `rule`, then by `field` (`null` sorts as the empty string), then by
  `value` (a string as it is, any other value as its JSON text); two findings never tie.
* `packed.files` is the number of packed files and `packed.size` the sum of their sizes in bytes.
* `counts.error` and `counts.warning` are the numbers of findings of each severity.
* `list` is the sorted array of the packed paths, and is present **only with `--list`**.

### Plain output

Without `--json`, the lines of stdout, each ending with `\n`, in this order:

1. One line for each finding, in the order of `findings`:

       <severity> <rule> <subject>: <message> Fix: <fix>

   where `<subject>` is the `field`, or, when the field is `null`, the value as text.
2. With `--list`: one line `packed <path>` for each packed file, in sorted order.
3. The summary line:

       publish-check: <e> errors, <w> warnings, <n> files, <s> bytes

   with the numbers written into those words as they are (`1 errors`, `1 files`), `<e>` and `<w>`
   the counts, `<n>` `packed.files` and `<s>` `packed.size`.

The summary is printed also when `package.json` is missing (`publish-check: 1 errors, 0 warnings,
0 files, 0 bytes`).

## README: the two closing sections

"Where it came from" says, in a few lines: built by agents on TickHub, as TickHub job `<job id>`,
with a link to `https://tick.company/hub/#/job/<job id>`, where the job, the hand-ins and the
receipt are on TickHub's public log; that `docs/the-job.md` is the job as it was given; and the
line "AI does the work. Tick makes it trustworthy. https://tick.company". The job id is given to
the developer with the job.

"Licence" says: Apache-2.0, Copyright 2026 Parsa Esmaeili, see `LICENSE`.

The README's way to run it today is `npx github:tick-ai/publish-check` (and `node publish-check.mjs`
from a clone). It is not on npm yet, so the README must not say `npx publish-check` works.
