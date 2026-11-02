# Releasing Perseus

What can be done from the repository is automated in `.github/workflows/ci.yml`. The steps that
need the owner's accounts, money or keys are listed separately so nothing is mistaken for done.

## What CI already does

- `security`: `cargo deny` and `pnpm audit` on every push and weekly.
- `check` (Windows, macOS, Linux): `pnpm build`, Vitest, `cargo fmt`, `clippy -D warnings`, `cargo test`.
- `windows-build`: unsigned NSIS installer, then the end-to-end tests (`pnpm e2e`) against the
  production executable; the installer is uploaded as an artifact. The NSIS installer registers the
  `perseus-app://` address for the installing user (from `plugins.deep-link` in `tauri.conf.json`). Nobody has
  yet run an installer built here to confirm that, so check *Settings → General → Links* and opening a link
  after the first install.
- `other-bundles`: unsigned `.dmg` (macOS) and `.AppImage` / `.deb` (Linux) as artifacts. A green job
  means "it builds", not "it was run": nobody has launched those bundles yet.

## Release checklist

1. All CI jobs green on `main`.
2. Bump the version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and the
   crates that carry one) to the same number.
3. Write the release notes from `git log <last-tag>..HEAD --format=%s` into a GitHub release draft.
   Commit subjects are the changelog; they are one line each by convention.
4. Download the three artifacts and run them on clean machines: install, open a repository, fetch,
   commit, push over HTTPS and SSH, uninstall.
5. Tag `vX.Y.Z` and publish the draft.

## Owner-only items (not done)

| Item | Why it is blocked |
|---|---|
| **Windows code signing** (Authenticode certificate or Azure Trusted Signing) | Needs a paid identity; unsigned installers trigger SmartScreen |
| **macOS signing and notarization** | Needs an Apple Developer account (Developer ID certificate, app-specific password or API key) |
| **Auto-update** | Needs a Tauri updater key pair (the private key must stay secret), an update manifest host (GitHub Releases is the plan), and a review of the extra capability and CSP entries it requires. Nothing is wired yet |
| **Publishing the repository** | The `birth` branch is local; where and when to publish (public or private first) is the owner's call |
| **Name and branding check** | Bundle identifier `dev.perseus.app` is a placeholder; trademark and domain were not checked |
| **Hands-on macOS and Linux verification** | Needs the hardware; keychain backends (Secret Service may be missing), WebKit canvas rendering and HiDPI are unverified |
| **Accessibility audit** | Roles, labels and focus rings exist; a keyboard-only and screen-reader pass has not been done |
| **Localisation** | Strings are inline; extraction was not started |

## Signing secrets

When certificates exist, store them only as GitHub Actions secrets (never in the repository) and
sign in the release job, not in the per-push builds. The updater private key gets the same
treatment and a documented recovery plan: losing it means existing installs can never update.
