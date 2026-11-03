# Branding

The Perseus logo is a winged helmet (Perseus wore Hermes' winged sandals and helm) with a commit graph
at its foot, inside a dark disc ringed by a sweeping orbit.

## Files

| File | What it is | Where it is used |
|---|---|---|
| `branding/perseus-logo.png` | The logo in colour, as supplied (581 × 531, transparent background) | The README (light pages) |
| `branding/perseus-logo-white.webp` | The one-colour white version, as supplied (1254 × 1254, transparent) | Source of the white PNG below |
| `branding/perseus-logo-white.png` | The white version cropped and sized for the web (640 px wide) | The README on dark pages |
| `branding/app-icon.png` | The colour logo centred on a transparent 1024 × 1024 square (about 8% margin) | Source of every application icon |
| `public/logo.png` | The colour logo cropped tight | The welcome screen (`Logo` in `src/Welcome.tsx`) |
| `public/logo-white.png` | Same as the white PNG above | Available for dark surfaces |
| `public/favicon.png` | 64 × 64 square | The web view's icon (`index.html`) |
| `src-tauri/icons/*` | Generated: `icon.ico` (Windows), `icon.icns` (macOS), PNGs (Linux, Windows Store tiles) | The executable, window, taskbar and installers |

## Changing the logo

Replace `branding/perseus-logo.png` (and the white one), rebuild `branding/app-icon.png` so the artwork is
centred on a transparent square, then regenerate the icons:

```bash
pnpm tauri icon branding/app-icon.png
```

That rewrites `src-tauri/icons/`. It also writes `android/` and `ios/` folders and a `64x64.png`, which
Perseus does not use: delete them. Then crop the colour logo into `public/logo.png` and make a 64 px
`public/favicon.png`.

The supplied colour logo is 581 px wide, so the largest icon sizes (the 512 and 1024 px ones used by macOS)
are enlarged a little and look slightly soft. A larger source file (1024 px or more, or an SVG) would fix
that.

## Using it

- Keep the margin around the logo; do not stretch it.
- On a light background use the colour logo (its own dark disc carries it); on a dark one use either.
- The white version is for dark or coloured surfaces only.
