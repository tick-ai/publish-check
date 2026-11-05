# publish-check

publish-check reads a package folder and tells you what is wrong with it before you run `npm publish`: an entry point that is not shipped, an `exports` path that leads nowhere, a `bin` without a shebang, types left out of `files`. It never runs npm, never runs your code and never changes a file.

```
npx github:tick-ai/publish-check
```

A real run, on a small package whose `types` file is not in `files`:

```
$ npx github:tick-ai/publish-check --list
error bin-shebang bin["demo"]: "bin/cli.js" does not begin with "#!" Fix: add a first line such as #!/usr/bin/env node to the file
error entry-not-packed exports["."]["types"]: "./types/index.d.ts" exists but npm would not pack it Fix: add "types/index.d.ts" to the files field of package.json
error entry-not-packed types: "./types/index.d.ts" exists but npm would not pack it Fix: add "types/index.d.ts" to the files field of package.json
error types-order exports["."]["types"]: "types" is not the first key of its conditions object (it points at "./types/index.d.ts"), so TypeScript may skip it Fix: move the "types" key to the first place in the conditions object
packed bin/cli.js
packed lib/index.js
packed package.json
publish-check: 4 errors, 0 warnings, 3 files, 453 bytes
```

The exit status is 1, so it can stop a release in CI.

## What it finds, and why it matters

An agent changes a build, the tests stay green, the package is published, and the next version cannot be imported: `main` points at a file that is not shipped, an `exports` path is wrong, `bin` has no shebang, the types are not in `files`. Nobody sees it until a user does.

publish-check is the check to run before every `npm publish`. It works out the list of files npm would pack (from `files`, `.npmignore` or `.gitignore`, and the files on disk), then reports every broken entry point with the rule, the field, the value and the fix. Nothing has to be installed and no network is used.

## Run it

Plain Node 22, built-in modules only, nothing to install. It is not on npm yet: run it with `npx github:tick-ai/publish-check`, or from a clone with `node publish-check.mjs`.

```
node publish-check.mjs [dir] [--json] [--list] [--fail-on error|warning|none] [--max-size <bytes>]
```

| Argument | Meaning |
| --- | --- |
| `dir` | The package folder, relative to the current directory or absolute. At most one. Default: `.` |
| `--json` | Print exactly one JSON object on stdout (see "JSON format"). |
| `--list` | Add the list of packed files to the output. |
| `--fail-on <level>` | The next argument is the level: exactly `error`, `warning` or `none`. Default: `error`. |
| `--max-size <bytes>` | The next argument is a limit: digits only, a decimal whole number. Without it there is no limit. |

Options may come before or after `dir` and may be repeated; the last `--fail-on` or `--max-size` wins. `--fail-on=error` is an unknown option, and so is `--help`: any argument that starts with `-` is a usage error, except the value taken by `--fail-on` or `--max-size`.

### Exit codes

| Status | When |
| --- | --- |
| `0` | No finding has a severity that `--fail-on` counts. With `--fail-on none` it is always `0` (unless the arguments are wrong). |
| `1` | A finding has a severity that `--fail-on` counts: with `error` (the default) an error counts; with `warning` an error or a warning counts. |
| `2` | A usage error: a message on stderr, nothing on stdout. These are usage errors: an unknown option (`--` alone too), `--fail-on` or `--max-size` with no argument after it, a `--fail-on` value that is not `error`, `warning` or `none`, a `--max-size` value that is not digits only, more than one `dir`, a `dir` that does not exist or is not a folder. |

## Plain output

One line for each finding, sorted by rule, field and value:

```
<severity> <rule> <subject>: <message> Fix: <fix>
```

`<subject>` is the field, or, when the field is `null`, the value as text (for example the path of a file). With `--list`, one line `packed <path>` for each packed file follows, in sorted order. The last line is always:

```
publish-check: <e> errors, <w> warnings, <n> files, <s> bytes
```

The words are not adjusted to the numbers (`1 errors`, `1 files`). The summary is printed also when `package.json` is missing.

## JSON format

