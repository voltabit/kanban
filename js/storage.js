// Browser storage: the workspace (all projects and workers) and UI preferences in localStorage,
// picked background images in IndexedDB. Exposed as window.KanbanStorage. Depends on window.KanbanModel.
(function () {
  "use strict";

  const { parseWorkspace, newProject, serializeWorkspace, normalizeBackground, DEFAULT_PROJECT_NAME } = window.KanbanModel;

  const STORAGE_KEY = "kanban-board.workspace";     // format 2: every project and the workers list
  const LEGACY_KEY = "kanban-board.v1";             // format 1: the single board saved by older versions
  const THEME_KEY = "kanban-board.theme";           // "system" | "light" | "dark"
  const WORKER_KEY = "kanban-board.worker-filter";  // the worker shown in the toolbar filter
  const BG_KEY = "kanban-board.background";         // where earlier builds kept the background in localStorage

  // ---------- Workspace ----------
  const emptyWorkspace = () => {
    const project = newProject(DEFAULT_PROJECT_NAME);
    return { activeProjectId: project.id, workers: [], projects: [project] };
  };

  const read = (key) => {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      console.warn("Could not read browser storage:", err);
      return null;
    }
  };

  // Returns { workspace, unreadableKeptAs, saveLocked, migrated }.
  // When there is no workspace yet, the single board saved by older versions becomes its first project.
  function loadWorkspace() {
    let key = STORAGE_KEY;
    let raw = read(STORAGE_KEY);
    if (!raw) {
      key = LEGACY_KEY;
      raw = read(LEGACY_KEY);
    }
    if (!raw) return { workspace: emptyWorkspace(), unreadableKeptAs: null, saveLocked: false, migrated: false };

    try {
      const workspace = parseWorkspace(JSON.parse(raw));
      return { workspace, unreadableKeptAs: null, saveLocked: false, migrated: key === LEGACY_KEY };
    } catch (err) {
      // Keep a copy before the next save overwrites it. If the copy fails,
      // saving stays locked so the stored data is never destroyed silently.
      console.warn("Could not load saved projects:", err);
      const keptAs = keepUnreadableCopy(key, raw);
      return { workspace: emptyWorkspace(), unreadableKeptAs: keptAs, saveLocked: keptAs === null, migrated: false };
    }
  }

  // Copies unreadable saved data to a backup key. Returns the key used, or null on failure.
  function keepUnreadableCopy(sourceKey, raw) {
    const backupKey = `${sourceKey}.unreadable`;
    try {
      let key = backupKey;
      const existing = localStorage.getItem(key);
      if (existing !== null && existing !== raw) key = `${backupKey}.${Date.now()}`;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, raw);
      return key;
    } catch (err) {
      console.warn("Could not keep a copy of the unreadable data:", err);
      return null;
    }
  }

  // The format-1 board is removed once the workspace that replaced it has been saved.
  function removeLegacyBoard() {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch (err) {
      /* nothing to do */
    }
  }

  // Returns { ok: true } or { ok: false, message }.
  function saveWorkspace(workspace) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeWorkspace(workspace)));
      return { ok: true };
    } catch (err) {
      const full = err && (err.name === "QuotaExceededError" || err.code === 22);
      return {
        ok: false,
        message: full
          ? "Browser storage is full, so this change was not saved. Export your board, then remove old tasks or attachments."
          : `Could not save to browser storage: ${err.message}`,
      };
    }
  }

  // ---------- Theme ----------
  function getStoredTheme() {
    try {
      const value = localStorage.getItem(THEME_KEY);
      return value === "light" || value === "dark" ? value : "system";
    } catch (err) {
      return "system";
    }
  }

  function saveTheme(value) {
    try {
      localStorage.setItem(THEME_KEY, value);
    } catch (err) {
      console.warn("Could not save theme:", err);
    }
  }

  // ---------- Images ----------
  // The background settings are part of the workspace (so they travel in exported JSON files) and name their
  // image by file name. A picked image is also kept here, in IndexedDB under "image:<file name>", so it shows
  // in this browser even when the file is not next to index.html. IndexedDB is used so a large image does not
  // use up the ~5 MB localStorage quota the board itself needs; if it is unavailable, localStorage is used.
  const DB_NAME = "kanban-board";
  const DB_STORE = "kv";
  const IMAGE_PREFIX = "image:";
  const IMAGE_LS_PREFIX = "kanban-board.image:";
  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is not available."));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("IndexedDB is blocked."));
      }).catch((err) => {
        dbPromise = null;   // allow a retry later
        throw err;
      });
    }
    return dbPromise;
  }

  async function idb(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Transaction aborted."));
    });
  }

  const isImageData = (v) => typeof v === "string" && /^data:image\//.test(v);

  // Resolves to the kept copy of an image (a data URL), or null.
  async function getImage(name) {
    try {
      const stored = await idb("readonly", (s) => s.get(IMAGE_PREFIX + name));
      if (isImageData(stored)) return stored;
    } catch (err) {
      /* IndexedDB unavailable: try localStorage */
    }
    const fallback = read(IMAGE_LS_PREFIX + name);
    return isImageData(fallback) ? fallback : null;
  }

  // Resolves true on success, false when the browser refuses the write.
  async function saveImage(name, dataUrl) {
    try {
      await idb("readwrite", (s) => s.put(dataUrl, IMAGE_PREFIX + name));
      try { localStorage.removeItem(IMAGE_LS_PREFIX + name); } catch (err) { /* nothing to do */ }
      return true;
    } catch (err) {
      console.warn("IndexedDB write failed, trying localStorage:", err);
      try {
        localStorage.setItem(IMAGE_LS_PREFIX + name, dataUrl);
        return true;
      } catch (err2) {
        console.warn("Could not save the image:", err2);
        return false;
      }
    }
  }

  // Deletes kept images that no background names any more.
  async function pruneImages(names) {
    const keep = new Set(names);
    try {
      const keys = await idb("readonly", (s) => s.getAllKeys());
      const stale = keys.filter((k) => typeof k === "string" && k.startsWith(IMAGE_PREFIX) && !keep.has(k.slice(IMAGE_PREFIX.length)));
      if (stale.length) await idb("readwrite", (s) => { stale.forEach((k) => s.delete(k)); return s.count(); });
    } catch (err) {
      /* IndexedDB unavailable: nothing to prune there */
    }
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(IMAGE_LS_PREFIX) && !keep.has(k.slice(IMAGE_LS_PREFIX.length))) localStorage.removeItem(k);
      }
    } catch (err) {
      /* nothing to do */
    }
  }

  // ---------- Backgrounds saved by earlier builds ----------
  // Earlier builds kept the backgrounds outside the workspace: the one for every project under "background"
  // and each project's own under "background:<project id>" (in IndexedDB, or in localStorage under
  // BG_KEY and BG_KEY:<project id>), with a picked image stored inline as a data URL.
  const BG_PREFIX = "background:";
  const EXT_BY_TYPE = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };

  // Resolves to { all, projects: { [projectId]: background }, finish } or null when there is nothing to move.
  // Picked images are kept under a file name of their own. Call finish() once the workspace holding the
  // backgrounds has been saved; it deletes the old entries.
  async function takeLegacyBackgrounds() {
    const found = [];   // [projectId or null, raw value, delete function]
    try {
      const keys = await idb("readonly", (s) => s.getAllKeys());
      for (const k of keys) {
        if (k !== "background" && !(typeof k === "string" && k.startsWith(BG_PREFIX))) continue;
        const raw = await idb("readonly", (s) => s.get(k));
        found.push([k === "background" ? null : k.slice(BG_PREFIX.length), raw, () => idb("readwrite", (s) => s.delete(k))]);
      }
    } catch (err) {
      /* IndexedDB unavailable */
    }
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k !== BG_KEY && !(k && k.startsWith(BG_KEY + ":"))) continue;
        const projectId = k === BG_KEY ? null : k.slice(BG_KEY.length + 1);
        const remove = () => localStorage.removeItem(k);
        const inIdb = found.find(([id]) => id === projectId);
        if (inIdb) {   // IndexedDB wins; the copy here is only deleted
          const removeIdb = inIdb[2];
          inIdb[2] = async () => { await removeIdb(); remove(); };
          continue;
        }
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem(k)); } catch (err) { /* unreadable: just delete it */ }
        found.push([projectId, raw, remove]);
      }
    } catch (err) {
      /* nothing to do */
    }
    if (!found.length) return null;

    const result = { all: null, projects: {} };
    for (const [projectId, raw] of found) {
      let bg = null;
      if (raw && raw.source === "file" && isImageData(raw.value)) {
        const type = (raw.value.match(/^data:([^;,]+)/) || [])[1];
        const name = `background-${projectId ? projectId.slice(0, 8) : "all"}.${EXT_BY_TYPE[type] || "png"}`;
        if (await saveImage(name, raw.value)) bg = normalizeBackground({ ...raw, image: name });
      } else {
        bg = normalizeBackground(raw);
      }
      if (!bg) continue;
      if (projectId) result.projects[projectId] = bg;
      else result.all = bg;
    }
    result.finish = async () => {
      for (const [, , remove] of found) {
        try { await remove(); } catch (err) { /* nothing to do */ }
      }
    };
    return result;
  }

  // ---------- Worker filter ----------
  // "" for all workers, UNASSIGNED for tasks with nobody assigned, or a worker name.
  function getWorkerFilter() {
    return read(WORKER_KEY) || "";
  }

  function saveWorkerFilter(value) {
    try {
      if (value) localStorage.setItem(WORKER_KEY, value);
      else localStorage.removeItem(WORKER_KEY);
    } catch (err) {
      console.warn("Could not save the worker filter:", err);
    }
  }

  window.KanbanStorage = {
    STORAGE_KEY, LEGACY_KEY, THEME_KEY, BG_KEY,
    loadWorkspace, saveWorkspace, removeLegacyBoard, getWorkerFilter, saveWorkerFilter,
    getStoredTheme, saveTheme,
    getImage, saveImage, pruneImages, takeLegacyBackgrounds,
  };
})();
