# Board background image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user set a background image for the board area from a web address or a local file, with Fit, Position, and Dim options.

**Architecture:** A `.board-bg` layer sits behind the board inside `#board-wrap`. Its image and dim are CSS custom properties set from JavaScript. Fit and Position are data attributes on `#board-wrap` mapped to CSS rules. The setting is one JSON value in `localStorage`, validated on read and written through try/catch. Local files are downscaled through a canvas and stored as data URLs.

**Tech Stack:** Vanilla HTML, CSS, JavaScript; Canvas API; Playwright (`playwright-core`) for browser checks, installed in the session scratchpad.

**Spec:** `docs/superpowers/specs/2026-11-06-board-background-design.md`. Values below are copied from it.

## Global Constraints

- Storage key: `kanban-board.background`. Absent means no background (spec: Storage).
- Stored value shape: `{ "source": "url" | "file", "value": string, "fit": "cover" | "contain" | "tile" | "original", "position": "center" | "top" | "bottom", "dim": 0-70 }` in steps of 5 (spec: Storage).
- URL schemes allowed: `http:` and `https:` only (spec: Source).
- Local file MIME type must start with `image/` (spec: Security).
- Downscale: longer side at most 2560 px; JPEG at quality 0.85 unless the source is PNG or WebP already within limits (spec: Source).
- Stored image at most 2 MB after encoding (spec: Size limit).
- Translucency under a background: columns 85 % opacity, cards 92 % (spec: Where it appears).
- Board export and import do not include the background; `kanban-board.v1` is unchanged (spec: Storage).
- No git repository: skip commit steps. Each task ends with a verification step.

## Review Focus

1. A URL that loads a web page instead of an image: show "This address does not load an image", keep the previous background.
2. Browser storage refuses the write (quota): do not apply the change, show a toast that the image is too large to save in this browser.
3. Stored value is corrupt JSON or has an invalid shape: treat as no background, no uncaught error.
4. A URL containing `"`, `)`, or `\`: escaped, never breaks out of `url("…")`.
5. A local image that is still over 2 MB after downscaling: rejected with a message asking for a smaller image.

Each line gets its test in the owning task.

---

### Task 1: Markup and styles

**Files:**
- Modify: `index.html` (menu item; `.board-bg` layer inside `#board-wrap`; dialog markup)
- Modify: `styles.css` (layer, fit/position rules, translucency, dialog preview)
- Test: `scratchpad/dsk/check.cjs` (new section T6)

**Interfaces:**
- Produces: element ids `board-bg-layer` (the `.board-bg` div), `btn-background` (menu item), `bg-dialog` (dialog), `bg-url`, `bg-add-url`, `bg-choose-file`, `bg-file` (hidden `input type="file" accept="image/*"`), `bg-error`, `bg-preview`, `bg-fit` (select: cover, contain, tile, original), `bg-position` (select: center, top, bottom), `bg-dim` (range 0–70, step 5), `bg-dim-value` (output), `bg-remove`, `bg-cancel`, `bg-save`.
- Produces CSS contract: `#board-wrap` gets `data-has-bg` when an image is set, `data-fit` (cover | contain | tile | original), `data-position` (center | top | bottom), and CSS property `--bg-dim` (a percentage such as `30%`). `#board-wrap` also gets `--bg-image` (a `url("…")` value).

- [ ] **Step 1: Write the failing checks**

Add section `T6` to `check.cjs`. Required assertions (regex or CSS-block based, matching the existing style):
- `index.html` contains `id="btn-background"`, `id="bg-dialog"`, and every id listed above.
- `bg-fit` options are exactly cover, contain, tile, original. `bg-position` options are exactly center, top, bottom.
- `bg-dim` has `min="0"`, `max="70"`, `step="5"`.
- `bg-file` has `accept="image/*"` and is `hidden`.
- `styles.css` has a `.board-bg` rule with `position: absolute`.
- `styles.css` has `[data-has-bg]` rules that set the column background with `85%` and the card background with `92%` inside `color-mix`.
- `styles.css` has data-attribute rules for `data-fit="contain"`, `data-fit="tile"`, `data-fit="original"`, and `data-position="top"`.

- [ ] **Step 2: Run the checks and watch them fail**

Run: `node scratchpad/dsk/check.cjs /c/code/kanban --task 6`
Expected: every T6 assertion FAIL.

- [ ] **Step 3: Add the markup**

