# Localisation

Perseus can show its interface in more than one language. English is the source; European Portuguese is
the first translation. *Settings → UI Customization → Language* switches at once, with no restart, and
"Follow system" picks Portuguese when the system's first language we have is Portuguese.

## What is translated

The window you see first and the settings: the welcome screen, the toolbar and its menus and tooltips, the
status bar, the keyboard-shortcut cheat sheet and its settings page, the navigation and Appearance page of
Settings, and the shortcut recorder's messages. About 190 messages.

## What is not (yet)

Everything else is still written inline in English: the dialogs (clone, rebase, conflicts, profiles,
maintenance, Gitflow, …), the sidebar, the changes panel, the diff and the other settings pages, error
messages that come from Git or from the Rust backend, and relative times ("26d ago"). A message that is not
in the catalogue simply stays English, so a half-translated window is safe, only uneven. Dates follow the
system's own language through `toLocaleString`.

## How it works

- `src/i18n/en.ts` holds the English messages, `src/i18n/pt-PT.ts` the translations, `src/i18n/index.ts` the
  lookup. Keys are `area.name`; placeholders are `{name}`; a message with `_one` and `_other` variants is a
  plural chosen by the `count` value.
- Components call `const t = useT()` and `t("tb.fetch")`; the hook re-renders them when the language changes.
  Code outside components (a message written when something happens) imports `t` directly.
- A key that is missing from English is a TypeScript error; one missing from a translation falls back to
  English. `src/i18n/i18n.test.ts` fails when the Portuguese catalogue lacks a message, has one English does
  not, or changes a message's placeholders.

## Moving more of the interface over

1. Pick a component, add `const t = useT()` and replace each user-visible string with a key.
2. Add the key to `en.ts`, and the translation to `pt-PT.ts`.
3. `pnpm test` and `pnpm exec tsc --noEmit` say what is missing.

## Adding a language

Copy `pt-PT.ts` to a new file, translate it, add the locale to `Locale`, `CATALOGS`, `LANGUAGES` and
`systemLocale` in `src/i18n/index.ts`, and extend the test's list of catalogues. Text direction is not handled:
a right-to-left language would need layout work first.
