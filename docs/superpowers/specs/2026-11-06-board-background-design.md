# Board background image

Date: 2026-11-06
Status: Draft, awaiting review
Depends on: [design system and theme](2026-11-06-design-system-and-theme-design.md) (implemented)

## Goal

The user can set an image as the background of the board area, from either a web address or a file on their computer, and choose how the image is fitted and placed. The image stays readable and the board stays usable in both light and dark themes.

## Decisions

### Source

- **Web address (URL):** a text field accepts `http://` or `https://` addresses only. Other schemes (`javascript:`, `file:`, `data:` typed by hand) are rejected.
- **Local file:** a "Choose file…" button opens the browser's file picker, limited to `image/*`. The page cannot read an arbitrary path such as `C:\photos\bg.jpg` typed into a text field, so typed local paths are not supported. The file is read into the page and stored as a data URL.
- **Downscaling:** a chosen local file is drawn to a canvas, scaled so its longer side is at most 2560 px, and encoded as JPEG at quality 0.85 (PNG and WebP are kept as-is if they are already within limits). Animated GIFs keep their first frame only.
- **Size limit:** a stored image must be at most 2 MB after encoding. Larger files are rejected with a message asking for a smaller image.

### Fitting options

| Option | Values | Default | CSS |
|---|---|---|---|
| Fit | Cover, Contain, Tile, Original size | Cover | `background-size: cover / contain / auto` with `background-repeat: no-repeat / repeat` |
| Position | Center, Top, Bottom | Center | `background-position` |
| Dim | 0–70 % in steps of 5 | 30 % | overlay layer over the image |

"Original size" means the image is shown at its natural pixel size, centered (`auto`, `no-repeat`).

### Where it appears

- The background covers the board area below the top bar (`.board-wrap`).
- The top bar keeps its own surface and is not affected.
- When a background is set, the column and card surfaces become slightly translucent so the image shows through between cards: columns at 85 % opacity, cards at 92 %. Translucency is removed when no background is set, so the existing look is unchanged.
- The fade hints at the board edges keep working over the image.

### Legibility

- The dim layer is `color-mix(in srgb, var(--bg) <dim>%, transparent)` over the image, so it follows the active theme: a light veil in light mode, a dark veil in dark mode.
- Card and column text uses existing tokens. No new text colors.

### Storage

- Key: `kanban-board.background`. Value: JSON `{ "source": "url" | "file", "value": "<url or data URL>", "fit": "cover" | "contain" | "tile" | "original", "position": "center" | "top" | "bottom", "dim": 0-70 }`.
- Absent means no background.
- All reads and writes are in try/catch. If the browser refuses the write (quota exceeded), the change is not applied and a toast says the image is too large to save in this browser.
- The background is a per-browser setting. It is not part of the board export or import file, and it does not change the `kanban-board.v1` data.

### Controls

- A new menu item "Board background…" opens a dialog titled "Board background", styled like the existing dialogs.
- Dialog contents: the URL field with an "Add" action, a "Choose file…" button, a preview area, the Fit, Position, and Dim controls, and buttons Remove, Cancel, and Save.
- Preview updates live in the dialog. Cancel restores the previous background. Save persists it. Remove clears it and closes the dialog.
- URLs are checked by loading them into a hidden image first. If the image fails to load, the dialog shows "This address does not load an image" and keeps the previous background.

### Security and privacy

- A remote image is requested from its host, so the host learns the viewer's IP address and that the page was opened. The dialog says so in one line under the URL field. Only `http` and `https` are allowed.
- Values are never concatenated into CSS text unsanitized. The URL is normalized with `new URL()`, and any `"`, `\`, `(`, `)`, or newline characters are escaped before it is placed in `url("…")`. The value is set through `style.setProperty`, not `innerHTML`.
- Local files are accepted only when their MIME type starts with `image/`.

## Changes by file

- `index.html`: a `<div class="board-bg" aria-hidden="true">` inside `.board-wrap`, a menu item "Board background…", and the "Board background" dialog markup.
- `styles.css`: `.board-bg` (absolute, fills `.board-wrap`, behind `.board`), the translucent surface rules under `.board-wrap[data-has-bg]`, and dialog preview styles. Fit and position map to classes, not inline styles.
- `app.js`: read, validate, downscale, store, apply, and clear the background; wire the dialog; apply on init.

## Out of scope

- Per-status or per-column backgrounds.
- Backgrounds stored in the board export.
- Video or animated backgrounds.
- Self-hosting the font (a separate decision, flagged earlier).

## Testing and verification

- Static checks: the new storage key, the escaping function, the `image/` MIME check, the `http`/`https`-only URL check, and that no `innerHTML` receives user input.
- Browser checks:
  - A URL to a local test image sets the background; a bad URL shows the message and keeps the previous state.
  - Choosing a local file via the file input sets the background, and the stored value is a `data:image/` URL no larger than 2 MB.
  - Each Fit and Position option produces the expected computed `background-size`, `background-repeat`, and `background-position`.
  - Dim changes the overlay alpha and is correct in both themes.
  - Remove clears the background and the translucency.
  - Export and import leave the background setting untouched.
  - Phone and desktop layouts show no horizontal page scroll with an image set.

## Open points for review

1. **Local files** are chosen with a file picker, not by typing a path. Confirm this is acceptable.
2. **Remote images** send the viewer's IP address to the image host. The dialog states this. Confirm the notice is enough.
3. **Background stays per browser** and is not included in export or import. Confirm.
