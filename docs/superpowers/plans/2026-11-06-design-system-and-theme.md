# Design system and theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply DESIGN.md to the kanban board and add a System / Light / Dark theme control.

**Architecture:** Plain HTML, CSS, and JS with no build step. All colors become CSS custom properties on `:root`, with dark values in two blocks (`prefers-color-scheme` for System, and `data-theme="dark"` for an explicit choice). A small inline script in `<head>` sets `data-theme` before first paint. The preference is stored in `localStorage`, guarded by try/catch.

**Tech Stack:** HTML5, CSS custom properties, vanilla JavaScript, Google Fonts (Inter).

**Spec:** `docs/superpowers/specs/2026-11-06-design-system-and-theme-design.md`. The token table in that spec is authoritative for every color value and token name.

## Global Constraints

- Font: Inter, weights 400 and 600 only, system stack as fallback (spec: Decisions).
- No drop shadows anywhere (spec: Decisions).
- Radii: buttons and inputs 8px; cards, dialogs, panels 12px; pills full (spec: Decisions).
- Accent: `--primary` #f54e00, `--primary-hover` light #d04200 and dark #ff6a2a (spec: token map).
- Storage key for theme: `kanban-board.theme`, values `system` | `light` | `dark`, absent means `system` (spec: Theme mechanism).
- Board data, storage key `kanban-board.v1`, import/export format: unchanged (spec: Scope).
- No hardcoded colors outside the `:root` and dark blocks.
- No git repository here: skip commit steps. Each task ends with a verification step instead.

## Review Focus

1. `localStorage` throws or is unavailable (private window, blocked storage): the page must render in System theme, and changing the Theme select must not throw.
2. Stored theme value is not one of the three allowed values (for example `"purple"` or `null`): treat as `system`.
3. OS color scheme changes while the preference is `system`: the page switches without reload.
4. Explicit `light` or `dark` choice ignores the OS setting: OS changes must not alter an explicit choice.
5. Page load in dark mode: no flash of light theme before the stylesheet applies.

Each line gets its test in the owning task (Tasks 3 and 4).

---

### Task 1: Light design system tokens in styles.css

**Files:**
- Modify: `styles.css` (`:root` block lines 1-13; every hardcoded color and shadow; radii)
- Modify: `index.html` (add Inter `<link>` in `<head>`, before `styles.css` link)

**Interfaces:**
- Consumes: spec token table (light column).
- Produces: custom properties `--bg`, `--surface`, `--surface-soft`, `--column`, `--text`, `--body`, `--muted`, `--border`, `--border-strong`, `--hover`, `--primary`, `--primary-hover`, `--on-primary`, `--danger`, `--success`, `--focus`, `--toast-bg`, `--toast-text`. Later tasks define the dark values for these exact names. Also `--radius` remains for compatibility and is set to 12px.

- [ ] **Step 1: Replace the `:root` block**

Replace lines 1-13 of `styles.css` with a `:root` block that defines every token name above using the light column of the spec token table. Add `color-scheme: light;` and `font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;` on `body`.

- [ ] **Step 2: Add Inter to index.html**

Add to `<head>` before the stylesheet link:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap">
```

- [ ] **Step 3: Replace hardcoded colors with tokens**

Map each hardcoded value in `styles.css` to a token:

| Old value | Token |
|---|---|
| `#f1f5f9`, `rgba(241, 245, 249, 0)` (gradients), `#f8fafc` (comment and dialog foot backgrounds) | `--bg` / `--surface-soft` as appropriate |
| `#f8fafc` (button hover, board more hover) | `--hover` |
| `#2563eb` | `--primary` |
| `#1d4ed8` | `--primary-hover` |
| `#dc2626`, `#fca5a5`, `#fef2f2` | `--danger`, `--border-strong`, `--hover` |
| `#e9eef5`, `#dbeafe` (drop target) | `--column`, `--column` (drop target uses `--hover`) |
| `#94a3b8` (dashed add button, card hover) | `--border-strong` |
| `#0f172a` (toast, text) | `--text` / `--toast-bg` |
| `#991b1b` (error toast) | `--danger` |
| `#e0f2fe`, `#075985` (p-low) | see step 4 |
| `#dcfce7`, `#166534` (done tag) | `--success` background via `color-mix(in srgb, var(--success) 18%, transparent)`, text `--success` |
| `#fff` on primary buttons | `--on-primary` |

- [ ] **Step 4: Priority tags**

Keep four distinct tags using DESIGN.md semantic hues: Low uses `--muted` text on `--hover`, Medium uses `--primary` text on a 14% `--primary` tint, High uses `--primary-active` text on a 22% `--primary` tint, Critical uses `--danger` text on a 14% `--danger` tint. Use `color-mix` for tints. This matches the spec's "distinct hues tuned to semantic colors" decision.

- [ ] **Step 5: Remove shadows and set radii**

Set `box-shadow: none` for `.card`, `dialog`, `.menu-panel`, and `.board-more`. Do not leave any `box-shadow` declaration with a non-none value. Set `--radius` to 12px. Set `dialog` and `.menu-panel` border-radius to 12px. Buttons and inputs stay at 8px.

- [ ] **Step 6: Verify light theme**

Run: open `index.html` in a browser with the OS in light mode. Expected: cream page background, white cards with hairline borders, orange primary buttons, Inter font, no shadows. Then run:

```
rg -n "box-shadow" styles.css
```
Expected: only `box-shadow: none` lines.

```
rg -n "#[0-9a-fA-F]{3,6}|rgba?\(" styles.css
```
Expected: matches only inside the `:root` block and the priority tag and `color-mix` expressions defined in Step 4 and Step 5 of Task 2. Anything else is a missed token.

