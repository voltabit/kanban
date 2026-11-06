# Design system (DESIGN.md) and light/dark/system theme

Date: 2026-11-06
Status: Draft, awaiting review

## Scope

This is the first of three sub-projects. The other two are out of scope here:

1. **This spec:** apply DESIGN.md to the whole app, and add a theme switch (light, dark, system).
2. Board background image (separate spec, next).

Nothing here changes the data model, storage keys, import/export format, or task behavior.

## Goal

- The board's visual system follows DESIGN.md: warm cream canvas, warm ink, Cursor Orange as the only accent, hairline depth with no drop shadows, 400-weight display type, and the DESIGN.md radius scale.
- A theme control lets the user choose **System** (default), **Light**, or **Dark**.
- The dark theme is the same design system in dark form, using the same accent and the same hairline logic.

## Decisions

- **Font:** Inter (the DESIGN.md substitute for CursorGothic). Loaded from Google Fonts, with the system stack as fallback. Weights 400 and 600 only.
- **Shadows:** removed everywhere (cards, dialogs, menu, floating "More" buttons). Depth comes from 1px hairlines and surface contrast.
- **Radii:** buttons and inputs use 8px. Cards, dialogs, and panels use 12px. Pills and badges use full radius. The dialog and menu drop to 12px.
- **Accent:** `primary` #f54e00, `primary-active` #d04200. Blue is removed. Links and focus rings use the orange accent.
- **Status and priority colors:** user-defined status colors are unchanged. Priority tags keep distinct hues but are tuned to the DESIGN.md semantic colors. Timeline pastels are not used, because DESIGN.md scopes them to agent timelines.
- **Semantic colors:** error #cf2d56 (light) and success #1f8a65 (light). Lighter variants are used in dark mode for contrast.

## Token map

Light values come directly from DESIGN.md. The dark values are derived by this spec, since DESIGN.md defines none. Each dark value keeps the warm hue of the light palette.

| Token | Role | Light (DESIGN.md) | Dark (derived) |
|---|---|---|---|
| `--bg` | page canvas | #f7f7f4 canvas | #15140f |
| `--surface` | cards, top bar | #ffffff surface-card | #211f1a |
| `--surface-soft` | dialog footer, comments | #fafaf7 canvas-soft | #1b1a15 |
| `--column` | board columns | #efeee8 hairline-soft | #1d1c17 |
| `--text` | ink | #26251e | #f7f7f4 |
| `--body` | running text | #5a5852 | #cfcdc4 |
| `--muted` | secondary text | #807d72 | #a09c92 |
| `--border` | hairlines | #e6e5e0 | #35332b |
| `--border-strong` | hover and outlines | #cfcdc4 | #4d4a41 |
| `--hover` | button and row hover | #efeee8 | #26241e |
| `--primary` | accent | #f54e00 | #f54e00 |
| `--primary-hover` | accent press | #d04200 | #ff6a2a |
| `--on-primary` | text on accent | #ffffff | #ffffff |
| `--danger` | errors, destructive | #cf2d56 | #f0708a |
| `--success` | completed tag | #1f8a65 | #4cc296 |
| `--focus` | focus ring | #f54e00 | #f54e00 |
| `--toast-bg` / `--toast-text` | toast | ink / canvas | canvas / ink |

Contrast targets (WCAG AA for text): `--text` on `--surface` and `--body` on `--surface` at least 4.5:1 in both themes. `--primary` used as text on `--bg` is at least 3:1 in dark mode for large text. Verified with a script before implementation is accepted.

Radius, spacing, and type tokens are shared across themes and live on `:root`.

## Theme mechanism

- Stored preference: `localStorage["kanban-board.theme"]`, value `"system"`, `"light"`, or `"dark"`. Absent means `"system"`.
- Applied as `data-theme` on `<html>`:
  - `light` or `dark`: attribute set explicitly.
  - `system`: attribute removed, so the `prefers-color-scheme` media query decides.
- Dark tokens are defined twice, matching the pattern used for artifacts:
  - `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } }`
  - `:root[data-theme="dark"] { ... }`
- `color-scheme` is set to `light` or `dark` so native controls (scrollbars, date inputs, selects) match.
- An inline script in `<head>` applies the stored theme before first paint, so there is no flash of the wrong theme. It is wrapped in try/catch; if storage is unavailable it falls back to system.
- The control is a `<select>` labeled "Theme" in the burger menu, with options System, Light, Dark. Changing it writes the preference and updates `data-theme` immediately. No re-render of the board is needed, since everything is CSS-driven.
- Storage failures are caught and ignored. The app still works, and the theme simply does not persist.

## Changes by file

- `styles.css`: replace the `:root` block with the token set above. Add the dark overrides. Replace every hardcoded color (for example `#f8fafc`, `#f1f5f9`, `#dbeafe`, `#94a3b8`, `#fef2f2`, `#dcfce7`, `#166534`, `#0f172a`) with a token. Remove box shadows. Set the font stack to Inter. Adjust radii as described above.
- `index.html`: add the Inter `<link>` (Google Fonts) and the head script for the theme. Add the Theme select to the burger menu.
- `app.js`: read and write the theme preference (with try/catch), and wire the select's `change` event to it. No change to data handling.

## Out of scope

- Background image on the board (sub-project 2).
- Any change to status colors, data format, or storage keys for board data.
- Hover-state design (DESIGN.md states it is not documented; hover uses the `--hover` token).

## Testing and verification

- No test framework exists in this repo, so verification is manual plus a script:
  - Contrast script: compute the contrast ratios in the token table for both themes and report failures.
  - Browser check at phone width (16px gutter, no horizontal page scroll on the page itself) and desktop width, in all three theme settings, including when the OS switches between light and dark while set to System.
  - Confirm no drop shadows remain (`box-shadow` search returns nothing) and no hardcoded colors remain outside `:root` and the dark blocks.
  - Confirm the saved board data is unchanged after switching themes.

## Open points for review

1. The dark palette is derived by this spec, not taken from DESIGN.md. Please confirm it, or give specific values to use.
2. Priority tags keep distinct hues rather than all turning neutral. This is a judgment call that you can change.
