// Pure data model: helpers, normalization, import/merge, and format versioning.
// No DOM access, so it runs in the browser (as window.KanbanModel) and in Node for tests.
(function (root) {
  "use strict";

  const FORMAT = "kanban-board";
  // 1: a single board { statuses, tasks }. 2: a workspace { activeProjectId, workers, projects: [board + id, name] }.
  const FORMAT_VERSION = 2;
  // The app release, shown in the menu and written to every saved or exported file as "appVersion".
  const APP_VERSION = "1.0.0";
  const PRIORITIES = ["Low", "Medium", "High", "Critical"];
  const DEFAULT_COLOR = "#64748b";
  const PALETTE = ["#64748b", "#2563eb", "#d97706", "#16a34a", "#9333ea", "#db2777", "#0891b2", "#dc2626"];

  const defaultStatuses = () => [
    { id: "todo", name: "To Do", color: "#64748b", done: false },
    { id: "in-progress", name: "In Progress", color: "#2563eb", done: false },
    { id: "review", name: "Review", color: "#d97706", done: false },
    { id: "done", name: "Done", color: "#16a34a", done: true },
  ];

  // ---------- Helpers ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const pad = (n) => String(n).padStart(2, "0");
  const isDateString = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const toIsoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => toIsoDate(new Date());

  const slugify = (s) =>
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "status";

  const uniqueId = (base, taken) => {
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  };

  const isHttpUrl = (s) => {
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  };

  // ---------- Backgrounds ----------
  // A background is { image, fit, position, dim }. The image is an http(s) address or the path of an image
  // file relative to index.html ("orange.jpg", "img/orange.jpg"), so a shared JSON file never carries the
  // image itself. A file that is not there simply shows no image.
  const BG_FITS = ["cover", "contain", "tile", "original"];
  const BG_POSITIONS = ["center", "top", "bottom"];
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;

  // A relative path made of plain folder and file names: no drive, scheme, or leading slash, and no "..".
  function isImagePath(value) {
    if (typeof value !== "string" || !value || value.length > 200) return false;
    if (/[\\:*?"<>|\u0000-\u001f]/.test(value)) return false;
    const parts = value.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) return false;
    return IMAGE_EXT.test(value);
  }

  // Returns a valid background or null. Missing or invalid fit, position, and dim fall back to defaults.
  // Also reads the shape stored in the browser before 1.0.0: { source: "url", value }.
  function normalizeBackground(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const image = typeof raw.image === "string" ? raw.image.trim()
      : raw.source === "url" && typeof raw.value === "string" ? raw.value.trim() : "";
    if (!image || !(isHttpUrl(image) || isImagePath(image))) return null;
    const fit = BG_FITS.includes(raw.fit) ? raw.fit : "cover";
    const position = BG_POSITIONS.includes(raw.position) ? raw.position : "center";
    const n = Number(raw.dim);
    const dim = Number.isFinite(n) && raw.dim !== null && raw.dim !== ""
      ? Math.min(70, Math.max(0, Math.round(n / 5) * 5))
      : 30;
    return { image, fit, position, dim };
  }

  // The file name a picked image is shared under: its own name, with anything a path cannot hold replaced.
  function imageFileName(name) {
    const base = String(name || "").split(/[\\/]/).pop().replace(/[\\:*?"<>|\u0000-\u001f]/g, "-").trim();
    const safe = base && base !== "." && base !== ".." ? base.slice(-120) : "";
    return IMAGE_EXT.test(safe) ? safe : `${safe || "background"}.png`;
  }

  // Whole days from `fromIso` to `iso` (both YYYY-MM-DD), using calendar dates so DST does not matter.
  function daysBetween(fromIso, iso) {
    const [y1, m1, d1] = fromIso.split("-").map(Number);
    const [y2, m2, d2] = iso.split("-").map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  }

  // Short, friendly due-date text: "Today", "Tomorrow", "Yesterday", "In 3 days", "3 days ago",
  // or a date ("Nov 20", with the year only when it differs from the current year).
  function relativeDue(iso, todayIso = today()) {
    const diff = daysBetween(todayIso, iso);
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff === -1) return "Yesterday";
    if (diff > 1 && diff <= 6) return `In ${diff} days`;
    if (diff < -1 && diff >= -6) return `${-diff} days ago`;
    const [y, m, d] = iso.split("-").map(Number);
    const sameYear = y === Number(todayIso.slice(0, 4));
    return new Date(y, m - 1, d).toLocaleDateString("en-US", {
      month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }),
    });
  }

  // "overdue" (past and not completed), "soon" (today through 2 days out), or "" (no flag).
  function dueState(dueDate, isDone, todayIso = today()) {
    if (!dueDate || isDone) return "";
    const diff = daysBetween(todayIso, dueDate);
    if (diff < 0) return "overdue";
    if (diff <= 2) return "soon";
    return "";
  }

  // ---------- Normalization (stored data and imports) ----------
  function normalizeStatus(s, index) {
    const name = str(s && s.name);
    if (!name) throw new Error(`Status #${index + 1} is missing a name.`);
    return {
      id: str(s.id) || slugify(name),
      name,
      color: typeof s.color === "string" && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : DEFAULT_COLOR,
      done: s.done === true,
    };
  }

  // Removes duplicate names and makes ids unique.
  function dedupeStatuses(list) {
    const ids = new Set();
    const names = new Set();
    const out = [];
    for (const s of list) {
      const key = s.name.toLowerCase();
      if (names.has(key)) continue;
      names.add(key);
      s.id = uniqueId(s.id, ids);
      ids.add(s.id);
      out.push(s);
    }
    return out;
  }

  function normalizeComment(c) {
    return {
      id: c.id != null && String(c.id).trim() ? String(c.id) : uid(),
      text: str(c.text),
      createdAt: typeof c.createdAt === "string" ? c.createdAt : new Date().toISOString(),
    };
  }

  function normalizeTask(t, n) {
    if (!t || typeof t !== "object") throw new Error(`Task #${n} is not an object.`);
    const title = str(t.title);
    if (!title) throw new Error(`Task #${n} is missing a title.`);
    const now = new Date().toISOString();
    const list = (v) => (Array.isArray(v) ? v : []);
    return {
      id: t.id != null && String(t.id).trim() ? String(t.id) : uid(),
      title,
      description: str(t.description),
      assignedTo: str(t.assignedTo),
      dueDate: isDateString(t.dueDate) ? t.dueDate : "",
      priority: PRIORITIES.find((p) => p.toLowerCase() === String(t.priority ?? "").toLowerCase()) || "Medium",
      attachments: list(t.attachments)
        .map((a) => str(a && typeof a === "object" ? a.url : a))
        .filter(Boolean),
      comments: list(t.comments)
        .filter((c) => c && typeof c === "object")
        .map(normalizeComment)
        .filter((c) => c.text),
      statusRef: str(t.status),
      createdAt: typeof t.createdAt === "string" ? t.createdAt : now,
      updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : now,
    };
  }

  // Brings older formats up to FORMAT_VERSION and rejects files from a newer version.
  // A bare array or an object without "version" is treated as version 1 (the first format).
  function migrate(data) {
    if (Array.isArray(data) || !data || typeof data !== "object") return data;
    if (data.format !== undefined && data.format !== FORMAT) {
      throw new Error(`This file is not a kanban board export (format "${String(data.format)}").`);
    }
    const version = data.version === undefined ? 1 : Number(data.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`Unknown board format version "${String(data.version)}".`);
    }
    if (version > FORMAT_VERSION) {
      throw new Error(
        `This file was made by a newer version of the board (format ${version}). ` +
        `This version reads format ${FORMAT_VERSION} and older.`
      );
    }
    // Format 1 needs no rewrite: parseWorkspace turns a format-1 board into a one-project workspace.
    return data;
  }

  // Turns parsed JSON into { statuses, tasks }. Accepts either an array of tasks
  // or an object with "tasks" and optional "statuses" arrays.
  function parseBoardData(input) {
    const data = migrate(input);
    let rawTasks;
    let rawStatuses;
    if (Array.isArray(data)) {
      rawTasks = data;
    } else if (data && typeof data === "object" && Array.isArray(data.tasks)) {
      rawTasks = data.tasks;
      rawStatuses = data.statuses;
    } else {
      throw new Error('The file must contain an array of tasks, or an object with a "tasks" array.');
    }
    const statuses = Array.isArray(rawStatuses)
      ? dedupeStatuses(rawStatuses.map((s, i) => normalizeStatus(s, i)))
      : [];
    const tasks = rawTasks.map((t, i) => normalizeTask(t, i + 1));
    return { statuses, tasks };
  }

  // Finds the status id for a reference (id or name). Creates the status if unknown.
  function resolveStatus(statuses, ref) {
    if (ref) {
      const lower = ref.toLowerCase();
      const found = statuses.find((s) => s.id === ref) || statuses.find((s) => s.name.toLowerCase() === lower);
      if (found) return found.id;
      const id = uniqueId(slugify(ref), new Set(statuses.map((s) => s.id)));
      statuses.push({ id, name: ref, color: PALETTE[statuses.length % PALETTE.length], done: false });
      return id;
    }
    return statuses[0].id;
  }

  // Combines incoming data with a base board. mode: "replace" or "add".
  function combine(base, incoming, mode) {
    let statuses;
    if (mode === "replace") {
      statuses = incoming.statuses.length ? clone(incoming.statuses) : clone(base.statuses);
    } else {
      statuses = clone(base.statuses);
      for (const s of incoming.statuses) {
        const exists = statuses.some(
          (x) => x.id === s.id || x.name.toLowerCase() === s.name.toLowerCase()
        );
        if (!exists) statuses.push(clone(s));
      }
    }
    if (!statuses.length) statuses = defaultStatuses();

    const tasks = mode === "add" ? clone(base.tasks) : [];
    const takenIds = new Set(tasks.map((t) => t.id));
    for (const incomingTask of incoming.tasks) {
      const task = { ...incomingTask };
      if (takenIds.has(task.id)) task.id = uid();   // avoid id collisions
      takenIds.add(task.id);
      task.status = resolveStatus(statuses, task.statusRef);
      delete task.statusRef;
      tasks.push(task);
    }
    return { statuses, tasks };
  }

  // The array order of board.tasks is the card order inside each column.
  // Moves a task to statusId, placed before beforeId (a task in that column) or at the end of the column.
  // Returns true when the status or the position changed.
  function moveTask(board, taskId, statusId, beforeId = null) {
    const tasks = board.tasks;
    const from = tasks.findIndex((t) => t.id === taskId);
    if (from < 0) return false;
    const task = tasks[from];
    const oldStatus = task.status;
    tasks.splice(from, 1);

    let to = -1;
    if (beforeId && beforeId !== taskId) to = tasks.findIndex((t) => t.id === beforeId && t.status === statusId);
    if (to < 0) {
      let last = -1;
      tasks.forEach((t, i) => { if (t.status === statusId) last = i; });
      to = last < 0 ? tasks.length : last + 1;
    }
    tasks.splice(to, 0, task);
    task.status = statusId;
    return oldStatus !== statusId || to !== from;
  }

  // Swaps a task with its neighbor (-1 up, +1 down) among `visibleIds` (the cards shown in its column).
  // Returns true when it moved.
  function reorderTask(board, taskId, offset, visibleIds) {
    const pos = visibleIds.indexOf(taskId);
    const otherId = visibleIds[pos + offset];
    if (pos < 0 || !otherId) return false;
    const a = board.tasks.findIndex((t) => t.id === taskId);
    const b = board.tasks.findIndex((t) => t.id === otherId);
    [board.tasks[a], board.tasks[b]] = [board.tasks[b], board.tasks[a]];
    return true;
  }

  // ---------- Workspace: projects and workers ----------
  // A workspace holds every project (each one a board: statuses + tasks) and one workers list shared by all.
  // { activeProjectId, workers: [name], projects: [{ id, name, statuses, tasks }] }

  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

  // Trimmed, unique (ignoring case), sorted names.
  function normalizeWorkers(list) {
    const out = [];
    for (const w of Array.isArray(list) ? list : []) {
      const name = str(w && typeof w === "object" ? w.name : w);
      if (name && !out.some((x) => sameName(x, name))) out.push(name);
    }
    return out.sort(byName);
  }

  // Adds a name unless it is already there (ignoring case). Returns the stored spelling.
  function addWorker(workers, name) {
    const clean = str(name);
    if (!clean) return "";
    const found = workers.find((w) => sameName(w, clean));
    if (found) return found;
    workers.push(clean);
    workers.sort(byName);
    return clean;
  }

  // "Name", or "Name (2)", "Name (3)"… when the name is taken (ignoring case).
  function uniqueName(name, takenNames) {
    const taken = new Set([...takenNames].map((n) => n.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    let n = 2;
    while (taken.has(`${name} (${n})`.toLowerCase())) n++;
    return `${name} (${n})`;
  }

  const DEFAULT_PROJECT_NAME = "Kanban Board";

  const newProject = (name) => ({ id: uid(), name, statuses: defaultStatuses(), tasks: [] });

  // Normalizes one project (or a format-1 board) into { id, name, statuses, tasks }.
  function buildProject(raw, fallbackName) {
    const source = Array.isArray(raw) ? { tasks: raw } : raw;
    const name = str(source && source.name) || fallbackName;
    let parsed;
    try {
      parsed = parseBoardData(source);
    } catch (err) {
      throw new Error(`Project "${name}": ${err.message}`);
    }
    const board = combine({ statuses: defaultStatuses(), tasks: [] }, parsed, "replace");
    const project = { id: str(source.id) || uid(), name, statuses: board.statuses, tasks: board.tasks };
    const background = normalizeBackground(source.background);
    if (background) project.background = background;
    return project;
  }

  // Turns parsed JSON into a workspace. Format 2 has a "projects" array; format 1 (a single board,
  // or a bare array of tasks) becomes one project named fallbackName.
  function parseWorkspace(input, fallbackName = DEFAULT_PROJECT_NAME) {
    const data = migrate(input);
    let projects;
    let workers;
    let activeProjectId = null;
    const isWorkspace = data && !Array.isArray(data) && typeof data === "object" && Array.isArray(data.projects);

    if (isWorkspace) {
      if (!data.projects.length) throw new Error("The file contains no projects.");
      projects = data.projects.map((p, i) => {
        if (!p || typeof p !== "object") throw new Error(`Project #${i + 1} is not an object.`);
        return buildProject(p, `Project ${i + 1}`);
      });
      activeProjectId = str(data.activeProjectId) || null;
    } else {
      projects = [buildProject(data, fallbackName)];
    }

    const ids = new Set();
    const names = [];
    for (const p of projects) {
      p.id = uniqueId(p.id, ids);
      ids.add(p.id);
      p.name = uniqueName(p.name, names);
      names.push(p.name);
    }

    if (isWorkspace && Array.isArray(data.workers)) {
      workers = normalizeWorkers(data.workers);
    } else {
      // Older data has no workers list: start one from the names already assigned to tasks.
      workers = [];
      for (const p of projects) for (const t of p.tasks) addWorker(workers, t.assignedTo);
    }

    if (!projects.some((p) => p.id === activeProjectId)) activeProjectId = projects[0].id;
    const ws = { activeProjectId, workers, projects };
    const background = isWorkspace ? normalizeBackground(data.background) : null;
    if (background) ws.background = background;
    return ws;
  }

  // Brings projects into a workspace. Mode "add" adds them as new projects, "replace" makes them the only
  // projects, and "update" overwrites the projects with the same id in place and adds the others.
  // Ids and names are made unique; workers are merged. The background for every project is taken from
  // the file on "replace", and otherwise only when the workspace has none.
  // Returns the projects as added or updated (with final names).
  function addProjects(ws, incoming, mode, incomingWorkers = [], incomingBackground = null) {
    const added = [];
    const base = mode === "replace" ? [] : ws.projects.slice();
    const updated = new Set();
    if (mode === "update") {
      for (const src of incoming) {
        const i = base.findIndex((p) => p.id === src.id);
        if (i === -1 || updated.has(src.id)) continue;
        const p = clone(src);
        p.name = uniqueName(p.name, base.filter((_, j) => j !== i).map((q) => q.name));
        base[i] = p;
        updated.add(p.id);
        added.push(p);
      }
    }
    const ids = new Set(base.map((p) => p.id));
    const names = base.map((p) => p.name);
    for (const src of incoming) {
      if (updated.has(src.id)) continue;
      const p = clone(src);
      if (ids.has(p.id)) p.id = uid();
      ids.add(p.id);
      p.name = uniqueName(p.name, names);
      names.push(p.name);
      base.push(p);
      added.push(p);
    }
    ws.projects = base;
    for (const w of incomingWorkers) addWorker(ws.workers, w);
    for (const p of added) for (const t of p.tasks) addWorker(ws.workers, t.assignedTo);
    const background = normalizeBackground(incomingBackground);
    if (background && (mode === "replace" || !ws.background)) ws.background = background;
    if (!ws.projects.some((p) => p.id === ws.activeProjectId)) ws.activeProjectId = ws.projects[0].id;
    return added;
  }

  // Tasks in all projects assigned to `name` (ignoring case).
  function countAssigned(ws, name) {
    let n = 0;
    for (const p of ws.projects) for (const t of p.tasks) if (t.assignedTo && sameName(t.assignedTo, name)) n++;
    return n;
  }

  // Renames a worker on every task in every project. Returns how many tasks changed.
  function renameWorker(ws, oldName, newName) {
    let n = 0;
    for (const p of ws.projects) {
      for (const t of p.tasks) {
        if (t.assignedTo && sameName(t.assignedTo, oldName) && t.assignedTo !== newName) {
          t.assignedTo = newName;
          n++;
        }
      }
    }
    return n;
  }

  // Compares "1.2.3"-style versions part by part: negative when a < b, 0 when equal, positive when a > b.
  // Missing or non-numeric parts count as 0.
  function compareVersions(a, b) {
    const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  // A warning for a file saved by a different app version, or "" when the versions match.
  // Files from before 1.0.0 have no "appVersion".
  function versionNotice(data, current = APP_VERSION) {
    const saved = data && typeof data === "object" && !Array.isArray(data) ? str(data.appVersion) : "";
    if (!saved) {
      return `This file was saved by an older version of the app (before v${current}). ` +
        "It can still be imported; check the projects afterward.";
    }
    const diff = compareVersions(saved, current);
    if (diff === 0) return "";
    if (diff > 0) {
      return `This file was saved by a newer version of the app (v${saved}); this is v${current}. ` +
        "Anything this version does not know about will be left out.";
    }
    return `This file was saved by an older version of the app (v${saved}); this is v${current}. ` +
      "It can still be imported; check the projects afterward.";
  }

  // The object written to storage and to export files.
  const serializeWorkspace = (ws, extra = {}) => ({
    format: FORMAT,
    version: FORMAT_VERSION,
    appVersion: APP_VERSION,
    ...extra,
    activeProjectId: ws.activeProjectId,
    workers: ws.workers,
    ...(ws.background ? { background: ws.background } : {}),
    projects: ws.projects.map((p) => ({
      id: p.id, name: p.name, ...(p.background ? { background: p.background } : {}), statuses: p.statuses, tasks: p.tasks,
    })),
  });

  const api = {
    FORMAT, FORMAT_VERSION, APP_VERSION, PRIORITIES, DEFAULT_COLOR, PALETTE, DEFAULT_PROJECT_NAME, defaultStatuses,
    uid, clone, str, pad, isDateString, esc, today, toIsoDate, slugify, uniqueId, isHttpUrl,
    BG_FITS, BG_POSITIONS, isImagePath, normalizeBackground, imageFileName,
    daysBetween, relativeDue, dueState,
    normalizeStatus, dedupeStatuses, normalizeComment, normalizeTask, migrate, parseBoardData,
    resolveStatus, combine, moveTask, reorderTask,
    normalizeWorkers, addWorker, uniqueName, newProject, buildProject, parseWorkspace, addProjects,
    countAssigned, renameWorker, serializeWorkspace, compareVersions, versionNotice,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KanbanModel = api;
})(typeof window !== "undefined" ? window : globalThis);
