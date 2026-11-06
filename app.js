// UI for the board. Data rules live in js/model.js (window.KanbanModel); storage in js/storage.js (window.KanbanStorage).
(function () {
  "use strict";

  const M = window.KanbanModel;
  const S = window.KanbanStorage;
  const { PRIORITIES, PALETTE, uid, clone, esc, isHttpUrl, slugify, uniqueId } = M;

  // ---------- State ----------
  // workspace holds every project and the shared workers list; board is the open project (one of workspace.projects).
  let workspace = { activeProjectId: null, workers: [], projects: [] };
  let board = { id: null, name: "", statuses: [], tasks: [] };
  let workerFilter = "";      // "" (all), UNASSIGNED, or a worker name
  let removeLegacyAfterSave = false;   // the old single-board data is deleted once the workspace is saved
  // Worker names are trimmed, so a value starting with a space can never clash with a real name.
  const UNASSIGNED = " unassigned";
  let draft = null;           // task being edited in the task dialog
  let draftSnapshot = "";     // task form state when the dialog opened, to detect unsaved changes
  let statusDraft = [];       // working copy of statuses in the status dialog
  let statusSnapshot = "";
  let pendingImport = null;   // parsed import waiting for the add/replace choice
  let dragId = null;          // id of the card being dragged
  let toastTimer = null;
  let undoAction = null;      // { run } for the last delete or import; cleared by the next change
  let saveLocked = false;     // true when unreadable data could not be backed up

  // ---------- Helpers ----------
  const $ = (id) => document.getElementById(id);

  // Inline icon from the sprite in index.html. id is a symbol id such as "i-plus".
  const icon = (id, extraClass = "") =>
    `<svg class="icon ${extraClass}" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const formatDate = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  };

  const formatDateTime = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  };

  const isTyping = (el) =>
    !!el && (el.matches("input, textarea, select") || el.isContentEditable);

  // Shows a message at the bottom. action: { label, run } adds a button (for Undo); Ctrl+Z runs it too.
  function toast(message, kind = "info", action = null) {
    const el = $("toast");
    const btn = $("toast-action");
    $("toast-text").textContent = message;
    el.className = `toast show ${kind}${action ? " has-action" : ""}`;
    btn.classList.toggle("hidden", !action);
    if (action) {
      btn.textContent = action.label;
      undoAction = action;
    }
    clearTimeout(toastTimer);
    const ms = action ? 8000 : kind === "error" ? 7000 : 3500;
    toastTimer = setTimeout(hideToast, ms);
  }

  function hideToast() {
    $("toast").classList.remove("show", "has-action");
  }

  function runUndo() {
    if (!undoAction) return;
    const action = undoAction;
    undoAction = null;
    hideToast();
    action.run();
  }

  $("toast-action").addEventListener("click", runUndo);

  // Inline field errors: text under the field, linked through aria-describedby in the markup.
  function setFieldError(inputId, errorId, message) {
    $(errorId).textContent = message || "";
    if (message) $(inputId).setAttribute("aria-invalid", "true");
    else $(inputId).removeAttribute("aria-invalid");
  }

  // ---------- Confirmation dialog ----------
  // Resolves true when the user picks the confirm button.
  function confirmAction({ title, message, ok, cancel = "Cancel" }) {
    const dialog = $("confirm-dialog");
    $("confirm-title").textContent = title;
    $("confirm-message").textContent = message;
    $("confirm-ok").textContent = ok;
    $("confirm-cancel").textContent = cancel;
    dialog.showModal();
    $("confirm-cancel").focus();   // the safe choice is the default
    // Resolve from submit/cancel, which fire synchronously. The "close" event is queued, so a stale one
    // from a previous prompt could otherwise answer a prompt that was reopened quickly.
    const form = dialog.querySelector("form");
    return new Promise((resolve) => {
      const finish = (ok) => {
        form.removeEventListener("submit", onSubmit);
        dialog.removeEventListener("cancel", onCancel);
        resolve(ok);
      };
      const onSubmit = (e) => finish(!!e.submitter && e.submitter.value === "ok");
      const onCancel = () => finish(false);
      form.addEventListener("submit", onSubmit);
      dialog.addEventListener("cancel", onCancel);
    });
  }

  // Dialogs with unsaved-change checks. Closing through Cancel, the X button, or Escape asks first.
  const closeGuards = new Map();   // dialog element -> { isDirty, message }

  async function requestClose(dialog) {
    const guard = closeGuards.get(dialog);
    if (guard && guard.isDirty()) {
      const discard = await confirmAction({
        title: "Discard changes?",
        message: guard.message,
        ok: "Discard",
        cancel: "Keep editing",
      });
      if (!discard) return;
    }
    dialog.close();
  }

  function guardClose(dialog, isDirty, message) {
    closeGuards.set(dialog, { isDirty, message });
    dialog.addEventListener("cancel", (e) => {
      if (isDirty()) {
        e.preventDefault();
        requestClose(dialog);
      }
    });
  }

  document.querySelectorAll("[data-close]").forEach((btn) =>
    btn.addEventListener("click", () => requestClose(btn.closest("dialog"))));

  // ---------- Saving ----------
  // Saves and re-renders. Returns true only when the board was written to storage,
  // so callers show a success message only for changes that will survive a reload.
  function commit() {
    undoAction = null;   // an older undo would overwrite this change
    render();
    if (saveLocked) {
      toast("Changes are not saved: the stored board could not be backed up. Export your data to keep it.", "error");
      return false;
    }
    const result = S.saveWorkspace(workspace);
    if (!result.ok) {
      toast(result.message, "error");
      return false;
    }
    if (removeLegacyAfterSave) {
      S.removeLegacyBoard();
      removeLegacyAfterSave = false;
    }
    return true;
  }

  const projectById = (id) => workspace.projects.find((p) => p.id === id);

  // Makes a project the open one (falls back to the first project).
  function setActiveProject(id) {
    board = projectById(id) || workspace.projects[0];
    workspace.activeProjectId = board.id;
  }

  // ---------- Other tabs ----------
  // Another tab saved: load its version so this tab does not overwrite it with stale data.
  // This tab keeps showing its own project when it still exists.
  function reloadFromOtherTab() {
    const loaded = S.loadWorkspace();
    if (loaded.unreadableKeptAs || loaded.saveLocked) return;   // leave our copy alone
    const openId = board.id;
    workspace = loaded.workspace;
    setActiveProject(projectById(openId) ? openId : workspace.activeProjectId);
    undoAction = null;
    render();
    const editing = $("task-dialog").open || $("status-dialog").open;
    toast(editing
      ? "The board was changed in another tab. Saving now applies your edits on top of those changes."
      : "The board was updated in another tab.");
  }

  window.addEventListener("storage", (e) => {
    if (e.key === S.STORAGE_KEY || e.key === null) reloadFromOtherTab();
    if (e.key === S.THEME_KEY || e.key === null) {
      const theme = S.getStoredTheme();
      applyTheme(theme);
      $("theme-select").value = theme;
    }
  });


  // ---------- Theme ----------
  // "system" follows the OS (no data-theme attribute).
  function applyTheme(value) {
    if (value === "light" || value === "dark") document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
  }

  function setTheme(value) {
    const next = value === "light" || value === "dark" ? value : "system";
    S.saveTheme(next);
    applyTheme(next);
  }

  // ---------- Background ----------
  // Wraps a URL as a CSS url("…") token, escaping the characters that could end the string early.
  function cssUrl(url) {
    const escaped = String(url).replace(/[\\"()\r\n]/g, (c) => ({
      "\\": "\\\\", '"': '\\"', "(": "\\(", ")": "\\)", "\r": "%0D", "\n": "%0A",
    })[c]);
    return `url("${escaped}")`;
  }

  const BG_MAX_SIDE = 2560;                 // longer side, in pixels
  const BG_MAX_BYTES = 2 * 1024 * 1024;     // stored image, after encoding

  // Resolves true when the address loads as an image, false otherwise (a web page, a 404, a network error).
  function probeImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // Returns a data URL no larger than BG_MAX_SIDE on its longer side. PNG and WebP within the limit are kept as-is;
  // everything else is redrawn and encoded as JPEG at quality 0.85.
  async function downscaleImage(file) {
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("That file could not be read as an image."));
        el.src = objectUrl;
      });
      // An image with no intrinsic size (for example an SVG without width, height, or viewBox) cannot be drawn.
      if (!img.naturalWidth || !img.naturalHeight) {
        throw new Error("That file could not be read as an image.");
      }
      const longest = Math.max(img.naturalWidth, img.naturalHeight);
      if ((file.type === "image/png" || file.type === "image/webp") && longest <= BG_MAX_SIDE) {
        return await readAsDataUrl(file);
      }
      const scale = Math.min(1, BG_MAX_SIDE / longest);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.85);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  // Validates a chosen file and returns its stored data URL, or throws with a message for the dialog.
  async function readLocalImage(file) {
    if (!file || !String(file.type).startsWith("image/")) throw new Error("Choose an image file.");
    const dataUrl = await downscaleImage(file);
    const bytes = Math.round(dataUrl.length * 0.75);   // approximate decoded size of the base64 payload
    if (bytes > BG_MAX_BYTES) throw new Error("This image is still larger than 2 MB. Choose a smaller image.");
    return dataUrl;
  }

  // Paints one .bg-canvas element (the board layer or the dialog preview). src is the image to show,
  // or null for none (no background, or its file is missing).
  function paintCanvas(el, bg, src) {
    if (!bg || !src) {
      el.removeAttribute("data-fit");
      el.removeAttribute("data-position");
      el.style.removeProperty("--bg-image");
      el.style.removeProperty("--bg-dim");
      return;
    }
    el.style.setProperty("--bg-image", cssUrl(src));
    el.style.setProperty("--bg-dim", `${bg.dim}%`);
    el.dataset.fit = bg.fit;
    el.dataset.position = bg.position;
  }

  // ---------- Background images ----------
  // A background names its image by web address or by file name (see M.normalizeBackground). A file name
  // is looked up in the copy kept in this browser when the image was picked here, then next to index.html
  // (and, for a bare name, in the img folder beside it). An image found nowhere shows no background.
  const imageSources = new Map();   // image → Promise of its source; only images that were found stay here

  const relativeUrl = (path) => path.split("/").map(encodeURIComponent).join("/");

  async function findImage(image) {
    if (M.isHttpUrl(image)) return image;
    const kept = await S.getImage(image);
    if (kept) return kept;
    for (const path of image.includes("/") ? [image] : [image, `img/${image}`]) {
      const url = relativeUrl(path);
      if (await probeImage(url)) return url;
    }
    return null;
  }

  function resolveImage(image) {
    if (!imageSources.has(image)) {
      const found = findImage(image);
      imageSources.set(image, found);
      found.then((src) => { if (!src && imageSources.get(image) === found) imageSources.delete(image); });
    }
    return imageSources.get(image);
  }

  // Applies a background (or null for none) to the board and to the dialog preview.
  // A draft that was just picked carries its image as `preview` until it is saved.
  let paintRequest = 0;
  function applyBackground(bg) {
    const request = ++paintRequest;
    const paint = (src) => {
      if (request !== paintRequest) return;   // a newer background was applied meanwhile
      $("board-wrap").toggleAttribute("data-has-bg", !!(bg && src));
      paintCanvas($("board-bg-layer"), bg, src);
      paintCanvas($("bg-preview"), bg, src);
    };
    if (!bg) paint(null);
    else if (bg.preview) paint(bg.preview);
    else resolveImage(bg.image).then(paint, () => paint(null));
  }

  // ---------- Background state ----------
  // Backgrounds are part of the workspace: board.background is the open project's own, and
  // workspace.background the one for every project. A project's own background takes precedence.
  const bgCommitted = () => board.background || workspace.background || null;
  let bgShown;   // JSON of the background last applied by showCommittedBackground

  // Shows the committed background unless the dialog is previewing a draft. Called by every render.
  function showCommittedBackground(force = false) {
    if ($("bg-dialog").open) return;
    const key = JSON.stringify(bgCommitted());
    if (!force && key === bgShown) return;
    bgShown = key;
    applyBackground(bgCommitted());
  }

  // Kept images have no change event, so tabs tell each other when one is replaced.
  let channel = null;
  try {
    channel = new BroadcastChannel("kanban-board");
    channel.addEventListener("message", (e) => {
      if (!e.data || e.data.type !== "image") return;
      imageSources.delete(e.data.name);
      showCommittedBackground(true);
    });
  } catch (err) {
    /* BroadcastChannel unavailable: other tabs pick the change up on reload */
  }

  // ---------- Background dialog ----------
  // bgDraft is the value being edited; the board previews it live. Closing without Save restores bgCommitted().
  let bgDraft = null;
  let bgRequest = 0;   // bumped by every new address or file, and by opening, closing, and removing; stale results are dropped

  function updateBgScopeHint() {
    $("bg-scope-hint").textContent = $("bg-all").checked
      ? "A project with its own background keeps it."
      : `Only for “${board.name}”.`;
  }
  $("bg-all").addEventListener("change", updateBgScopeHint);

  // How the chosen image travels with an exported JSON file.
  function updateBgShareNote() {
    const note = $("bg-share-note");
    const image = bgDraft && bgDraft.image;
    note.hidden = !image || M.isHttpUrl(image);
    if (!note.hidden) {
      note.textContent = `Exported files name this image “${image}”. To share it, put the file ` +
        (image.includes("/") ? "at that path beside index.html." : "next to index.html or in its img folder.");
    }
  }

  const bgDraftFromControls = () => ({
    fit: $("bg-fit").value,
    position: $("bg-position").value,
    dim: Number($("bg-dim").value),
  });

  function setBgError(message) {
    $("bg-error").textContent = message || "";
  }

  function setBgDraft(value) {
    bgDraft = value;
    applyBackground(bgDraft);
    updateBgShareNote();
  }

  function syncBgControls(bg) {
    const values = bg || { fit: "cover", position: "center", dim: 30 };
    $("bg-fit").value = values.fit;
    $("bg-position").value = values.position;
    $("bg-dim").value = String(values.dim);
    $("bg-dim-value").textContent = `${values.dim}%`;
  }

  function openBackgroundDialog() {
    bgRequest++;
    const current = bgCommitted();
    // Checked when the board shows the background for every project (this project has none of its own).
    $("bg-all").checked = !board.background && !!workspace.background;
    updateBgScopeHint();
    $("bg-url").value = "";
    setBgError("");
    syncBgControls(current);
    setBgDraft(current ? { ...current } : null);
    $("bg-dialog").showModal();
  }

  $("btn-background").addEventListener("click", openBackgroundDialog);

  // Fit, Position, and Dim change the draft (when there is one) and preview at once.
  $("bg-fit").addEventListener("change", () => {
    if (!bgDraft) return;
    bgDraft.fit = $("bg-fit").value;
    applyBackground(bgDraft);
  });
  $("bg-position").addEventListener("change", () => {
    if (!bgDraft) return;
    bgDraft.position = $("bg-position").value;
    applyBackground(bgDraft);
  });
  $("bg-dim").addEventListener("input", () => {
    $("bg-dim-value").textContent = `${$("bg-dim").value}%`;
    if (!bgDraft) return;
    bgDraft.dim = Number($("bg-dim").value);
    applyBackground(bgDraft);
  });

  // An http(s) address, or the path of an image file beside index.html.
  $("bg-add-url").addEventListener("click", async () => {
    const value = $("bg-url").value.trim();
    setBgError("");
    const isUrl = M.isHttpUrl(value);
    if (!isUrl && !M.isImagePath(value)) {
      setBgError("Use an http:// or https:// address, or an image file name such as img/photo.jpg");
      return;
    }
    const request = ++bgRequest;
    const src = isUrl ? ((await probeImage(value)) ? value : null) : await findImage(value);
    if (request !== bgRequest || !$("bg-dialog").open) return;   // superseded, or the dialog closed meanwhile
    if (!src) {
      setBgError(isUrl ? "This address does not load an image" : "No image file by that name next to index.html");
      return;
    }
    setBgDraft({ ...bgDraftFromControls(), image: value });
  });

  $("bg-choose-file").addEventListener("click", () => $("bg-file").click());

  $("bg-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";   // allow choosing the same file again
    if (!file) return;
    setBgError("");
    const request = ++bgRequest;
    try {
      const dataUrl = await readLocalImage(file);
      if (request !== bgRequest || !$("bg-dialog").open) return;
      setBgDraft({ ...bgDraftFromControls(), image: M.imageFileName(file.name), preview: dataUrl });
    } catch (err) {
      if (request !== bgRequest || !$("bg-dialog").open) return;
      setBgError(err.message);
    }
  });

  // Removes the background the checkbox points at: with "every project" checked, the one for every
  // project (and this project's own); otherwise only this project's own, so the one for every project
  // shows through if there is one.
  function removeBackground(forAll) {
    if (!bgCommitted()) return;
    delete board.background;
    if (forAll) delete workspace.background;
    if (commit() && !forAll && workspace.background) toast("This project now shows the background for every project.");
  }

  $("bg-remove").addEventListener("click", () => {
    bgRequest++;
    bgDraft = null;
    setBgError("");
    const forAll = $("bg-all").checked;
    $("bg-dialog").close();
    removeBackground(forAll);
  });

  // Saves the draft for this project, or for every project when the checkbox is checked. Saving for every
  // project also drops this project's own background, so this project shows the new one too;
  // other projects with their own background keep it. A picked image is kept in this browser first.
  $("bg-save").addEventListener("click", async () => {
    const forAll = $("bg-all").checked;
    if (!bgDraft) {
      $("bg-dialog").close();
      removeBackground(forAll);
      return;
    }
    const { preview, ...value } = bgDraft;
    const targetBoard = board;
    if (preview) {
      const saveBtn = $("bg-save");
      saveBtn.disabled = true;
      const ok = await S.saveImage(value.image, preview);
      saveBtn.disabled = false;
      if (!ok) {
        const message = "The image is too large to save in this browser.";
        if ($("bg-dialog").open) setBgError(message);   // inside the dialog, where the user is looking
        toast(message, "error");
        return;   // keep the dialog open with the draft still shown
      }
      imageSources.set(value.image, Promise.resolve(preview));
      if (channel) channel.postMessage({ type: "image", name: value.image });
    }
    if (forAll) {
      workspace.background = value;
      delete targetBoard.background;
    } else {
      targetBoard.background = value;
    }
    bgDraft = null;
    if ($("bg-dialog").open) $("bg-dialog").close();   // the close handler shows the committed background
    commit();
  });

  // Any way of closing without Save (Cancel, the close button, Escape) restores what was committed.
  $("bg-dialog").addEventListener("close", () => {
    bgRequest++;   // anything still loading must not reach the board now
    bgDraft = null;
    showCommittedBackground(true);
  });

  // ---------- Rendering ----------
  const statusById = (id) => board.statuses.find((s) => s.id === id);

  function currentFilters() {
    const query = $("search").value.trim().toLowerCase();
    const priority = $("priority-filter").value;
    return { query, priority, worker: workerFilter, active: !!(query || priority || workerFilter) };
  }

  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

  function matchesWorker(task, worker) {
    if (!worker) return true;
    if (worker === UNASSIGNED) return !task.assignedTo;
    return !!task.assignedTo && sameName(task.assignedTo, worker);
  }

  // The worker a new task starts with: the one picked in the toolbar filter, if any.
  const defaultAssignee = () => (workerFilter && workerFilter !== UNASSIGNED ? workerFilter : "");

  // Toolbar filter options and the "Assigned to" suggestions, from the shared workers list.
  function renderWorkerOptions() {
    if (workerFilter && workerFilter !== UNASSIGNED && !workspace.workers.some((w) => sameName(w, workerFilter))) {
      setWorkerFilter("");   // the worker was removed (here or in another tab)
    }
    const select = $("worker-filter");
    select.innerHTML =
      `<option value="">All workers</option>` +
      workspace.workers.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join("") +
      `<option value="${UNASSIGNED}">Unassigned</option>`;
    const current = workspace.workers.find((w) => workerFilter && sameName(w, workerFilter));
    select.value = workerFilter === UNASSIGNED ? UNASSIGNED : current || "";
  }

  // ---------- "Assigned to" dropdown ----------
  // A combobox: the arrow (or Alt+Down) lists every worker; typing filters the list and offers the typed
  // name as a new worker. Arrow keys move, Enter picks, Escape closes the list (not the dialog).
  const combo = { input: $("f-assigned"), toggle: $("f-assigned-toggle"), list: $("f-assigned-list"), items: [], active: -1 };

  const comboOpen = () => !combo.list.hidden;

  function closeCombo() {
    combo.list.hidden = true;
    combo.input.setAttribute("aria-expanded", "false");
    combo.toggle.setAttribute("aria-expanded", "false");
    combo.input.removeAttribute("aria-activedescendant");
    combo.active = -1;
  }

  function setComboActive(index) {
    const options = combo.list.querySelectorAll("[role=option]");
    options.forEach((el, i) => el.classList.toggle("active", i === index));
    combo.active = index;
    if (index < 0) {
      combo.input.removeAttribute("aria-activedescendant");
      return;
    }
    combo.input.setAttribute("aria-activedescendant", options[index].id);
    options[index].scrollIntoView({ block: "nearest" });
  }

  // showAll: list every worker (the arrow button); otherwise filter by what is typed.
  function openCombo(showAll) {
    const typed = combo.input.value.trim();
    const query = showAll ? "" : typed.toLowerCase();
    const workers = workspace.workers.filter((w) => !query || w.toLowerCase().includes(query));
    const exact = typed && workspace.workers.some((w) => sameName(w, typed));
    combo.items = workers.map((w) => ({ value: w, isNew: false }));
    if (typed && !exact && !showAll) combo.items.push({ value: typed, isNew: true });

    combo.list.innerHTML = combo.items.length
      ? combo.items.map((item, i) => {
          const selected = !item.isNew && sameName(item.value, typed);
          return item.isNew
            ? `<li id="f-assigned-opt-${i}" role="option" class="combo-option combo-new" aria-selected="false" data-index="${i}">
                 <svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>New worker: “${esc(item.value)}”</li>`
            : `<li id="f-assigned-opt-${i}" role="option" class="combo-option" aria-selected="${selected}" data-index="${i}">
                 <svg class="icon" aria-hidden="true"><use href="#i-user"/></svg>${esc(item.value)}${
                   selected ? `<svg class="icon combo-check" aria-hidden="true"><use href="#i-check"/></svg>` : ""}</li>`;
        }).join("")
      : `<li class="combo-empty" role="presentation">No saved workers yet. Type a name to add one.</li>`;

    combo.list.hidden = false;
    combo.input.setAttribute("aria-expanded", "true");
    combo.toggle.setAttribute("aria-expanded", "true");
    const current = combo.items.findIndex((item) => !item.isNew && sameName(item.value, typed));
    setComboActive(showAll ? current : -1);
  }

  function pickCombo(index) {
    const item = combo.items[index];
    if (!item) return;
    combo.input.value = item.value;
    closeCombo();
    combo.input.focus();
  }

  combo.input.addEventListener("input", () => openCombo(false));
  combo.input.addEventListener("blur", () => closeCombo());

  combo.toggle.addEventListener("mousedown", (e) => e.preventDefault());   // keep focus in the input
  combo.toggle.addEventListener("click", () => {
    if (comboOpen()) closeCombo();
    else openCombo(true);
    combo.input.focus();
  });

  combo.list.addEventListener("mousedown", (e) => e.preventDefault());   // a click must not blur the input first
  combo.list.addEventListener("click", (e) => {
    const option = e.target.closest("[role=option]");
    if (option) pickCombo(Number(option.dataset.index));
  });

  combo.input.addEventListener("keydown", (e) => {
    const count = combo.items.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!comboOpen()) openCombo(true);
      else if (count) setComboActive((combo.active + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!comboOpen()) openCombo(true);
      else if (count) setComboActive(combo.active <= 0 ? count - 1 : combo.active - 1);
    } else if (e.key === "Enter" && comboOpen() && combo.active >= 0) {
      e.preventDefault();   // pick the option instead of saving the task
      pickCombo(combo.active);
    } else if (e.key === "Escape" && comboOpen()) {
      e.preventDefault();   // close the list only; the dialog stays open
      e.stopPropagation();
      closeCombo();
    } else if (e.key === "Tab") {
      closeCombo();
    }
  });

  function setWorkerFilter(value) {
    workerFilter = value || "";
    S.saveWorkerFilter(workerFilter);
  }

  function renderProjectName() {
    $("project-name-text").textContent = board.name;
    document.title = `${board.name} · Kanban`;
  }

  // "Today" -> "today", "In 3 days" -> "in 3 days"; dates such as "Nov 20" keep their capital.
  const lowerFirst = (s) => (/^[A-Z][a-z]{2} \d/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

  function renderDue(task, isDone) {
    if (!task.dueDate) return "";
    const state = M.dueState(task.dueDate, isDone);
    const rel = lowerFirst(M.relativeDue(task.dueDate));
    const iconId = state === "overdue" ? "i-alert" : state === "soon" ? "i-clock" : "i-calendar";
    const text = state === "overdue" ? `Overdue · ${rel}` : `Due ${rel}`;
    return `<span class="due ${state}" title="Due ${esc(formatDate(task.dueDate))}">${icon(iconId, "icon-sm")}${esc(text)}</span>`;
  }

  function renderCard(task, status, columnIndex) {
    const isDone = !!(status && status.done);
    const due = renderDue(task, isDone);
    const assignee = task.assignedTo ? `<span>${icon("i-user", "icon-sm")}${esc(task.assignedTo)}</span>` : "";
    const nAtt = task.attachments.length;
    const nCom = task.comments.length;
    const attachments = nAtt
      ? `<span title="${plural(nAtt, "attachment")}">${icon("i-paperclip", "icon-sm")}${nAtt}<span class="sr-only"> ${nAtt === 1 ? "attachment" : "attachments"}</span></span>`
      : "";
    const comments = nCom
      ? `<span title="${plural(nCom, "comment")}">${icon("i-message", "icon-sm")}${nCom}<span class="sr-only"> ${nCom === 1 ? "comment" : "comments"}</span></span>`
      : "";
    // Only priorities that need attention get a badge; Low and Medium stay quiet.
    const showPriority = task.priority === "High" || task.priority === "Critical";
    const priority = showPriority
      ? `<span class="priority p-${task.priority.toLowerCase()}">${icon("i-flag", "icon-sm")}${esc(task.priority)}</span>`
      : "";
    const last = board.statuses.length - 1;
    const title = esc(task.title);

    return `
      <article class="card${isDone ? " is-done" : ""}" draggable="true" data-id="${esc(task.id)}">
        ${priority}
        <h3><button type="button" class="card-open" aria-describedby="card-help">${isDone ? icon("i-check", "icon-sm done-mark") : ""}${title}</button></h3>
        ${due || assignee ? `<div class="card-meta">${due}${assignee}</div>` : ""}
        ${attachments || comments ? `<div class="card-foot">${attachments}${comments}</div>` : ""}
        <div class="card-move">
          <button type="button" class="icon-btn" data-move-card="-1" ${columnIndex === 0 ? "disabled" : ""} aria-label="Move ${title} to the previous column">${icon("i-left")}</button>
          <button type="button" class="icon-btn" data-move-card="1" ${columnIndex === last ? "disabled" : ""} aria-label="Move ${title} to the next column">${icon("i-right")}</button>
        </div>
      </article>`;
  }

  function renderColumn(status, index, shown, total, filtered, firstRun) {
    const cards = shown.map((t) => renderCard(t, status, index)).join("");
    const countText = filtered ? `${shown.length} of ${total}` : String(total);
    const countLabel = filtered ? `${shown.length} of ${plural(total, "task")} shown` : plural(total, "task");
    let empty = "No tasks";
    if (filtered && total > 0) empty = "No matching tasks";
    else if (firstRun) empty = "No tasks yet. Press + or use “Add task” below. Press ? for help.";
    return `
      <section class="column" data-status="${esc(status.id)}" aria-labelledby="col-${esc(status.id)}">
        <header class="column-head">
          <span class="swatch" style="background:${esc(status.color)}"></span>
          <h2 id="col-${esc(status.id)}">${esc(status.name)}</h2>
          ${status.done ? `<span class="done-tag">${icon("i-check", "icon-sm")}Completed</span>` : ""}
          <span class="count" aria-label="${countLabel}">${countText}</span>
        </header>
        <div class="column-body">
          ${cards || `<p class="empty">${empty}</p>`}
        </div>
        <button type="button" class="add-in-column" data-add-status="${esc(status.id)}">${icon("i-plus", "icon-sm")}Add task<span class="sr-only"> to ${esc(status.name)}</span></button>
      </section>`;
  }

  function render() {
    renderProjectName();
    showCommittedBackground();
    // Fresh start: invite the user to import a shared board.
    const only = workspace.projects[0];
    $("welcome").hidden = !(workspace.projects.length === 1 && !only.tasks.length && !workspace.workers.length &&
      only.name === M.DEFAULT_PROJECT_NAME);
    renderWorkerOptions();
    const { query, priority, worker, active } = currentFilters();
    const matches = (t) =>
      (!priority || t.priority === priority) &&
      matchesWorker(t, worker) &&
      (!query || [t.title, t.description, t.assignedTo].some((v) => v.toLowerCase().includes(query)));

    const firstRun = board.tasks.length === 0;
    $("board").innerHTML = board.statuses
      .map((s, i) => {
        const all = board.tasks.filter((t) => t.status === s.id);
        return renderColumn(s, i, all.filter(matches), all.length, active, firstRun && i === 0);
      })
      .join("");

    $("btn-clear-filters").classList.toggle("hidden", !active);
    $("btn-add-task").title = `New task in ${board.statuses[0].name} (shortcut: +)`;
    updateBoardHint();
  }

  // ---------- Horizontal scroll hint ----------
  // Shows a fade and a small button on each side when columns are hidden there.
  function updateBoardHint() {
    const el = $("board");
    const hiddenRight = el.scrollWidth - el.clientWidth - el.scrollLeft;
    const hiddenLeft = el.scrollLeft;
    const wrap = $("board-wrap");
    wrap.classList.toggle("has-more-right", hiddenRight > 4);
    wrap.classList.toggle("has-more-left", hiddenLeft > 4);
  }

  // One column plus the gap between columns, read from the layout.
  function columnStep() {
    const el = $("board");
    const column = el.querySelector(".column");
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    return column ? column.getBoundingClientRect().width + gap : 300;
  }

  $("board").addEventListener("scroll", updateBoardHint, { passive: true });
  window.addEventListener("resize", updateBoardHint);
  $("board-more").addEventListener("click", () => $("board").scrollBy({ left: columnStep(), behavior: "smooth" }));
  $("board-more-left").addEventListener("click", () => $("board").scrollBy({ left: -columnStep(), behavior: "smooth" }));

  // ---------- Filters ----------
  $("search").addEventListener("input", render);
  $("priority-filter").addEventListener("change", render);
  $("worker-filter").addEventListener("change", () => {
    setWorkerFilter($("worker-filter").value);
    render();
  });
  $("btn-clear-filters").addEventListener("click", () => {
    $("search").value = "";
    $("priority-filter").value = "";
    setWorkerFilter("");
    render();
    $("search").focus();
  });

  // ---------- Task dialog ----------
  function renderDraftLists() {
    $("f-attachments").innerHTML =
      draft.attachments
        .map((url, i) => `
          <div class="list-row">
            ${isHttpUrl(url)
              ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`
              : `<span class="bad-url">${esc(url)} (not a valid http/https URL)</span>`}
            <button type="button" class="icon-btn" data-remove-attachment="${i}" aria-label="Remove attachment ${esc(url)}">${icon("i-x")}</button>
          </div>`)
        .join("") || '<p class="empty">No attachments</p>';

    $("f-comments").innerHTML =
      draft.comments
        .map((c, i) => `
          <div class="comment">
            <div class="comment-head">
              <time datetime="${esc(c.createdAt)}">${esc(formatDateTime(c.createdAt))}</time>
              <button type="button" class="link-btn" data-remove-comment="${i}" aria-label="Delete comment from ${esc(formatDateTime(c.createdAt))}">Delete</button>
            </div>
            <p>${esc(c.text)}</p>
          </div>`)
        .join("") || '<p class="empty">No comments yet</p>';
  }

  // Everything the user can change in the task dialog, as one comparable string.
  function taskFormState() {
    if (!draft) return "";
    return JSON.stringify([
      $("f-title").value, $("f-description").value, $("f-assigned").value, $("f-due").value,
      $("f-priority").value, $("f-status").value, draft.attachments, draft.comments,
      $("f-attachment-input").value.trim(), $("f-comment-input").value.trim(),
    ]);
  }

  function openTaskDialog(taskId, statusId) {
    const existing = taskId ? board.tasks.find((t) => t.id === taskId) : null;
    draft = existing
      ? clone(existing)
      : {
          id: null,
          title: "",
          description: "",
          assignedTo: defaultAssignee(),
          dueDate: "",
          priority: "Medium",
          attachments: [],
          comments: [],
          status: statusId || board.statuses[0].id,
        };

    $("task-dialog-title").textContent = existing ? "Edit task" : "New task";
    $("btn-delete-task").classList.toggle("hidden", !existing);
    $("f-title").value = draft.title;
    $("f-description").value = draft.description;
    $("f-assigned").value = draft.assignedTo;
    closeCombo();
    $("f-due").value = draft.dueDate;
    $("f-priority").value = draft.priority;
    $("f-status").innerHTML = board.statuses
      .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`)
      .join("");
    $("f-status").value = draft.status;
    $("f-attachment-input").value = "";
    $("f-comment-input").value = "";
    setFieldError("f-title", "f-title-error", "");
    setFieldError("f-attachment-input", "f-attachment-error", "");
    renderDraftLists();

    $("task-dialog").showModal();
    $("f-title").focus();
    draftSnapshot = taskFormState();
  }

  guardClose($("task-dialog"), () => taskFormState() !== draftSnapshot,
    "Your unsaved changes to this task will be lost.");

  $("f-title").addEventListener("input", () => setFieldError("f-title", "f-title-error", ""));
  $("f-attachment-input").addEventListener("input", () => setFieldError("f-attachment-input", "f-attachment-error", ""));

  $("task-form").addEventListener("click", (e) => {
    const rmAttachment = e.target.closest("[data-remove-attachment]");
    if (rmAttachment) {
      draft.attachments.splice(Number(rmAttachment.dataset.removeAttachment), 1);
      renderDraftLists();
      $("f-attachment-input").focus();
      return;
    }
    const rmComment = e.target.closest("[data-remove-comment]");
    if (rmComment) {
      draft.comments.splice(Number(rmComment.dataset.removeComment), 1);
      renderDraftLists();
      $("f-comment-input").focus();
    }
  });

  const ATTACHMENT_ERROR = "Attachment URLs must start with http:// or https://";

  $("btn-add-attachment").addEventListener("click", () => {
    const input = $("f-attachment-input");
    const url = input.value.trim();
    if (!url) return;
    if (!isHttpUrl(url)) {
      setFieldError("f-attachment-input", "f-attachment-error", ATTACHMENT_ERROR);
      input.focus();
      return;
    }
    draft.attachments.push(url);
    input.value = "";
    renderDraftLists();
    $("f-attachments").scrollTop = $("f-attachments").scrollHeight;
  });

  $("f-attachment-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();   // do not submit the whole task form
      $("btn-add-attachment").click();
    }
  });

  $("btn-add-comment").addEventListener("click", () => {
    const input = $("f-comment-input");
    const text = input.value.trim();
    if (!text) return;
    draft.comments.push({ id: uid(), text, createdAt: new Date().toISOString() });
    input.value = "";
    renderDraftLists();
    $("f-comments").scrollTop = $("f-comments").scrollHeight;   // show the new comment (the list scrolls when long)
  });

  $("task-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("f-title").value.trim();
    if (!title) {
      setFieldError("f-title", "f-title-error", "Enter a title for the task.");
      $("f-title").focus();
      return;
    }

    // Include URL/comment text typed but not yet added with the buttons.
    const pendingUrl = $("f-attachment-input").value.trim();
    if (pendingUrl && !isHttpUrl(pendingUrl)) {
      setFieldError("f-attachment-input", "f-attachment-error", ATTACHMENT_ERROR);
      $("f-attachment-input").focus();
      return;
    }
    const pendingComment = $("f-comment-input").value.trim();

    // A name typed in "Assigned to" joins the workers list; a known name keeps its saved spelling.
    const assignedTo = M.addWorker(workspace.workers, $("f-assigned").value);

    const now = new Date().toISOString();
    const fields = {
      title,
      description: $("f-description").value.trim(),
      assignedTo,
      dueDate: $("f-due").value,
      priority: $("f-priority").value,
      attachments: [...draft.attachments, ...(pendingUrl ? [pendingUrl] : [])],
      comments: [
        ...draft.comments,
        ...(pendingComment ? [{ id: uid(), text: pendingComment, createdAt: now }] : []),
      ],
      updatedAt: now,
    };
    const statusId = $("f-status").value;

    let task = draft.id ? board.tasks.find((t) => t.id === draft.id) : null;
    if (task) {
      Object.assign(task, fields);
      if (task.status !== statusId) M.moveTask(board, task.id, statusId);   // goes to the end of its new column
    } else {
      task = { id: uid(), createdAt: now, status: statusId, ...fields };
      board.tasks.push(task);
    }

    $("task-dialog").close();
    const saved = commit();
    focusCard(task.id);   // the card was re-rendered; put focus back on it
    if (saved) toast("Task saved.");
  });

  // Deleting is immediate and can be undone from the toast (or with Ctrl+Z).
  $("btn-delete-task").addEventListener("click", () => {
    if (!draft || !draft.id) return;
    const index = board.tasks.findIndex((t) => t.id === draft.id);
    if (index < 0) return;
    const project = board;
    const [removed] = project.tasks.splice(index, 1);
    $("task-dialog").close();
    if (!commit()) return;
    toast(`Deleted "${removed.title}".`, "info", {
      label: "Undo",
      run: () => {
        if (!projectById(project.id)) return;
        if (board !== project) setActiveProject(project.id);
        if (!statusById(removed.status)) removed.status = board.statuses[0].id;
        board.tasks.splice(Math.min(index, board.tasks.length), 0, removed);
        if (commit()) {
          focusCard(removed.id);
          toast("Task restored.");
        }
      },
    });
  });

  // ---------- Status dialog ----------
  const countTasks = (statusId) => (statusId ? board.tasks.filter((t) => t.status === statusId).length : 0);

  // Labels name the status so screen reader users can tell rows apart.
  function labelStatusRow(row, name) {
    const n = name || "new status";
    row.querySelector(".s-color").setAttribute("aria-label", `Color for ${n}`);
    row.querySelector(".s-name").setAttribute("aria-label", `Name of ${n}`);
    row.querySelector(".s-done-input").setAttribute("aria-label", `${n} is a completed status`);
    row.querySelector("[data-move='-1']").setAttribute("aria-label", `Move ${n} up`);
    row.querySelector("[data-move='1']").setAttribute("aria-label", `Move ${n} down`);
    row.querySelector("[data-delete-status]").setAttribute("aria-label", `Delete ${n}`);
  }

  function renderStatusRows() {
    const last = statusDraft.length - 1;
    $("status-list").innerHTML = statusDraft
      .map((s, i) => `
        <div class="status-row" data-index="${i}">
          <input type="color" class="s-color" value="${esc(s.color)}">
          <input type="text" class="s-name" value="${esc(s.name)}" maxlength="40" placeholder="Status name">
          <label class="s-done"><input type="checkbox" class="s-done-input" ${s.done ? "checked" : ""}> Completed</label>
          <span class="s-count">${plural(countTasks(s.id), "task")}</span>
          <button type="button" class="icon-btn" data-move="-1" ${i === 0 ? "disabled" : ""}>${icon("i-up")}</button>
          <button type="button" class="icon-btn" data-move="1" ${i === last ? "disabled" : ""}>${icon("i-down")}</button>
          <button type="button" class="icon-btn text-danger" data-delete-status ${statusDraft.length === 1 ? "disabled" : ""}>${icon("i-trash")}</button>
        </div>`)
      .join("");
    document.querySelectorAll("#status-list .status-row").forEach((row) =>
      labelStatusRow(row, statusDraft[Number(row.dataset.index)].name));
  }

  // Copies what is typed in the rows back into statusDraft before re-rendering.
  function readStatusRows() {
    document.querySelectorAll("#status-list .status-row").forEach((row) => {
      const s = statusDraft[Number(row.dataset.index)];
      s.name = row.querySelector(".s-name").value.trim();
      s.color = row.querySelector(".s-color").value;
      s.done = row.querySelector(".s-done-input").checked;
    });
  }

  function openStatusDialog() {
    statusDraft = board.statuses.map((s) => ({ ...s }));
    $("status-error").textContent = "";
    renderStatusRows();
    $("status-dialog").showModal();
    statusSnapshot = JSON.stringify(statusDraft);
  }

  guardClose($("status-dialog"), () => {
    readStatusRows();
    return JSON.stringify(statusDraft) !== statusSnapshot;
  }, "Your unsaved changes to the statuses will be lost.");

  $("btn-statuses").addEventListener("click", openStatusDialog);

  $("status-list").addEventListener("input", (e) => {
    if (!e.target.matches(".s-name")) return;
    labelStatusRow(e.target.closest(".status-row"), e.target.value.trim());
    $("status-error").textContent = "";
  });

  $("btn-add-status").addEventListener("click", () => {
    readStatusRows();
    statusDraft.push({ id: null, name: "", color: PALETTE[statusDraft.length % PALETTE.length], done: false });
    renderStatusRows();
    const inputs = $("status-list").querySelectorAll(".s-name");
    inputs[inputs.length - 1].focus();
  });

  $("status-list").addEventListener("click", (e) => {
    const row = e.target.closest(".status-row");
    if (!row) return;
    const index = Number(row.dataset.index);
    const moveBtn = e.target.closest("[data-move]");
    const deleteBtn = e.target.closest("[data-delete-status]");
    if (!moveBtn && !deleteBtn) return;

    readStatusRows();
    let focusIndex = index;
    if (moveBtn) {
      const target = index + Number(moveBtn.dataset.move);
      if (target < 0 || target >= statusDraft.length) return;
      [statusDraft[index], statusDraft[target]] = [statusDraft[target], statusDraft[index]];
      focusIndex = target;
    } else {
      statusDraft.splice(index, 1);
      focusIndex = Math.min(index, statusDraft.length - 1);
    }
    renderStatusRows();
    // Keep keyboard focus in the list after the rows are rebuilt.
    const rows = $("status-list").querySelectorAll(".status-row");
    const sel = moveBtn ? `[data-move="${moveBtn.dataset.move}"]` : ".s-name";
    const target = rows[focusIndex] && rows[focusIndex].querySelector(sel);
    if (target && !target.disabled) target.focus();
    else if (rows[focusIndex]) rows[focusIndex].querySelector(".s-name").focus();
  });

  $("status-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    readStatusRows();
    const showError = (message) => { $("status-error").textContent = message; };

    const names = new Set();
    for (const s of statusDraft) {
      if (!s.name) return showError("Every status needs a name.");
      const key = s.name.toLowerCase();
      if (names.has(key)) return showError(`Two statuses are named "${s.name}". Use different names.`);
      names.add(key);
    }
    if (!statusDraft.length) return;

    // Keep existing ids so tasks stay linked when a status is renamed.
    // New statuses must not reuse the id of a deleted status, or old tasks would re-link to them.
    const usedIds = new Set();
    const oldIds = new Set(board.statuses.map((s) => s.id));
    const next = statusDraft.map((s) => {
      const id = s.id
        ? uniqueId(s.id, usedIds)
        : uniqueId(slugify(s.name), new Set([...usedIds, ...oldIds]));
      usedIds.add(id);
      return { id, name: s.name, color: s.color, done: s.done };
    });

    const nextIds = new Set(next.map((s) => s.id));
    const removed = board.statuses.filter((s) => !nextIds.has(s.id));
    const removedIds = new Set(removed.map((s) => s.id));
    const affected = board.tasks.filter((t) => removedIds.has(t.status)).length;
    const fallback = next[0];

    if (affected) {
      const withTasks = removed.filter((s) => countTasks(s.id));
      const list = withTasks.map((s) => `"${s.name}"`).join(", ");
      const confirmed = await confirmAction({
        title: removed.length === 1 ? "Delete status?" : "Delete statuses?",
        message: `${list} ${withTasks.length === 1 ? "has" : "have"} ${plural(affected, "task")}. ` +
          `${affected === 1 ? "It" : "They"} will move to "${fallback.name}".`,
        ok: `Delete and move ${plural(affected, "task")}`,
      });
      if (!confirmed) return;
    }

    for (const task of board.tasks) {
      if (removedIds.has(task.status)) task.status = fallback.id;
    }
    board.statuses = next;
    $("status-dialog").close();
    if (!commit()) return;
    toast(affected ? `Statuses updated. ${plural(affected, "task")} moved to "${fallback.name}".` : "Statuses updated.");
  });

  // ---------- Import / export ----------
  // Files hold a whole workspace (format 2) or a single board (format 1, imported as one project).
  function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const taskTotal = (projects) => projects.reduce((n, p) => n + p.tasks.length, 0);

  $("btn-import").addEventListener("click", () => $("file-input").click());
  $("btn-welcome-import").addEventListener("click", () => $("file-input").click());

  $("file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = ""; // allow picking the same file again later
    if (!file) return;

    let incoming;
    let notice = "";
    try {
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("The file is not valid JSON.");
      }
      // A single-board file becomes one project named after the file.
      const baseName = file.name.replace(/\.json$/i, "").trim() || "Imported project";
      incoming = M.parseWorkspace(data, baseName);
      notice = M.versionNotice(data);
    } catch (err) {
      toast(`Import failed: ${err.message}`, "error");
      return;
    }

    pendingImport = incoming;
    const n = incoming.projects.length;
    $("import-summary").textContent =
      `"${file.name}" contains ${plural(n, "project")} with ${plural(taskTotal(incoming.projects), "task")}. ` +
      `Choose the projects to import.`;
    $("import-version").hidden = !notice;
    $("import-version").lastChild.textContent = notice;
    renderImportList();
    $("import-dialog").showModal();
  });

  function selectedImportIndexes() {
    return [...document.querySelectorAll("#import-projects input:checked")].map((el) => Number(el.dataset.index));
  }

  // A project in the file that is already here (the same project, shared earlier): its local copy.
  const localCopy = (p) => workspace.projects.find((q) => q.id === p.id);

  // One checkbox per project in the file, with the name it would get when added.
  function renderImportList() {
    const existing = workspace.projects.map((p) => p.name);
    $("import-projects").innerHTML = pendingImport.projects
      .map((p, i) => {
        const finalName = M.uniqueName(p.name, existing);
        const local = localCopy(p);
        const renamed = local
          ? `<span class="hint">Already here as “${esc(local.name)}”: Update overwrites it</span>`
          : finalName !== p.name
            ? `<span class="hint">Added as “${esc(finalName)}”, because “${esc(p.name)}” already exists</span>` : "";
        return `
          <label class="check-row">
            <input type="checkbox" data-index="${i}" checked>
            <span class="check-text"><strong>${esc(p.name)}</strong> <span class="hint">${plural(p.tasks.length, "task")}</span>${renamed}</span>
          </label>`;
      })
      .join("");
    updateImportButtons();
  }

  // When the file holds projects that are already here, Update is the main action and Add makes copies.
  function updateImportButtons() {
    const count = selectedImportIndexes().length;
    const canUpdate = pendingImport.projects.some(localCopy);
    $("btn-import-add").disabled = count === 0;
    $("btn-import-replace").disabled = count === 0;
    $("btn-import-update").disabled = count === 0;
    $("btn-import-update").hidden = !canUpdate;
    $("import-help-update").hidden = !canUpdate;
    $("btn-import-add").classList.toggle("primary", !canUpdate);
    const addLabel = canUpdate ? "Add as new" : "Add selected";
    $("import-help-add").textContent = addLabel;
    $("btn-import-add").lastChild.textContent = count === pendingImport.projects.length || count === 0
      ? addLabel : `Add ${plural(count, "project")}`;
  }

  $("import-projects").addEventListener("change", updateImportButtons);

  $("import-dialog").addEventListener("close", () => { pendingImport = null; });

  function applyImport(mode) {
    if (!pendingImport) return;
    const incoming = pendingImport;
    const chosen = selectedImportIndexes().map((i) => incoming.projects[i]);
    if (!chosen.length) return;
    $("import-dialog").close();

    const before = clone(workspace);
    const openId = board.id;
    // On a fresh start (only the empty project the app begins with) the file's projects take its place.
    const fresh = workspace.projects.length === 1 && !workspace.projects[0].tasks.length &&
      workspace.projects[0].name === M.DEFAULT_PROJECT_NAME && !workspace.projects[0].background;
    if (fresh && mode === "add") mode = "replace";
    const updatedIds = new Set(mode === "update" ? chosen.filter(localCopy).map((p) => p.id) : []);
    const added = M.addProjects(workspace, chosen, mode, incoming.workers, incoming.background);
    // Open the file's open project on a replace, the imported project when there is exactly one new one,
    // and otherwise stay where the user is.
    const newOnes = added.filter((p) => !updatedIds.has(p.id));
    if (mode === "replace") setActiveProject(added.some((p) => p.id === incoming.activeProjectId) ? incoming.activeProjectId : added[0].id);
    else if (newOnes.length === 1 && !updatedIds.size) setActiveProject(newOnes[0].id);
    else setActiveProject(openId);
    if (!commit()) return;

    const what = (list) => (list.length === 1 ? `"${list[0].name}"` : plural(list.length, "project"));
    const updatedOnes = added.filter((p) => updatedIds.has(p.id));
    let message;
    if (mode === "update") {
      message = `Updated ${what(updatedOnes)}` + (newOnes.length ? ` and added ${what(newOnes)}.` : ".");
    } else if (mode === "add") {
      message = `Imported ${what(added)}.`;
    } else {
      message = fresh ? `Imported ${what(added)}.` : `Replaced all projects with ${what(added)}.`;
    }
    toast(
      message,
      "info",
      {
        label: "Undo",
        run: () => {
          workspace = before;
          setActiveProject(openId);
          if (commit()) toast("Import undone.");
        },
      }
    );
  }

  $("btn-import-add").addEventListener("click", () => applyImport("add"));
  $("btn-import-replace").addEventListener("click", () => applyImport("replace"));
  $("btn-import-update").addEventListener("click", () => applyImport("update"));

  // Export: every project and the workers list in one file.
  $("btn-export").addEventListener("click", () => {
    downloadJson(M.serializeWorkspace(workspace, { exportedAt: new Date().toISOString() }), `kanban-${M.today()}.json`);
    toast(`Exported ${plural(workspace.projects.length, "project")} with ${plural(taskTotal(workspace.projects), "task")}.`);
  });

  // A file with just one project (used as a backup before starting a new project).
  function exportProject(project) {
    const single = { activeProjectId: project.id, workers: workspace.workers, background: workspace.background, projects: [project] };
    downloadJson(
      M.serializeWorkspace(single, { exportedAt: new Date().toISOString() }),
      `kanban-${M.slugify(project.name)}-${M.today()}.json`
    );
  }

  // ---------- Projects: rename, switch, create ----------
  let renaming = false;

  function startRename() {
    renaming = true;
    const input = $("project-name-input");
    input.value = board.name;
    document.querySelector(".project-title").classList.add("hidden");
    input.classList.remove("hidden");
    input.focus();
    input.select();
  }

  // save: keep the typed name. refocus: return focus to the name (keyboard finish, not a click elsewhere).
  function finishRename(save, refocus) {
    if (!renaming) return;
    renaming = false;
    const input = $("project-name-input");
    const name = input.value.trim();
    input.classList.add("hidden");
    document.querySelector(".project-title").classList.remove("hidden");
    if (refocus) $("project-name").focus();
    if (!save || !name || name === board.name) return;
    if (workspace.projects.some((p) => p !== board && sameName(p.name, name))) {
      toast(`Another project is already named "${name}".`, "error");
      return;
    }
    board.name = name;
    if (commit()) toast(`Project renamed to "${name}".`);
  }

  $("project-name").addEventListener("click", startRename);
  $("project-name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finishRename(true, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finishRename(false, true);
    }
  });
  $("project-name-input").addEventListener("blur", () => finishRename(true, false));

  function renderProjectsList() {
    $("projects-list").innerHTML = workspace.projects
      .map((p) => {
        const current = p === board;
        return `
          <button type="button" data-project-id="${esc(p.id)}"${current ? ' aria-current="true"' : ""}>
            ${current ? icon("i-check") : '<span class="icon" aria-hidden="true"></span>'}
            <span class="pl-name">${esc(p.name)}</span>
            <span class="pl-count" title="${plural(p.tasks.length, "task")}">${p.tasks.length}<span class="sr-only"> tasks</span></span>
          </button>`;
      })
      .join("") +
      `<button type="button" class="pl-manage" data-manage-projects>${icon("i-folder")}Manage projects…</button>`;
  }

  $("projects-list").addEventListener("click", (e) => {
    if (e.target.closest("[data-manage-projects]")) {
      openProjectsDialog();
      return;
    }
    const btn = e.target.closest("[data-project-id]");
    if (!btn || btn.dataset.projectId === board.id) return;
    setActiveProject(btn.dataset.projectId);
    if (commit()) toast(`Opened "${board.name}".`);
  });

  $("btn-new-project").addEventListener("click", () => {
    $("np-name").value = "";
    setFieldError("np-name", "np-name-error", "");
    $("np-current").textContent = board.name;
    $("np-backup").checked = true;
    $("project-dialog").showModal();
    $("np-name").focus();
  });

  $("np-name").addEventListener("input", () => setFieldError("np-name", "np-name-error", ""));

  $("project-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("np-name").value.trim();
    if (!name) {
      setFieldError("np-name", "np-name-error", "Enter a name for the new project.");
      $("np-name").focus();
      return;
    }
    if (workspace.projects.some((p) => sameName(p.name, name))) {
      setFieldError("np-name", "np-name-error", `A project named "${name}" already exists.`);
      $("np-name").focus();
      return;
    }
    if ($("np-backup").checked) exportProject(board);
    const project = M.newProject(name);
    workspace.projects.push(project);
    setActiveProject(project.id);
    $("project-dialog").close();
    if (commit()) toast(`Created project "${name}".`);
  });

  // ---------- Manage projects ----------
  let projectsDraft = [];   // [{ id, name, tasks }] in display order
  let projectsSnapshot = "";

  function renderProjectRows() {
    const single = projectsDraft.length === 1;
    $("projects-rows").innerHTML = projectsDraft
      .map((p, i) => `
        <div class="edit-row" data-index="${i}">
          <input type="text" class="p-name" value="${esc(p.name)}" maxlength="80" aria-label="Name of project ${esc(p.name)}">
          <span class="s-count">${plural(p.tasks, "task")}${p.id === board.id ? " · open" : ""}</span>
          <button type="button" class="icon-btn text-danger" data-delete-project ${single ? "disabled title=\"The last project cannot be deleted\"" : ""}
            aria-label="Delete project ${esc(p.name)}">${icon("i-trash")}</button>
        </div>`)
      .join("");
  }

  function readProjectRows() {
    document.querySelectorAll("#projects-rows .edit-row").forEach((row) => {
      projectsDraft[Number(row.dataset.index)].name = row.querySelector(".p-name").value.trim();
    });
  }

  function openProjectsDialog() {
    projectsDraft = workspace.projects.map((p) => ({ id: p.id, name: p.name, tasks: p.tasks.length }));
    $("projects-error").textContent = "";
    renderProjectRows();
    $("projects-dialog").showModal();
    projectsSnapshot = JSON.stringify(projectsDraft);
  }

  guardClose($("projects-dialog"), () => {
    readProjectRows();
    return JSON.stringify(projectsDraft) !== projectsSnapshot;
  }, "Your unsaved changes to the projects will be lost.");

  $("btn-manage-projects").addEventListener("click", openProjectsDialog);

  $("projects-rows").addEventListener("input", () => { $("projects-error").textContent = ""; });

  $("projects-rows").addEventListener("click", (e) => {
    const del = e.target.closest("[data-delete-project]");
    if (!del) return;
    readProjectRows();
    const index = Number(del.closest(".edit-row").dataset.index);
    projectsDraft.splice(index, 1);
    renderProjectRows();
    const rows = $("projects-rows").querySelectorAll(".p-name");
    if (rows.length) rows[Math.min(index, rows.length - 1)].focus();
  });

  $("projects-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    readProjectRows();
    const showError = (message) => { $("projects-error").textContent = message; };
    const names = [];
    for (const p of projectsDraft) {
      if (!p.name) return showError("Every project needs a name.");
      if (names.some((n) => sameName(n, p.name))) return showError(`Two projects are named "${p.name}". Use different names.`);
      names.push(p.name);
    }

    const keep = new Set(projectsDraft.map((p) => p.id));
    const removed = workspace.projects.filter((p) => !keep.has(p.id));
    if (removed.length) {
      const list = removed.map((p) => `"${p.name}"`).join(", ");
      const confirmed = await confirmAction({
        title: removed.length === 1 ? "Delete project?" : "Delete projects?",
        message: `${list} will be deleted with ${plural(taskTotal(removed), "task")}. You can undo this right after.`,
        ok: removed.length === 1 ? "Delete project" : `Delete ${removed.length} projects`,
      });
      if (!confirmed) return;
    }

    const before = clone(workspace);
    const openId = board.id;
    workspace.projects = projectsDraft.map((d) => Object.assign(projectById(d.id), { name: d.name }));
    setActiveProject(keep.has(openId) ? openId : workspace.projects[0].id);
    $("projects-dialog").close();
    if (!commit()) return;

    if (!removed.length) {
      toast("Projects updated.");
      return;
    }
    toast(removed.length === 1 ? `Deleted project "${removed[0].name}".` : `Deleted ${removed.length} projects.`, "info", {
      label: "Undo",
      run: () => {
        workspace = before;
        setActiveProject(openId);
        if (commit()) toast("Projects restored.");
      },
    });
  });

  // ---------- Manage workers ----------
  let workersDraft = [];    // [{ original, name }]; original is null for a new row
  let workersSnapshot = "";

  function renderWorkerRows() {
    $("workers-rows").innerHTML = workersDraft
      .map((w, i) => {
        const label = w.name || "new worker";
        const count = w.original ? M.countAssigned(workspace, w.original) : 0;
        return `
          <div class="edit-row" data-index="${i}">
            <input type="text" class="w-name" value="${esc(w.name)}" maxlength="100" placeholder="Worker name" aria-label="Name of ${esc(label)}">
            <span class="s-count">${plural(count, "task")}</span>
            <button type="button" class="icon-btn text-danger" data-delete-worker aria-label="Remove ${esc(label)}">${icon("i-trash")}</button>
          </div>`;
      })
      .join("");
    $("workers-empty").classList.toggle("hidden", workersDraft.length > 0);
  }

  function readWorkerRows() {
    document.querySelectorAll("#workers-rows .edit-row").forEach((row) => {
      workersDraft[Number(row.dataset.index)].name = row.querySelector(".w-name").value.trim();
    });
  }

  function openWorkersDialog() {
    workersDraft = workspace.workers.map((w) => ({ original: w, name: w }));
    $("workers-error").textContent = "";
    renderWorkerRows();
    $("workers-dialog").showModal();
    workersSnapshot = JSON.stringify(workersDraft);
  }

  guardClose($("workers-dialog"), () => {
    readWorkerRows();
    return JSON.stringify(workersDraft) !== workersSnapshot;
  }, "Your unsaved changes to the workers will be lost.");

  $("btn-workers").addEventListener("click", openWorkersDialog);

  $("workers-rows").addEventListener("input", () => { $("workers-error").textContent = ""; });

  $("btn-add-worker").addEventListener("click", () => {
    readWorkerRows();
    workersDraft.push({ original: null, name: "" });
    renderWorkerRows();
    const inputs = $("workers-rows").querySelectorAll(".w-name");
    inputs[inputs.length - 1].focus();
  });

  $("workers-rows").addEventListener("click", (e) => {
    const del = e.target.closest("[data-delete-worker]");
    if (!del) return;
    readWorkerRows();
    const index = Number(del.closest(".edit-row").dataset.index);
    workersDraft.splice(index, 1);
    renderWorkerRows();
    const inputs = $("workers-rows").querySelectorAll(".w-name");
    if (inputs.length) inputs[Math.min(index, inputs.length - 1)].focus();
    else $("btn-add-worker").focus();
  });

  $("workers-form").addEventListener("submit", (e) => {
    e.preventDefault();
    readWorkerRows();
    const rows = workersDraft.filter((w) => w.name || w.original);   // blank new rows are ignored
    const names = [];
    for (const w of rows) {
      if (!w.name) {
        $("workers-error").textContent = `Enter a name for "${w.original}", or remove the worker.`;
        return;
      }
      if (names.some((n) => sameName(n, w.name))) {
        $("workers-error").textContent = `"${w.name}" is listed twice.`;
        return;
      }
      names.push(w.name);
    }

    let changedTasks = 0;
    for (const w of rows) {
      if (w.original && w.name !== w.original) {
        changedTasks += M.renameWorker(workspace, w.original, w.name);
        if (workerFilter && sameName(workerFilter, w.original)) setWorkerFilter(w.name);
      }
    }
    workspace.workers = M.normalizeWorkers(names);
    $("workers-dialog").close();
    if (commit()) {
      toast(changedTasks ? `Workers updated. ${plural(changedTasks, "task")} now show the new names.` : "Workers updated.");
    }
  });

  // ---------- Moving cards ----------
  function focusCard(taskId) {
    const el = document.querySelector(`.card[data-id="${CSS.escape(taskId)}"] .card-open`);
    if (el) el.focus();
  }

  // Moves a task to a column (before another card, or to the end). Returns true when something changed.
  function moveTaskTo(taskId, statusId, beforeId = null) {
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    const changedColumn = task.status !== statusId;
    if (!M.moveTask(board, taskId, statusId, beforeId)) return false;
    task.updatedAt = new Date().toISOString();
    const saved = commit();
    if (saved && changedColumn) toast(`Moved to "${statusById(statusId).name}".`);
    return true;
  }

  // Moves a task one column left (-1) or right (+1) and keeps focus on it.
  function moveTaskByOffset(taskId, offset) {
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const index = board.statuses.findIndex((s) => s.id === task.status);
    const target = board.statuses[index + offset];
    if (!target) {
      toast(offset < 0 ? "Already in the first column." : "Already in the last column.");
      return;
    }
    moveTaskTo(taskId, target.id);
    focusCard(taskId);
  }

  // Moves a task up (-1) or down (+1) among the cards shown in its column.
  function reorderByOffset(card, offset) {
    const column = card.closest(".column");
    const ids = [...column.querySelectorAll(".card")].map((c) => c.dataset.id);
    const taskId = card.dataset.id;
    if (!M.reorderTask(board, taskId, offset, ids)) {
      toast(offset < 0 ? "Already at the top." : "Already at the bottom.");
      return;
    }
    commit();
    focusCard(taskId);
  }

  // ---------- Drag and drop ----------
  // A line shows where the card will land; dropping places it there (also within the same column).
  const dropIndicator = document.createElement("div");
  dropIndicator.className = "drop-indicator";
  dropIndicator.setAttribute("aria-hidden", "true");

  function clearDropState() {
    dropIndicator.remove();
    document.querySelectorAll(".dragging, .drop-target").forEach((el) =>
      el.classList.remove("dragging", "drop-target"));
  }

  $("board").addEventListener("dragstart", (e) => {
    const card = e.target.closest(".card");
    if (!card) return;
    dragId = card.dataset.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragId); // required by some browsers
    card.classList.add("dragging");
  });

  $("board").addEventListener("dragend", () => {
    dragId = null;
    clearDropState();
  });

  $("board").addEventListener("dragover", (e) => {
    const column = e.target.closest(".column");
    if (!column || !dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".drop-target").forEach((el) => {
      if (el !== column) el.classList.remove("drop-target");
    });
    column.classList.add("drop-target");

    const body = column.querySelector(".column-body");
    const cards = [...body.querySelectorAll(".card:not(.dragging)")];
    const before = cards.find((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    }) || null;
    if (dropIndicator.parentElement !== body || dropIndicator.nextElementSibling !== before) {
      body.insertBefore(dropIndicator, before);
    }
  });

  $("board").addEventListener("dragleave", (e) => {
    const column = e.target.closest(".column");
    if (column && !column.contains(e.relatedTarget)) {
      column.classList.remove("drop-target");
      if (column.contains(dropIndicator)) dropIndicator.remove();
    }
  });

  $("board").addEventListener("drop", (e) => {
    const column = e.target.closest(".column");
    if (!column || !dragId) return;
    e.preventDefault();
    const id = dragId;
    dragId = null;
    let next = dropIndicator.parentElement ? dropIndicator.nextElementSibling : null;
    if (next && next.classList.contains("dragging")) next = next.nextElementSibling;
    const beforeId = next && next.classList.contains("card") ? next.dataset.id : null;
    clearDropState();
    if (!moveTaskTo(id, column.dataset.status, beforeId)) render();
  });

  // ---------- Board interactions ----------
  $("board").addEventListener("click", (e) => {
    const moveBtn = e.target.closest("[data-move-card]");
    if (moveBtn) {
      moveTaskByOffset(moveBtn.closest(".card").dataset.id, Number(moveBtn.dataset.moveCard));
      return;
    }
    const addBtn = e.target.closest("[data-add-status]");
    if (addBtn) {
      openTaskDialog(null, addBtn.dataset.addStatus);
      return;
    }
    const card = e.target.closest(".card");
    if (card) openTaskDialog(card.dataset.id, null);
  });

  // Keyboard on a card's title button: Enter/Space opens (native button), Alt+arrows move.
  $("board").addEventListener("keydown", (e) => {
    if (!e.altKey || !e.target.matches(".card-open")) return;
    const card = e.target.closest(".card");
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      moveTaskByOffset(card.dataset.id, e.key === "ArrowLeft" ? -1 : 1);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      reorderByOffset(card, e.key === "ArrowUp" ? -1 : 1);
    }
  });

  const newTaskInFirstColumn = () => openTaskDialog(null, board.statuses[0].id);
  $("btn-add-task").addEventListener("click", newTaskInFirstColumn);

  // ---------- Popover menus (disclosure: a button that shows a panel) ----------
  // Used by the burger menu and the project switcher. Only one is open at a time.
  const popovers = [];

  function popover(toggleId, panelId, onOpen) {
    const toggle = $(toggleId);
    const panel = $(panelId);
    const root = toggle.closest(".menu");
    const p = {
      toggle,
      root,
      isOpen: () => !panel.classList.contains("hidden"),
      set(open) {
        if (open) {
          popovers.forEach((other) => other !== p && other.set(false));
          if (onOpen) onOpen();
        }
        panel.classList.toggle("hidden", !open);
        toggle.setAttribute("aria-expanded", String(open));
      },
    };
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      p.set(!p.isOpen());
    });
    // Close when tabbing out, and after choosing an item (the item's own handler still runs).
    root.addEventListener("focusout", (e) => {
      if (p.isOpen() && e.relatedTarget && !root.contains(e.relatedTarget)) p.set(false);
    });
    panel.addEventListener("click", (e) => {
      if (e.target.closest("button")) p.set(false);
    });
    popovers.push(p);
    return p;
  }

  popover("btn-menu", "menu-panel");
  popover("btn-projects", "projects-panel", renderProjectsList);

  // Close when clicking anywhere outside an open popover.
  document.addEventListener("click", (e) => {
    popovers.forEach((p) => p.isOpen() && !p.root.contains(e.target) && p.set(false));
  });

  $("btn-shortcuts").addEventListener("click", () => $("shortcuts-dialog").showModal());

  // ---------- Keyboard shortcuts ----------
  // "+" new task in the first column, "/" search, "?" help (shortcut list), F2 rename project, Ctrl+Z undo.
  // All are ignored while typing in a field or while a dialog is open.
  document.addEventListener("keydown", (e) => {
    const open = popovers.find((p) => p.isOpen());
    if (e.key === "Escape" && open) {
      open.set(false);
      open.toggle.focus();
      return;
    }
    if (document.querySelector("dialog[open]") || isTyping(document.activeElement)) return;

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
      if (undoAction) {
        e.preventDefault();
        runUndo();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === "+") {
      e.preventDefault();
      newTaskInFirstColumn();
    } else if (e.key === "/") {
      e.preventDefault();
      $("search").focus();
      $("search").select();
    } else if (e.key === "?") {
      e.preventDefault();
      $("shortcuts-dialog").showModal();
    } else if (e.key === "F2") {
      e.preventDefault();
      startRename();
    }
  });

  // ---------- Init ----------
  // Moves backgrounds saved by earlier builds (outside the workspace) into the workspace.
  async function adoptLegacyBackgrounds() {
    const legacy = await S.takeLegacyBackgrounds();
    if (!legacy) return;
    let changed = false;
    if (legacy.all && !workspace.background) {
      workspace.background = legacy.all;
      changed = true;
    }
    for (const p of workspace.projects) {
      if (legacy.projects[p.id] && !p.background) {
        p.background = legacy.projects[p.id];
        changed = true;
      }
    }
    if (!changed || commit()) await legacy.finish();
  }

  // Images kept for backgrounds that no longer exist are dropped at startup rather than when a background
  // or project is removed, so Undo brings the image back too.
  function pruneKeptImages() {
    const names = [workspace.background, ...workspace.projects.map((p) => p.background)]
      .filter((bg) => bg && !M.isHttpUrl(bg.image))
      .map((bg) => bg.image);
    return S.pruneImages(names);
  }

  function init() {
    const priorityOptions = PRIORITIES.map((p) => `<option value="${p}">${p}</option>`).join("");
    $("priority-filter").insertAdjacentHTML("beforeend", priorityOptions);
    $("f-priority").innerHTML = priorityOptions;
    $("app-version").textContent = `v${M.APP_VERSION}`;

    const loaded = S.loadWorkspace();
    workspace = loaded.workspace;
    setActiveProject(workspace.activeProjectId);
    saveLocked = loaded.saveLocked;
    workerFilter = S.getWorkerFilter();
    // A board saved by an older version was turned into the first project: save it in the new format now.
    if (loaded.migrated && !saveLocked) {
      if (S.saveWorkspace(workspace).ok) S.removeLegacyBoard();
      else removeLegacyAfterSave = true;
    }

    const theme = S.getStoredTheme();
    applyTheme(theme);
    $("theme-select").value = theme;
    $("theme-select").addEventListener("change", () => setTheme($("theme-select").value));

    render();
    new ResizeObserver(updateBoardHint).observe($("board"));

    // Skipped when the saved projects could not be read, so nothing they refer to is touched.
    if (!saveLocked && !loaded.unreadableKeptAs) adoptLegacyBackgrounds().then(pruneKeptImages);

    if (saveLocked) {
      toast("The saved projects could not be read or backed up, so changes will not be saved.", "error");
    } else if (loaded.unreadableKeptAs) {
      toast(`The saved projects could not be read. A copy was kept under "${loaded.unreadableKeptAs}".`, "error");
    }
  }

  init();
})();