`--json` prints one object and nothing else on stdout:

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
      "message": "\"./types/index.d.ts\" exists but npm would not pack it",
      "fix": "add \"types/index.d.ts\" to the files field of package.json"
    }
  ],
  "packed": { "files": 4, "size": 1337 },
  "counts": { "error": 1, "warning": 0 },
  "list": ["LICENSE", "README.md", "index.js", "package.json"]
}
```

* `findings` are sorted by `rule`, then `field` (`null` sorts as the empty string), then `value` (a string as it is, any other value as its JSON text). Sorting compares code units.
* `field` is a string or `null`. `value` is the JSON value the finding is about: the string as written in `package.json` for an entry, a path for a packed file, a number for a size, `null` when something is missing.
* `message` and `fix` are one line each.
* `packed.files` is the number of packed files and `packed.size` the sum of their sizes in bytes (the files unpacked and uncompressed: no tarball is made).
* `counts` holds the number of findings of each severity.
* `list` is the sorted array of packed paths, present only with `--list`.

## The rules

Severity is `error` or `warning`. A target is a string found in `main`, `module`, `types`, `typings`, `browser`, `bin` or `exports`; a field that is absent, `null` or of another type is not looked at.

### `package-json` (error)

`package.json` is missing, is not a regular file, is not valid JSON, or is valid JSON that is not an object. It is the only finding then, and nothing is packed.

### `exports-form` (error)

A string in `exports` that does not start with `./`.

```json
{ "exports": { ".": "lib/index.js" } }
```

### `entry-outside` (error)

A target that starts with `/` or has a `..` part, such as `"main": "../index.js"` or `"./../x.js"` in `exports`.

### `entry-missing` (error)

The target is not a file of the package folder. `"main": "lib"` and `"main": "index"` are reported too: `main` is not resolved the way Node does it. An `exports` target with a `*` is missing when it matches no file.

```json
{ "main": "dist/index.js" }
```

with no `dist/index.js` on disk (the build did not run).

### `entry-not-packed` (error)

The file exists but npm would not pack it, for example because `files` does not list it.

```json
{ "types": "./types/index.d.ts", "files": ["lib"] }
```

### `bin-shebang` (error)

A `bin` target that is packed does not begin with the two bytes `#!` (an empty file or a file that starts with a byte-order mark does not). A `bin` target that is missing or not packed is reported once, as `entry-missing` or `entry-not-packed`.

### `type-mismatch` (error)

With `"type": "module"` or `"type": "commonjs"`, a `.js` entry file (a target of `main`, `bin` or `exports` that is packed) is written in the other style. With `"type": "module"` it uses `require(...)` (unless the file mentions `createRequire`) or `module.exports`; with `"type": "commonjs"` it uses `import ... from`, `import 'x'`, `import.meta` or a top-level `export`. The file is read as tokens, so words in comments, strings, templates and regular expressions are not uses, and neither is a dynamic `import()` in a CommonJS file. `.mjs`, `.cjs` and `.ts` files are never looked at.

```json
{ "type": "module", "main": "index.js" }
```

with `module.exports = ...` in `index.js`.

### `types-order` (error)

In `exports`, an object that has a key `types` and no key that starts with `.` is a conditions object, and `types` must be its first key, in the order written in `package.json`. TypeScript takes the first condition that matches.

```json
{ "exports": { ".": { "import": "./index.js", "types": "./index.d.ts" } } }
```

The finding is at `exports["."]["types"]`. An object with subpath keys (`"."`, `"./x"`) is not a conditions object.

### Metadata (warning)

`license-missing`, `license-invalid`, `repository-missing`, `repository-invalid`, `engines-node-missing`, `engines-node-invalid`, `description-missing`, `description-invalid`. A field that is absent or `null` is missing; a field that is present but wrong is invalid, and the finding's value is the JSON value as written.

* `description`: a string that is not empty after trimming.
* `engines.node`: `engines` is an object with a string `node` that is not empty after trimming. The range is not parsed.
* `repository`: a string that is not empty after trimming, or an object whose `url` is such a string.
* `license`: an SPDX expression (the list of licence names is not looked up) or `SEE LICENSE IN <text>`. `MIT`, `Apache-2.0`, `(MIT OR Apache-2.0)`, `GPL-2.0+` and `GPL-2.0-only WITH Classpath-exception-2.0` are valid; `Apache 2`, `MIT OR`, `(MIT` and `MIT MIT` are not.

