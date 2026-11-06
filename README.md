# Kanban Board

A kanban board that runs from a single HTML file. There is no server and no install. Data stays in the browser, and you share it as a JSON file.

## Build

```
node build.js
```

This writes `public/index.html`, a single file with the styles, scripts, and icon inlined. Nothing else is copied to `public/`. Edit the source files (`index.html`, `styles.css`, `app.js`, `js/`), never `public/index.html`.

Unit tests: `node --test`.

## Sharing a board

1. Send `public/index.html` with an exported JSON file (menu → **Export JSON**).
2. The receiver opens `index.html` in a browser and clicks **Import JSON…**. On a fresh start, the file's projects take the place of the empty starter project. Then they pick their name in the worker filter.
3. To share changes, send an updated JSON export. The other person imports it and chooses **Update**. This overwrites their copy of each project in the file and adds any projects that are new. The app does not merge or compare changes, so agree on edits first, or compare the JSON files with a diff tool before importing. Every import can be undone right after.

### Background images

A background is saved in the JSON by name only, never the image itself:

- **A web address** loads from the web, for everyone.
- **A picked file** is saved by its file name, for example `orange.jpeg`, and the browser that picked it keeps its own copy. Anyone else needs the file next to `index.html`, or in an `img` folder beside it.
- **A file name typed in the address field** (for example `img/orange.jpeg`) is looked up relative to `index.html`.

If the image file is missing, the board shows no background. Nothing else changes.
