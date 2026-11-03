# Accessibility

What Perseus does for people who use a keyboard, a screen reader, a high-contrast mode or large text, and what
has not been checked. This is an engineering audit, not a certification: nobody has yet used Perseus with
VoiceOver, NVDA or JAWS, and that is the main thing still to do.

## What is in place

- **Keyboard only.** Every action has a keyboard route: the command palette (`⌘K` / `Ctrl+K`) reaches most
  commands, dialogs trap and restore focus, menus and pickers follow the arrow-key patterns, and splitters
  resize with the arrow keys. The commit graph moves with the arrow, Page and Home/End keys; the **menu key or
  Shift+F10** opens the context menu of the selected commit.
- **Customizable shortcuts** (*Settings → Keyboard shortcuts*), so a shortcut that clashes with an assistive
  tool or the system can be moved or removed.
- **The commit graph as a list.** The graph is drawn on a canvas, which assistive technology cannot read. The
  rows on screen are repeated as a list of options (visually hidden) with the message, author, date, branches,
  tags and merge state, and the list reports the selected commit through `aria-activedescendant`.
  Everything else in the window is ordinary HTML.
- **Contrast.** `src/lib/contrast.test.ts` reads the colour tokens of all four themes (Slate and Indigo, dark and
  light) and fails the build unless text reaches 4.5:1, branch and tag labels 4.5:1 and the graph's lanes 3:1
  against the surfaces they sit on (WCAG 2.1 AA, success criteria 1.4.3 and 1.4.11). The audit found and fixed
  the light theme's faint text and status colours, the white label on the green branch tag, and one yellow lane.
- **Zoom** from 50% to 200% (`⌘+` / `⌘-` / `⌘0`, or *Settings → UI Customization*), done by the web view, so the
  canvas stays sharp.
- **High-contrast modes.** Under `forced-colors` (Windows contrast themes) controls keep an outline and the
  focus ring uses the system's highlight colour.
- **Motion.** `prefers-reduced-motion` switches animations off.
- **Names.** Icon-only buttons require a label in code (`IconButton`), form fields have labels, status changes
  use `role="status"` / `role="alert"` or live regions, and a scripted scan of the welcome screen and every
  settings page found no unnamed control, duplicate id or image without text.

## Not done

- A screen-reader pass with real software (VoiceOver on macOS, NVDA on Windows, Orca on Linux).
- The diff view and the interactive rebase list have not been audited for reading order and announcements.
- Dragging a branch onto another (merge, rebase, cherry-pick) has no keyboard equivalent on the graph itself;
  the same operations are in the commit and branch context menus and the command palette.
- Text is only as translatable as the strings that have been moved into the catalogue (see `docs/localisation.md`).