### `packed-secret`, `packed-junk`, `packed-fixture` (warning)

Packed files that look like secrets, junk or large test fixtures. Only names are compared (the contents of files are not looked at), and only files that would be packed.

* `packed-secret`: `.env`, `.env.*` (but not `.env.example`, `.env.sample`, `.env.template`), `.netrc`, `.htpasswd`, `credentials.json`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, and names ending in `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`.
* `packed-junk`: `thumbs.db`, `desktop.ini`, names ending in `.log`, `.tmp`, `.bak`, `.swo`, `.tsbuildinfo` or `~`, and files in a folder named `.idea`, `.vscode`, `coverage`, `.nyc_output` or `__MACOSX`.
* `packed-fixture`: a file larger than 102400 bytes in a folder named `test`, `tests`, `__tests__`, `spec`, `fixtures` or `__fixtures__`.

### `package-too-large` (error)

`--max-size` is given and the packed size is greater than it. The value is the size.

## Which files are packed

The packed files are worked out in three steps:

1. **Left out always.** From the files of the folder (walked at any depth, without `.git` and `node_modules`, without following symbolic links): files in a `.svn`, `.hg` or `CVS` folder; `.DS_Store`, `.npmrc`, `.npmignore`, `.gitignore`, `.lock-wscript`, `npm-debug.log`, `config.gypi`; names starting with `._`; names ending in `.orig`; `.something.swp`; `.wafpickle-<digits>`; and, at the root, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`.
2. **Chosen.** If `files` is an array, its patterns choose. Otherwise a root `.npmignore` ignores by its lines; otherwise a root `.gitignore`; otherwise everything is chosen. With a `files` array the ignore files are not read.
3. **Always included.** `package.json`; the root `README*`, `LICENSE*` and `LICENCE*` files; and the files named by `main`, `browser` (a string) and each `bin` target.

Patterns (in `files`, `.npmignore` and `.gitignore`): a leading `!` negates; `*` matches any characters in a name (dot files too); `?` one character; `**` as a whole part any number of folders; a trailing `/` matches folders only; a pattern with a `/` in it, or a leading `/`, is anchored to the root; a pattern without one matches a name at any depth; patterns of `files` are always anchored. The last pattern that matches a path decides. Matching is case sensitive.

## Implemented and not implemented

| Implemented | Not implemented |
| --- | --- |
| The `files` field with its patterns, `!` exclusions included | `.npmignore` and `.gitignore` files in folders below the root |
| The root `.npmignore` | The user's and the global ignore files |
| The root `.gitignore`, when there is neither a `files` array nor `.npmignore` | `bundleDependencies` and the dependencies' own files (`node_modules` is never packed) |
| The files npm always includes: `package.json`, README, LICENSE or LICENCE, `main`, `browser` and `bin` targets | `workspaces` |
| The files npm always leaves out (step 1 above) | npm's own pattern syntax beyond the text above: `[...]` classes, `{a,b}` alternatives, `\` escapes (these characters stand for themselves) |
| The entry rules for `main`, `module`, `types`, `typings`, `browser`, `bin` and every string in `exports` | The `directories` field |
| The `type` check, `types` first, metadata, secrets by name, `--max-size` | The legacy resolution of `main` without an extension or naming a folder |
| | `exports` validation beyond the entry rules: the resolution algorithm of Node, `imports`, `#` specifiers, condition names |
| | The content of files (secrets are found by name only) |
| | The compressed tarball size |

So a file may be packed by npm and not by this tool, or the other way round. Where that makes a finding wrong for a real package, this README is what publish-check does, not what npm does.

## Tests

`node --test`

## Where it came from

publish-check was built by agents on TickHub, as TickHub job `902e56a1-2429-478e-a0cf-d61b03a2098d`. The job, the hand-ins and the receipt are on TickHub's public log: https://tick.company/hub/#/job/902e56a1-2429-478e-a0cf-d61b03a2098d. `docs/the-job.md` is the job as it was given.

AI does the work. Tick makes it trustworthy. https://tick.company

## Licence

Apache-2.0. Copyright 2026 Parsa Esmaeili. See `LICENSE`.
