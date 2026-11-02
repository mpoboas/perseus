# Contributing to Perseus

Thanks for helping. Perseus is a visual Git client: Tauri v2 and Rust on the back end, React and
TypeScript on the front end. The rules that keep it safe and fast are short.

## Setup

- Rust (stable, MSVC on Windows), Node 22 and pnpm (`corepack enable`), and `git` on `PATH`.
- `pnpm install`, then `pnpm tauri dev`.
- Tests: `cargo test --workspace` and `pnpm test`. Lints: `cargo fmt --all`,
  `cargo clippy --workspace --all-targets -- -D warnings`, `pnpm build`.

## Rules for changes

1. Git runs only through `src-tauri/src/git/cli.rs`. Never build a shell string.
2. Every string that comes from the webview is validated in `src-tauri/src/git/validate.rs`
   before it reaches git. Secrets never travel to the webview.
3. A new Tauri command needs three edits: `COMMANDS` in `src-tauri/build.rs`, a permission in
   `src-tauri/capabilities/default.json`, and an entry in `isolation/index.js`. A test fails
   when they disagree.
4. Back-end behaviour gets tests that run real `git` in temporary repositories, including hostile
   input. Pure front-end logic gets Vitest tests.
5. Check UI changes in a release build (`pnpm tauri build --no-bundle`): the production
   Content-Security-Policy is stricter than the development one.
6. Commit messages are a single subject line.

See `docs/roadmap.md` for what is planned and `docs/security.md` and `docs/threat-model.md` for the security rules.

## License

By contributing you agree that your work is released under the MIT license in `LICENSE`.