- In `index.html`, inside `#menu-panel` after `btn-export`, add a button with `id="btn-background"` labeled "Board background…".
- Inside `#board-wrap`, before `#board`, add `<div id="board-bg-layer" class="board-bg" aria-hidden="true"></div>`.
- Add `<dialog id="bg-dialog" class="dialog">` modeled on the existing task dialog: header "Board background" with a close button, a body containing the URL row (`bg-url` with `bg-add-url`), a "Choose file…" button (`bg-choose-file`) with the hidden `bg-file`, the `bg-error` paragraph, the `bg-preview` area, the Fit, Position, and Dim controls (Dim shows its value in `bg-dim-value`), and a footer with `bg-remove`, `bg-cancel` (`data-close`), and `bg-save`. Include the one-line privacy note under the URL field: "The image host can see your IP address when the image loads."

- [ ] **Step 4: Add the styles**

- `.board-wrap > .board { position: relative; z-index: 1; }`
- `.board-bg { position: absolute; inset: 0; z-index: 0; pointer-events: none; display: none; background: linear-gradient(color-mix(in srgb, var(--bg) var(--bg-dim, 0%), transparent), color-mix(in srgb, var(--bg) var(--bg-dim, 0%), transparent)), var(--bg-image) center / cover no-repeat; }`
- `#board-wrap[data-has-bg] .board-bg { display: block; }`
- Fit rules on `#board-wrap[data-fit="contain"] .board-bg` (`background-size: contain`), `[data-fit="tile"]` (`background-size: auto; background-repeat: repeat`), `[data-fit="original"]` (`background-size: auto; background-repeat: no-repeat`).
- Position rules on `#board-wrap[data-position="top"] .board-bg` (`background-position: center top`) and `[data-position="bottom"]` (`center bottom`).
- Translucency: `#board-wrap[data-has-bg] .column { background: color-mix(in srgb, var(--column) 85%, transparent); }` and `#board-wrap[data-has-bg] .card { background: color-mix(in srgb, var(--surface) 92%, transparent); }`.
- Dialog preview: `#bg-preview` is a fixed-height box with `background-size: cover; background-position: center;` and a 1px border.

- [ ] **Step 5: Run the checks and watch them pass**

Run: `node scratchpad/dsk/check.cjs /c/code/kanban`
Expected: all previous sections still pass, and T6 passes. Then `node scratchpad/dsk/check.cjs /c/code/kanban --task 6` shows only T6 lines, all PASS.

---

### Task 2: Storage, validation, and apply

**Files:**
- Modify: `app.js` (helpers added to a new `// ---------- Background ----------` section, placed after the Theme section; `init` calls)
- Test: `scratchpad/dsk/browser6.cjs` (new Playwright script)

**Interfaces:**
- Consumes: `#board-wrap`, `#board-bg-layer` from Task 1.
- Produces in `app.js`:
  - `const BG_KEY = "kanban-board.background"`
  - `function normalizeBackground(raw)` → returns the normalized object or `null`. Accepts only `source` of `url` or `file`, a non-empty `value` string that is an allowed URL or an `data:image/` URL, `fit` in the four values (default `cover` for an unknown value), `position` in the three values (default `center`), and `dim` as a number clamped to 0–70 and rounded to a multiple of 5 (default 30). Anything else returns `null`.
  - `function cssUrl(url)` → returns `url("…")` with `\`, `"`, `(`, `)`, and newlines escaped with a backslash or `%`-encoding. The result must not contain an unescaped `"` or `)`.
  - `function getStoredBackground()` → `normalizeBackground(JSON.parse(localStorage.getItem(BG_KEY)))` inside try/catch; returns `null` on any error.
  - `function saveBackground(bg)` → returns `true` on success. On failure (storage throws) returns `false` and does not change the applied state.
  - `function clearStoredBackground()` → removes the key inside try/catch.
  - `function applyBackground(bg)` → when `bg` is `null`, removes `data-has-bg`, `data-fit`, `data-position` and resets `--bg-image`, `--bg-dim`. Otherwise sets `--bg-image` to `cssUrl(bg.value)`, `--bg-dim` to `bg.dim + "%"`, the two data attributes, and `data-has-bg`.

- [ ] **Step 1: Write the failing browser checks**

`browser6.cjs` (reuse the structure of `browser.cjs`: `chromium.launch` with the Chromium path, a `file://` page, offline routing that continues only `file:` requests and fulfills image URLs with a PNG). Assertions:
- Valid stored JSON `{"source":"url","value":"https://bg.test/a.png","fit":"contain","position":"top","dim":40}` set via `localStorage` before load: `#board-wrap` has `data-has-bg`, `data-fit="contain"`, `data-position="top"`, and `--bg-dim` is `40%`.
- Corrupt stored value `{not json`: no `data-has-bg`, no page errors.
- Stored value with `fit: "spin"`, `dim: 99`: the page loads with `data-fit="cover"` and `--bg-dim` `70%`.
- URL containing `"`, `)`, and `\`: the computed `--bg-image` value starts with `url("` and ends with `")`, and it contains no bare `"` or `)` between them.

