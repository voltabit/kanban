// Builds the shareable app: public/index.html with the styles, scripts, and icon inlined, so the
// whole app is one file. Background images are not copied; share them separately if needed.
// Run with: node build.js
"use strict";

const fs = require("fs");
const path = require("path");

const root = __dirname;
const out = path.join(root, "public");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

let html = read("index.html");

// Replaces exactly one occurrence, so a changed tag in index.html fails the build instead of being skipped.
function inline(pattern, replacement) {
  const matches = html.match(new RegExp(pattern.source, "g")) || [];
  if (matches.length !== 1) throw new Error(`Expected one match for ${pattern}, found ${matches.length}.`);
  html = html.replace(pattern, () => replacement);
}

// Text inside <script> or <style> must not contain its own closing tag.
const guard = (text, tag) => text.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");

inline(/<link rel="stylesheet" href="styles\.css">/, `<style>\n${guard(read("styles.css"), "style")}</style>`);

const icon = Buffer.from(read("favicon.svg")).toString("base64");
inline(/<link rel="icon" href="favicon\.svg" type="image\/svg\+xml">/,
  `<link rel="icon" href="data:image/svg+xml;base64,${icon}" type="image/svg+xml">`);

for (const file of ["js/model.js", "js/storage.js", "app.js"]) {
  const tag = new RegExp(`<script src="${file.replace(/[.]/g, "\\.")}"></script>`);
  inline(tag, `<script>\n${guard(read(file), "script")}</script>`);
}

// Anything still pointing at a local file would break once index.html is shared on its own.
const leftover = html.match(/<(?:script|link)\b[^>]*\b(?:src|href)="(?!https?:|data:|#)[^"]*"/g);
if (leftover) throw new Error(`Local file references left in the page: ${leftover.join(", ")}`);

const { APP_VERSION } = require("./js/model.js");
html = html.replace("<!doctype html>", `<!doctype html>\n<!-- Kanban Board v${APP_VERSION}. Built by build.js from the source files: edit those, not this file. -->`);

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), html);

console.log(`Built public/index.html (v${APP_VERSION}, ${Math.round(html.length / 1024)} KB)`);
