# Security notes for contributors

Perseus handles source code and credentials, so the webview is treated as untrusted.

## How the layers fit

- **Capabilities** (`src-tauri/capabilities/default.json`): the main window may call only the
  app commands listed there. There are no filesystem, shell, opener or dialog grants; native
  pickers are opened from Rust.
- **Isolation pattern** (`isolation/index.js`): every IPC message passes through a sandboxed
  iframe whose hook rejects any command not on its allowlist. Tauri then encrypts the message
  with a key generated at startup. A blocked call is dropped and its promise never settles;
  the iframe logs the command name to the console.
- **Content-Security-Policy** (`src-tauri/tauri.conf.json`): production allows only scripts and
  styles from the app itself. Development additionally allows inline styles and the Vite
  websocket, so **a CSP problem can only show up in a release build** (see below).
- **Input validation** (`src-tauri/src/git/validate.rs`, `perseus_credentials::validate`): every
  string from the webview is validated before it becomes a git argument or a credential line.
- **One place that spawns git** (`src-tauri/src/git/cli.rs`): argument vectors only, scrubbed
  environment, no prompts, no repo-configured programs (`--no-ext-diff`, `--no-textconv`).

## Adding a Tauri command

A new command must be added in **three** places, or it will not work:

1. `COMMANDS` in `src-tauri/build.rs`
2. `allow-<command-with-dashes>` in `src-tauri/capabilities/default.json`
3. `ALLOWED` in `isolation/index.js`

`cargo test -p perseus --test isolation_allowlist` fails when they disagree.

## Checking a release build

```
pnpm tauri build --no-bundle
```

To read the production page's console (CSP violations appear there), launch the built exe with
WebView2's debug port open and attach any DevTools-protocol client to it:

```
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
.\target\release\perseus.exe
```

Known, harmless console message: two "Applying inline style violates ... style-src 'self'"
entries. They come from Tauri's isolation iframe trying to hide itself with an inline style;
`src/App.css` hides it instead (`body > iframe`), so the policy stays strict.

## Dependency checks

- `cargo deny check` (advisories, licenses, duplicate versions, sources; policy in `deny.toml`)
- `pnpm audit --audit-level high`

Both run in CI on every push and weekly. Each ignored advisory in `deny.toml` carries a reason;
revisit them when `tauri` or `keyring` update.

## Known limits

- The credential helper is not bundled into installers yet; it must sit next to the app.
- The refresh lock file lives in the user's runtime/temp directory and is opened without
  `O_NOFOLLOW`; it is only an advisory lock and is never written to.
- Project license is not chosen yet (`deny.toml` ignores unpublished workspace crates).
