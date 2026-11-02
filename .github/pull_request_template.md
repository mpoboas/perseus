## What and why

## Checklist

- [ ] `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`
- [ ] `pnpm build` and `pnpm test`
- [ ] New Tauri commands are registered in `build.rs`, `capabilities/default.json` and `isolation/index.js`
- [ ] Verified in the running app (a release build if the UI or CSP changed)
- [ ] Docs updated