- [ ] **Step 2: Run and watch them fail**

Run: `node scratchpad/dsk/browser6.cjs`
Expected: every assertion FAIL (no helpers yet).

- [ ] **Step 3: Implement the helpers and apply on init**

Implement the interfaces above. In `init()`, after the theme lines, call `applyBackground(getStoredBackground())`.

- [ ] **Step 4: Run and watch them pass**

Run: `node scratchpad/dsk/browser6.cjs`
Expected: all Task 2 assertions PASS. Run `node scratchpad/dsk/check.cjs /c/code/kanban` and confirm sections T1–T6 still pass.

---

### Task 3: Adding an image from a URL or a file

**Files:**
- Modify: `app.js` (`probeImage`, `readLocalImage`, `downscaleImage`)
- Test: `scratchpad/dsk/browser6.cjs` (new assertions)

**Interfaces:**
- Produces:
  - `function probeImage(url)` → `Promise<boolean>`. Creates `new Image()`, sets `src`, resolves `true` on `load`, `false` on `error`. Never sets the board background.
  - `function downscaleImage(file)` → `Promise<string>` returns a data URL. Loads the file with `createImageBitmap` or `Image` plus object URL, draws to a canvas whose longer side is at most `2560`, and exports JPEG at quality `0.85`. If the source is PNG or WebP and its longer side is already at most `2560`, returns the original as a data URL without re-encoding. Throws `Error("That file could not be read as an image.")` on decode failure.
  - `function readLocalImage(file)` → `Promise<string>`. Rejects with `Error("Choose an image file.")` when `file.type` does not start with `image/`. Calls `downscaleImage`, then rejects with `Error("This image is still larger than 2 MB. Choose a smaller image.")` when the data URL's encoded size (`dataUrl.length * 0.75`, approximate bytes) exceeds `2 * 1024 * 1024`.
- Consumes: `normalizeBackground`, `saveBackground`, `applyBackground` from Task 2.

- [ ] **Step 1: Write the failing browser checks**

In `browser6.cjs`:
- Route `https://bg.test/**` to fulfill a small valid PNG (use `scratchpad/dsk/shots/favicon.png`) with `content-type: image/png`. Open the dialog, type that URL, press the add action, wait for the preview. Expected: `#board-wrap` has `data-has-bg`, the stored value's `source` is `url`.
- Route `https://page.test/**` to fulfill `text/html`. Expected: `#bg-error` text is "This address does not load an image", and the previous background is unchanged.
- Use `input.setInputFiles` on `#bg-file` with a non-image file (for example `shots/favicon-test.html`). Expected: `#bg-error` shows "Choose an image file.", nothing saved.
- In the page, generate a 2560×2560 random-noise canvas, convert it to a JPEG blob at quality 1, wrap it in a `File` named `big.jpg` with `DataTransfer`, and set it on `#bg-file`. Expected: `#bg-error` shows the "still larger than 2 MB" message and nothing saved.
- Set `#bg-file` to `shots/favicon.png`. Expected: `source` is `file`, the stored `value` starts with `data:image/`, and the stored string is under 2 MB.

- [ ] **Step 2: Run and watch them fail**

Run: `node scratchpad/dsk/browser6.cjs`
Expected: the new Task 3 assertions FAIL.

- [ ] **Step 3: Implement**

Implement `probeImage`, `downscaleImage`, and `readLocalImage` as specified. Wire them in Task 4's dialog code; in this task, expose them only through the dialog handlers added in Task 4 (do not add buttons yet). If Task 4's handlers are not present yet, test these helpers by temporarily exposing them on `window.__bg` behind no flag, and remove that exposure at the end of Task 4.

- [ ] **Step 4: Run and watch them pass**

Run: `node scratchpad/dsk/browser6.cjs`
Expected: Task 3 assertions PASS. Confirm the Task 2 assertions still pass.

---

### Task 4: Dialog behavior, Save, Cancel, Remove, and storage failures

