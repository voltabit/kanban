// Unit tests for js/model.js. Run from the project folder with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../js/model.js");

const board = (tasks, statuses = M.defaultStatuses()) => ({ statuses, tasks });
const task = (id, status, extra = {}) => ({ id, title: id, status, ...extra });
const ids = (b) => b.tasks.map((t) => t.id);

test("normalizeTask trims, defaults, and matches priority case-insensitively", () => {
  const t = M.normalizeTask({ title: "  Fix bug ", priority: "high", dueDate: "2026-13", attachments: ["", " https://a.b "] }, 1);
  assert.equal(t.title, "Fix bug");
  assert.equal(t.priority, "High");
  assert.equal(t.dueDate, "");
  assert.deepEqual(t.attachments, ["https://a.b"]);
  assert.ok(t.id);
});

test("normalizeTask rejects a task without a title", () => {
  assert.throws(() => M.normalizeTask({ title: "  " }, 3), /Task #3 is missing a title/);
  assert.throws(() => M.normalizeTask(null, 2), /Task #2 is not an object/);
});

test("parseBoardData accepts an array or an object with tasks, and dedupes statuses", () => {
  assert.equal(M.parseBoardData([{ title: "a" }]).tasks.length, 1);
  const r = M.parseBoardData({
    tasks: [],
    statuses: [{ name: "Doing", id: "x" }, { name: "doing" }, { name: "Next", id: "x" }],
  });
  assert.deepEqual(r.statuses.map((s) => [s.id, s.name]), [["x", "Doing"], ["x-2", "Next"]]);
  assert.throws(() => M.parseBoardData({ foo: 1 }), /must contain an array/);
});

test("migrate: missing version is v1; newer versions and foreign formats are rejected", () => {
  assert.doesNotThrow(() => M.parseBoardData({ tasks: [] }));
  assert.doesNotThrow(() => M.parseBoardData({ format: "kanban-board", version: 1, tasks: [] }));
  assert.throws(() => M.parseWorkspace({ format: "kanban-board", version: M.FORMAT_VERSION + 1, projects: [] }), /newer version/);
  assert.throws(() => M.parseBoardData({ format: "trello", tasks: [] }), /not a kanban board export/);
  assert.throws(() => M.parseBoardData({ version: "abc", tasks: [] }), /Unknown board format version/);
});

// ---------- Workspace ----------
const rawTask = (title, status, assignedTo = "") => ({ title, status, assignedTo });

test("parseWorkspace turns a format-1 board into one project and seeds workers from assignees", () => {
  const ws = M.parseWorkspace({ format: "kanban-board", version: 1, tasks: [rawTask("a", "todo", "Ann"), rawTask("b", "done", "ann ")] }, "Old board");
  assert.equal(ws.projects.length, 1);
  assert.equal(ws.projects[0].name, "Old board");
  assert.equal(ws.activeProjectId, ws.projects[0].id);
  assert.deepEqual(ws.workers, ["Ann"]);
  assert.equal(ws.projects[0].tasks[1].status, "done");
});

test("parseWorkspace accepts a bare array of tasks", () => {
  const ws = M.parseWorkspace([rawTask("a")]);
  assert.equal(ws.projects[0].name, M.DEFAULT_PROJECT_NAME);
  assert.equal(ws.projects[0].tasks.length, 1);
});

test("parseWorkspace reads format 2: unique ids and names, workers list kept as given", () => {
  const ws = M.parseWorkspace({
    format: "kanban-board", version: 2, activeProjectId: "p2",
    workers: ["bob", "Ann", "ann", ""],
    projects: [
      { id: "p1", name: "Site", tasks: [rawTask("a", "todo", "Zed")] },
      { id: "p1", name: "site", tasks: [] },
      { id: "p2", name: "", tasks: [] },
    ],
  });
  assert.deepEqual(ws.projects.map((p) => p.id), ["p1", "p1-2", "p2"]);
  assert.deepEqual(ws.projects.map((p) => p.name), ["Site", "site (2)", "Project 3"]);
  assert.deepEqual(ws.workers, ["Ann", "bob"], "explicit list is not re-seeded from assignees");
  assert.equal(ws.activeProjectId, "p2");
});

test("parseWorkspace errors name the project and reject empty files", () => {
  assert.throws(() => M.parseWorkspace({ version: 2, projects: [] }), /no projects/);
  assert.throws(() => M.parseWorkspace({ version: 2, projects: [{ name: "X", tasks: [{ title: "" }] }] }), /Project "X": Task #1 is missing a title/);
});

test("serializeWorkspace round-trips through parseWorkspace", () => {
  const ws = M.parseWorkspace({ version: 2, workers: ["Ann"], projects: [{ id: "a", name: "A", tasks: [rawTask("t", "review", "Ann")] }] });
  const again = M.parseWorkspace(JSON.parse(JSON.stringify(M.serializeWorkspace(ws))));
  assert.equal(M.serializeWorkspace(ws).version, M.FORMAT_VERSION);
  assert.deepEqual(again, ws);
});

test("addProjects add mode renames clashes and merges workers; replace mode swaps all", () => {
  const ws = { activeProjectId: "a", workers: ["Ann"], projects: [{ id: "a", name: "Site", statuses: M.defaultStatuses(), tasks: [] }] };
  const incoming = [{ id: "a", name: "site", statuses: M.defaultStatuses(), tasks: [{ ...task("t", "todo"), assignedTo: "Cy" }] }];
  const added = M.addProjects(ws, incoming, "add", ["Bo"]);
  assert.equal(ws.projects.length, 2);
  assert.equal(added[0].name, "site (2)");
  assert.notEqual(added[0].id, "a");
  assert.deepEqual(ws.workers, ["Ann", "Bo", "Cy"]);
  assert.equal(ws.activeProjectId, "a");

  M.addProjects(ws, incoming, "replace");
  assert.deepEqual(ws.projects.map((p) => p.name), ["site"]);
  assert.equal(ws.activeProjectId, ws.projects[0].id);
});

test("addWorker, uniqueName, countAssigned, renameWorker", () => {
  const workers = ["Bo"];
  assert.equal(M.addWorker(workers, " ann "), "ann");
  assert.equal(M.addWorker(workers, "ANN"), "ann", "existing spelling wins");
  assert.deepEqual(workers, ["ann", "Bo"]);
  assert.equal(M.uniqueName("A", ["a", "A (2)"]), "A (3)");
  const ws = { projects: [{ tasks: [{ assignedTo: "ann" }, { assignedTo: "Bo" }] }, { tasks: [{ assignedTo: "ANN" }] }] };
  assert.equal(M.countAssigned(ws, "Ann"), 2);
  assert.equal(M.renameWorker(ws, "ann", "Anna"), 2);
  assert.equal(ws.projects[1].tasks[0].assignedTo, "Anna");
});

test("combine add keeps existing tasks, renames colliding ids, and creates unknown statuses", () => {
  const base = board([task("a", "todo")]);
  const incoming = { statuses: [], tasks: [{ ...task("a"), statusRef: "Blocked" }] };
  const out = M.combine(base, incoming, "add");
  assert.equal(out.tasks.length, 2);
  assert.notEqual(out.tasks[1].id, "a");
  assert.equal(out.statuses.at(-1).name, "Blocked");
  assert.equal(out.tasks[1].status, out.statuses.at(-1).id);
  assert.equal(base.tasks.length, 1, "base is not mutated");
});

test("combine replace drops existing tasks and falls back to base statuses", () => {
  const out = M.combine(board([task("a", "todo")]), { statuses: [], tasks: [{ ...task("b"), statusRef: "" }] }, "replace");
  assert.deepEqual(ids(out), ["b"]);
  assert.equal(out.tasks[0].status, "todo");
});

test("moveTask places a card before another card in the target column", () => {
  const b = board([task("a", "todo"), task("b", "done"), task("c", "done")]);
  assert.equal(M.moveTask(b, "a", "done", "c"), true);
  assert.deepEqual(ids(b), ["b", "a", "c"]);
  assert.equal(b.tasks[1].status, "done");
});

test("moveTask without beforeId appends to the end of the column", () => {
  const b = board([task("a", "todo"), task("b", "done"), task("x", "todo")]);
  M.moveTask(b, "a", "done");
  assert.deepEqual(ids(b), ["b", "a", "x"]);
});

test("moveTask into an empty column and no-op detection", () => {
  const b = board([task("a", "todo"), task("b", "todo")]);
  M.moveTask(b, "a", "review");
  assert.equal(b.tasks.find((t) => t.id === "a").status, "review");
  const c = board([task("a", "todo"), task("b", "todo")]);
  assert.equal(M.moveTask(c, "b", "todo"), false, "already last in its column");
  assert.equal(M.moveTask(c, "a", "todo", "b"), false, "already right before b");
  assert.equal(M.moveTask(c, "b", "todo", "a"), true);
  assert.deepEqual(ids(c), ["b", "a"]);
});

test("reorderTask swaps with the visible neighbor only", () => {
  const b = board([task("a", "todo"), task("hidden", "todo"), task("c", "todo")]);
  assert.equal(M.reorderTask(b, "c", -1, ["a", "c"]), true);
  assert.deepEqual(ids(b), ["c", "hidden", "a"]);
  assert.equal(M.reorderTask(b, "c", -1, ["c", "a"]), false);
});

test("relativeDue and dueState", () => {
  const today = "2026-11-06";
  assert.equal(M.relativeDue("2026-11-06", today), "Today");
  assert.equal(M.relativeDue("2026-11-07", today), "Tomorrow");
  assert.equal(M.relativeDue("2026-11-05", today), "Yesterday");
  assert.equal(M.relativeDue("2026-11-10", today), "In 4 days");
  assert.equal(M.relativeDue("2026-11-01", today), "5 days ago");
  assert.equal(M.relativeDue("2026-11-20", today), "Nov 20");
  assert.equal(M.relativeDue("2027-01-02", today), "Jan 2, 2027");
  assert.equal(M.dueState("2026-11-05", false, today), "overdue");
  assert.equal(M.dueState("2026-11-05", true, today), "");
  assert.equal(M.dueState("2026-11-08", false, today), "soon");
  assert.equal(M.dueState("2026-11-09", false, today), "");
  assert.equal(M.daysBetween("2026-03-28", "2026-03-30"), 2, "DST change does not matter");
});

test("saved and exported files carry the app version", () => {
  const ws = M.parseWorkspace({ tasks: [] });
  const out = M.serializeWorkspace(ws, { exportedAt: "x" });
  assert.equal(out.appVersion, M.APP_VERSION);
  assert.equal(out.version, M.FORMAT_VERSION);
  assert.equal(M.versionNotice(out), "", "same version: no warning");
});

test("compareVersions compares part by part", () => {
  assert.ok(M.compareVersions("1.0.0", "1.0.0") === 0);
  assert.ok(M.compareVersions("1.0", "1.0.0") === 0);
  assert.ok(M.compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(M.compareVersions("0.9.0", "1.0.0") < 0);
});

test("versionNotice warns about files from other app versions", () => {
  assert.match(M.versionNotice({ tasks: [] }, "1.0.0"), /older version.*before v1\.0\.0/);
  assert.match(M.versionNotice([], "1.0.0"), /older version/);
  assert.match(M.versionNotice({ appVersion: "0.9.1" }, "1.0.0"), /older version.*v0\.9\.1.*this is v1\.0\.0/);
  assert.match(M.versionNotice({ appVersion: "1.2.0" }, "1.0.0"), /newer version.*v1\.2\.0/);
  assert.equal(M.versionNotice({ appVersion: "1.0.0" }, "1.0.0"), "");
});

test("esc escapes HTML special characters", () => {
  assert.equal(M.esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

test("isImagePath accepts relative image paths only", () => {
  for (const ok of ["orange.jpeg", "img/orange.JPG", "my pics/a b.webp"]) assert.equal(M.isImagePath(ok), true, ok);
  for (const bad of ["../x.png", "/x.png", "C:/x.png", "a\b.png", "javascript:x.png", "img//a.png", "./a.png", "notes.txt", ""]) {
    assert.equal(M.isImagePath(bad), false, bad);
  }
});

test("normalizeBackground keeps valid backgrounds and fills defaults", () => {
  assert.deepEqual(M.normalizeBackground({ image: "img/a.png" }), { image: "img/a.png", fit: "cover", position: "center", dim: 30 });
  assert.deepEqual(M.normalizeBackground({ image: "https://x.test/a.jpg", fit: "tile", position: "top", dim: 42 }),
    { image: "https://x.test/a.jpg", fit: "tile", position: "top", dim: 40 });
  assert.deepEqual(M.normalizeBackground({ source: "url", value: "https://x.test/a.jpg" }).image, "https://x.test/a.jpg");
  assert.equal(M.normalizeBackground({ source: "file", value: "data:image/png;base64,AAAA" }), null);
  assert.equal(M.normalizeBackground({ image: "../secret.png" }), null);
  assert.equal(M.normalizeBackground("a.png"), null);
});

test("imageFileName turns a picked file's name into a shareable one", () => {
  assert.equal(M.imageFileName("orange.jpeg"), "orange.jpeg");
  assert.equal(M.imageFileName("what?.png"), "what-.png");
  assert.equal(M.imageFileName("photo.heic"), "photo.heic.png");
  assert.equal(M.imageFileName(""), "background.png");
});

test("backgrounds travel through serialize and parse", () => {
  const ws = M.parseWorkspace({
    format: "kanban-board", version: 2, workers: [],
    background: { image: "img/all.png", dim: 10 },
    projects: [
      { id: "a", name: "A", background: { image: "a.jpg" }, statuses: [], tasks: [] },
      { id: "b", name: "B", background: { image: "../bad.jpg" }, statuses: [], tasks: [] },
    ],
  });
  assert.equal(ws.background.image, "img/all.png");
  assert.equal(ws.projects[0].background.image, "a.jpg");
  assert.equal("background" in ws.projects[1], false);
  const again = M.parseWorkspace(JSON.parse(JSON.stringify(M.serializeWorkspace(ws))));
  assert.deepEqual(again, ws);
});

test("addProjects update overwrites matching projects in place and adds the rest", () => {
  const ws = {
    activeProjectId: "a", workers: ["Ann"],
    projects: [{ id: "a", name: "A", statuses: [], tasks: [] }, { id: "b", name: "B", statuses: [], tasks: [] }],
  };
  const incoming = [
    { id: "a", name: "A renamed", statuses: [], tasks: [task("t1", "todo", { assignedTo: "Bob" })] },
    { id: "c", name: "B", statuses: [], tasks: [] },
  ];
  const result = M.addProjects(ws, incoming, "update", [], { image: "x.png" });
  assert.deepEqual(ws.projects.map((p) => [p.id, p.name]), [["a", "A renamed"], ["b", "B"], ["c", "B (2)"]]);
  assert.equal(ws.projects[0].tasks.length, 1);
  assert.deepEqual(result.map((p) => p.id), ["a", "c"]);
  assert.deepEqual(ws.workers, ["Ann", "Bob"]);
  assert.equal(ws.background.image, "x.png");
  // A workspace that has its own background for every project keeps it, except on replace.
  M.addProjects(ws, [], "update", [], { image: "y.png" });
  assert.equal(ws.background.image, "x.png");
  M.addProjects(ws, [incoming[1]], "replace", [], { image: "y.png" });
  assert.equal(ws.background.image, "y.png");
});

test("addProjects add still makes copies of matching projects", () => {
  const ws = { activeProjectId: "a", workers: [], projects: [{ id: "a", name: "A", statuses: [], tasks: [] }] };
  M.addProjects(ws, [{ id: "a", name: "A", statuses: [], tasks: [] }], "add");
  assert.equal(ws.projects.length, 2);
  assert.notEqual(ws.projects[1].id, "a");
  assert.equal(ws.projects[1].name, "A (2)");
});