---

### Task 2: Dark theme tokens and theme mechanism in CSS

**Files:**
- Modify: `styles.css` (add two dark blocks after `:root`)

**Interfaces:**
- Consumes: the token names from Task 1.
- Produces: `data-theme` attribute contract used by Task 3. `light` and `dark` set explicitly; absent means follow OS.

- [ ] **Step 1: Add the system dark block**

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* dark token values from the spec table */ }
}
```

- [ ] **Step 2: Add the explicit dark block**

```css
:root[data-theme="dark"] { /* the same dark token values */ }
```

The two blocks must hold identical values. Set `color-scheme: dark` in both. Set `color-scheme: light` in the base `:root`. Use the dark column of the spec token table for every token name.

- [ ] **Step 3: Verify token parity**

Run a script in the scratchpad directory (not in the repo) that reads `styles.css`, extracts the declarations from the `:root` block and both dark blocks, and fails if the sets of property names differ or if the two dark blocks differ in value. Expected output: `parity ok`.

- [ ] **Step 4: Verify contrast**

Run a Node script in the scratchpad directory that computes WCAG contrast for these pairs in both themes, using the spec token values: `--text` on `--surface`, `--body` on `--surface`, `--muted` on `--surface`, `--primary` on `--bg`, `--on-primary` on `--primary`, `--danger` on `--surface`, `--success` on `--surface`. Expected: every text pair at least 4.5:1, `--primary` on `--bg` at least 3:1. Any failure is reported and the token is adjusted before continuing.

- [ ] **Step 5: Verify dark rendering**

Open the page with the OS in dark mode, theme set to System. Expected: dark canvas, light text, orange primary buttons. Then add `data-theme="dark"` to `<html>` in the browser devtools and then `data-theme="light"`. Expected: explicit values override the OS setting in both directions.

---

### Task 3: Theme control, pre-paint script, and persistence

**Files:**
- Modify: `index.html` (inline head script; Theme select in `#menu-panel`)
- Modify: `app.js` (theme read/write helpers; select wiring; init call)

**Interfaces:**
- Consumes: `data-theme` contract from Task 2.
- Produces in `app.js`: `const THEME_KEY = "kanban-board.theme"`, `function getStoredTheme()` returning `"system" | "light" | "dark"`, `function applyTheme(value)`, `function setTheme(value)`. The select element has id `theme-select`.

- [ ] **Step 1: Inline head script in index.html**

Add to `<head>` before the stylesheet link:

```html
<script>
  (function () {
    try {
      var t = localStorage.getItem("kanban-board.theme");
      if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    } catch (e) { /* storage blocked: follow the OS */ }
  })();
</script>
```

This runs before first paint. Invalid values are ignored, so the page falls back to System (Review Focus 2 and 5).

- [ ] **Step 2: Theme select in the burger menu**

Insert into `#menu-panel` after the Import/Export buttons:

```html
<label class="menu-select">Theme
  <select id="theme-select" aria-label="Theme">
    <option value="system">System</option>
    <option value="light">Light</option>
    <option value="dark">Dark</option>
  </select>
</label>
```

Add CSS for `.menu-select` (`display: flex; gap: 8px; align-items: center; padding: 8px 10px; font-weight: 400;`).

- [ ] **Step 3: Helpers in app.js**

Add near the storage section:

- `getStoredTheme()`: reads `THEME_KEY` inside try/catch; returns `"light"` or `"dark"` if stored, otherwise `"system"`. Any other stored value returns `"system"`.
- `applyTheme(value)`: if `value` is `light` or `dark`, set `document.documentElement.dataset.theme = value`; otherwise remove the attribute. Does not touch storage.
- `setTheme(value)`: validates `value` (anything other than the three allowed values becomes `"system"`), writes it to storage inside try/catch (on failure, show nothing; the choice still applies for this page view), then calls `applyTheme`.

- [ ] **Step 4: Wire the select**

In `init()`, set `$("theme-select").value = getStoredTheme()` and add a `change` listener calling `setTheme($("theme-select").value)`. Do not re-render the board: theme is CSS-only.

- [ ] **Step 5: Verify persistence and fallbacks**

Each check is done in a browser. Expected results:

1. Choose Dark, reload. Expected: dark page, select shows Dark, no light flash on reload (watch the first frame).
2. Set `localStorage["kanban-board.theme"] = "purple"` in devtools, reload. Expected: System theme, no error in console.
3. Block storage (private window or devtools storage block), load page. Expected: page renders in System theme, no uncaught error; changing the select does not throw.
4. With preference System, change the OS color mode. Expected: page switches without reload (Review Focus 3).
5. With preference Light, change the OS color mode. Expected: stays Light (Review Focus 4).
6. Export JSON before and after switching themes; the files match apart from `exportedAt`. Expected: board data unchanged.

---

### Task 4: Final verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Layout at phone width**

Open at 390px width in all three theme settings. Expected: 16px side gutter on the topbar and dialogs; no horizontal page scroll (only the board scrolls horizontally).

- [ ] **Step 2: Desktop width**

Open at 1280px in all three theme settings. Expected: board columns fill the width as before; the "More" hint buttons still appear when columns overflow.

- [ ] **Step 3: Full token audit**

Run `rg -n "#[0-9a-fA-F]{3,6}|rgba?\(" styles.css` and check that every match is inside a token block or a `color-mix` tint. Expected: no other matches.

- [ ] **Step 4: Report**

Report the result of each check above with the actual output. If any check fails, fix it, rerun that check, and report the rerun result.