**Files:**
- Modify: `app.js` (dialog wiring; menu item handler; `btn-background` opens `bg-dialog`)
- Test: `scratchpad/dsk/browser6.cjs`

**Interfaces:**
- Consumes: `probeImage`, `readLocalImage`, `saveBackground`, `clearStoredBackground`, `applyBackground`, `getStoredBackground`.
- Produces: `function openBackgroundDialog()`, which copies the current state into a draft (`bgDraft`, an object with the normalized fields or `null`), syncs the controls, and calls `showModal()`.

Behavior:
- Live preview: any change to the controls calls `applyBackground(draft)` so the board updates immediately. Cancel calls `applyBackground(committed)` where `committed` is the state when the dialog opened.
- Add (`bg-add-url`): trims the URL field, rejects non-`http(s)` with the message "Use an http:// or https:// address", calls `probeImage`; on `false` shows "This address does not load an image" and keeps the draft unchanged; on `true` sets the draft to `{ source: "url", value, fit, position, dim }` keeping the current fit/position/dim values.
- Choose file (`bg-choose-file`) opens `bg-file`; on change, calls `readLocalImage`; on success sets the draft to `{ source: "file", value: dataUrl, ... }`; on error shows the error message.
- Save: calls `saveBackground(draft)`. When it returns `false`, shows the toast "The image is too large to save in this browser." and keeps the dialog open with the draft still applied. On success, closes the dialog and sets `committed = draft`.
- Remove: sets the draft to `null`, applies it, and calls `clearStoredBackground()` on Save. Closing the dialog with Remove pressed and then Save clears the stored value.
- Fit and Position selects and the Dim range write to the draft and call `applyBackground` immediately; `bg-dim-value` shows the number followed by `%`.
- Remove the temporary `window.__bg` exposure from Task 3.

- [ ] **Step 1: Write the failing browser checks**

In `browser6.cjs`:
- Menu item `btn-background` opens `#bg-dialog` (open the menu first with `#btn-menu`).
- Changing `#bg-fit` to `tile` updates `#board-wrap` `data-fit` to `tile` before saving. Cancel restores the previous `data-fit`.
- Dim slider set to 50 shows `50%` in `#bg-dim-value` and sets `--bg-dim` to `50%` on `#board-wrap`.
- Save with a valid URL: storage holds the value; reload keeps `data-has-bg`.
- Remove then Save: storage key is absent and `data-has-bg` is gone.
- Storage refusal: `page.addInitScript` replaces `Storage.prototype.setItem` so it throws when the key is `kanban-board.background`. Save with a valid URL. Expected: the toast "The image is too large to save in this browser." appears, the stored key is still absent, and the dialog stays open.
- Page errors: none in any of the above.

- [ ] **Step 2: Run and watch them fail**

Run: `node scratchpad/dsk/browser6.cjs`
Expected: the Task 4 assertions FAIL.

- [ ] **Step 3: Implement the dialog wiring**

Implement the behavior above in `app.js`, in the Background section, with the element ids from Task 1.

- [ ] **Step 4: Run and watch them pass**

Run: `node scratchpad/dsk/browser6.cjs`
Expected: all of `browser6.cjs` passes. Run `node scratchpad/dsk/check.cjs /c/code/kanban` and `node scratchpad/dsk/browser.cjs /c/code/kanban <shots dir>` (the earlier suite) and confirm they still pass.

---

### Task 5: Final verification

**Files:** none modified unless a check fails.

- [ ] **Step 1: Layout with an image set**

In `browser6.cjs`, with a valid background set, open at 390 px and at 1280 px in light and dark themes. Expected: no horizontal page scroll (`scrollWidth - clientWidth <= 0`), no page errors, and screenshots written to `scratchpad/dsk/shots/bg-*.png`. Read two screenshots (one phone, one desktop dark) and confirm the board is legible.

- [ ] **Step 2: Export and import leave the background alone**

Set a background, export JSON via `#btn-export` (capture the download), import `kanban-2026-11-05.json` replacing the board. Expected: `kanban-board.background` value unchanged; `data-has-bg` still present.

- [ ] **Step 3: Full suite**

Run `node scratchpad/dsk/check.cjs /c/code/kanban`, `node scratchpad/dsk/browser.cjs /c/code/kanban <shots dir>`, `node scratchpad/dsk/browser5.cjs`, `node scratchpad/dsk/browser6.cjs`. Expected: all pass. Report each count with its actual output.

- [ ] **Step 4: Report**

Report each check's actual output. Note in the ledger any deviation as a ruling.
