/* Test Studio front-end: no build step, plain browser JavaScript. */
(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  const state = {
    view: "empty",
    section: "overview",
    actions: [],
    actionMap: new Map(),
    fields: {},
    tests: [],
    folders: [],
    file: null,
    test: null,
    dirty: false,
    search: "",
    statusFilter: "all",
    collapsedFolders: new Set(),
    suites: [],
    suiteFile: null,
    suite: null,
    suiteDirty: false,
    user: null,
    allUsers: [],
    recording: null,
    recordSource: null,
    featureCatalog: [],
    aiConfigured: false,
    report: null,
    notifications: [],
    unread: 0
  };

  // Does the signed-in user have this feature? Site admins always do.
  function can(feature) {
    if (!state.user) return false;
    if (state.user.role === "site_admin") return true;
    return (state.user.effectiveFeatures || []).includes(feature);
  }

  // ---------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------

  // For calls made after a session is established. A 401 here means the
  // session expired mid-use, so reload to fall back to the login screen.
  async function api(url, options = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options
    });
    if (res.status === 401) {
      toast("Session expired. Please log in again.", "error");
      setTimeout(() => location.reload(), 900);
      throw new Error("Session expired.");
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // For the auth forms themselves, where a 401 means "wrong credentials",
  // not "session expired" -- it must NOT trigger the reload-to-login above.
  async function authApi(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key === "value") node.value = value;
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  let toastTimer;
  function toast(message, kind = "") {
    const box = $("toast");
    box.textContent = message;
    box.className = `toast ${kind}`;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (box.hidden = true), 3200);
  }

  const fmtMs = ms => {
    if (ms === undefined || ms === null) return "";
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  };

  const fmtTime = iso => {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  };

  const fmtRelative = iso => {
    const diffMs = Date.now() - new Date(iso).getTime();
    const sec = Math.round(diffMs / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    return fmtTime(iso);
  };

  const ICONS = { pending: "", running: "…", passed: "✓", failed: "✕", skipped: "–" };

  function summarizeStep(step) {
    const parts = [];
    for (const key of ["selector", "url", "text", "value", "key", "pageName", "timeout"]) {
      if (step[key] !== undefined && step[key] !== "") parts.push(`${key}: ${step[key]}`);
    }
    return parts.join("  ·  ");
  }

  function setDirty(value) {
    state.dirty = value;
    $("dirty").hidden = !value;
  }

  // ---------------------------------------------------------
  // Confirm / prompt modal (native dialogs block this environment's
  // screenshot pipeline, so every confirm()/prompt() goes through here)
  // ---------------------------------------------------------

  function showDialog({ title, message, okLabel = "OK", danger = false, input = null }) {
    return new Promise(resolve => {
      const overlay = $("confirm-modal");
      const inputEl = $("confirm-input");
      const okBtn = $("confirm-ok");
      const cancelBtn = $("confirm-cancel");

      $("confirm-title").textContent = title;
      $("confirm-message").textContent = message;
      inputEl.hidden = !input;
      if (input) {
        inputEl.value = input.defaultValue || "";
        inputEl.placeholder = input.placeholder || "";
      }
      okBtn.textContent = okLabel;
      okBtn.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;

      const cleanup = result => {
        overlay.hidden = true;
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        overlay.removeEventListener("click", onOverlay);
        document.removeEventListener("keydown", onKey);
        resolve(result);
      };
      const onOk = () => cleanup(input ? inputEl.value : true);
      const onCancel = () => cleanup(input ? null : false);
      const onOverlay = e => { if (e.target === overlay) onCancel(); };
      const onKey = e => {
        if (e.key === "Escape") onCancel();
        else if (e.key === "Enter" && input) onOk();
      };

      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      overlay.addEventListener("click", onOverlay);
      document.addEventListener("keydown", onKey);

      overlay.hidden = false;
      if (input) {
        inputEl.focus();
        inputEl.select();
      } else {
        okBtn.focus();
      }
    });
  }

  function confirmDialog(message, opts = {}) {
    return showDialog({ title: opts.title || "Confirm", message, okLabel: opts.okLabel || "OK", danger: opts.danger });
  }

  function promptDialog(message, opts = {}) {
    return showDialog({
      title: opts.title || "",
      message,
      okLabel: opts.okLabel || "OK",
      input: { defaultValue: opts.defaultValue, placeholder: opts.placeholder }
    });
  }

  // ---------------------------------------------------------
  // Screenshot lightbox
  // ---------------------------------------------------------

  function openLightbox(src, caption) {
    closeLightbox();
    const box = el("div", { class: "lightbox", onclick: e => { if (e.target === box) closeLightbox(); } },
      el("div", { class: "lightbox-caption", text: caption }),
      el("button", { class: "lightbox-close", title: "Close (Esc)", onclick: closeLightbox }, "✕"),
      el("img", { src, alt: caption })
    );
    box.id = "lightbox";
    document.body.append(box);
  }

  function closeLightbox() {
    const box = $("lightbox");
    if (box) box.remove();
  }

  // ---------------------------------------------------------
  // Workspace navigation
  // ---------------------------------------------------------

  function switchTab(tab) {
    if (tab === "reports") { openReports(); return; }
    activateView(tab, tab === "overview" ? "empty" : `${tab}-panel`);
    location.hash = `view:${tab}`;
    if (tab === "overview") renderOverview();
  }

  function activateView(section, view) {
    state.section = section;
    state.view = view;
    for (const btn of document.querySelectorAll(".sidebar-tabs .tab")) {
      const active = btn.dataset.tab === section;
      btn.classList.toggle("active", active);
      if (active) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
    }
    for (const id of ["empty", "tests-panel", "suites-panel", "workspace", "suite-workspace", "reports-workspace"]) $(id).hidden = id !== view;
    $("page-label").textContent = { overview: "Overview", tests: "Test library", suites: "Suites", reports: "Reports" }[section];
    mobileNavigation(false);
  }

  function mobileNavigation(open) {
    const sidebar = document.querySelector(".sidebar");
    const mobile = window.matchMedia("(max-width: 760px)").matches;
    const wasOpen = sidebar.classList.contains("nav-open");
    open = mobile && open;
    sidebar.classList.toggle("nav-open", open);
    sidebar.inert = mobile && !open;
    $("main-content").inert = open;
    $("btn-mobile-browse").setAttribute("aria-expanded", String(open));
    $("nav-backdrop").hidden = !open;
    $("btn-mobile-browse").setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    if (open) (sidebar.querySelector("[aria-current='page']") || sidebar.querySelector("button")).focus();
    else if (wasOpen) $("btn-mobile-browse").focus();
  }

  // ---------------------------------------------------------
  // Test library, organized into a virtual folder tree
  // ---------------------------------------------------------

  async function loadTests() {
    state.tests = await api("/api/tests");
    renderTestList();
    renderOverview();
  }

  function renderOverview() {
    const tests = state.tests;
    const stats = [["Test cases", tests.length, "Across your workspace", "all"], ["Passed latest run", tests.filter(t => testStatus(t) === "passed").length, "Latest standalone results", "passed"], ["Need attention", tests.filter(t => t.error || testStatus(t) === "failed").length, "Failed or invalid tests", "attention"], ["Never run", tests.filter(t => !t.lastRun && !t.running).length, "Ready for a first run", "none"]];
    $("overview-stats").replaceChildren(...stats.map(([label, value, caption, filter]) => el("button", { class: `overview-stat stat-${filter}`, onclick: () => {
      state.statusFilter = filter;
      state.search = "";
      $("test-search").value = "";
      revealMatches();
      renderTestList();
      switchTab("tests");
    } }, el("span", { class: "stat-topline", text: label }), el("strong", { text: value }), el("span", { class: "stat-caption", text: caption }))));
    $("btn-overview-new").hidden = !can("tests.create");
    $("btn-overview-reports").hidden = !can("reports.view");
    const recent = [...tests].sort((a, b) => (b.lastRun?.startedAt || "").localeCompare(a.lastRun?.startedAt || "")).slice(0, 6);
    $("overview-recent").replaceChildren(...(recent.length ? recent.map(t => el("button", { class: "overview-test", onclick: () => openTest(t.file) },
      el("span", { class: "activity-name" }, el("strong", { text: t.name || t.file }), el("small", { text: t.meta?.folder || "Unfiled" })),
      el("span", { class: "activity-time", text: t.lastRun ? fmtRelative(t.lastRun.startedAt) : "—" }),
      el("span", { class: `badge ${t.error ? "failed" : testStatus(t)}`, text: t.error ? "Invalid" : testStatus(t) === "none" ? "Not run" : testStatus(t) })
    )) : [el("p", { class: "library-empty", text: "Start with your first test. Create one or import an existing test from the test library." })]));
  }

  async function loadFolders() {
    state.folders = await api("/api/folders");
    renderTestList();
  }

  function testStatus(t) {
    return t.running ? "running" : (t.lastRun ? t.lastRun.status : "none");
  }

  function visibleTests() {
    const q = state.search.trim().toLowerCase();
    return state.tests.filter(t => {
      if (state.statusFilter === "attention") { if (!t.error && testStatus(t) !== "failed") return false; }
      else if (state.statusFilter !== "all" && testStatus(t) !== state.statusFilter) return false;
      if (!q) return true;
      return [t.file, t.name || "", t.meta?.folder || ""].some(value => value.toLowerCase().includes(q));
    });
  }

  function buildTree(tests, folders) {
    const root = { name: "", path: "", folders: new Map(), tests: [] };
    const ensure = path => {
      if (!path) return root;
      const segments = path.split("/");
      let node = root;
      let acc = "";
      for (const seg of segments) {
        acc = acc ? `${acc}/${seg}` : seg;
        if (!node.folders.has(seg)) node.folders.set(seg, { name: seg, path: acc, folders: new Map(), tests: [] });
        node = node.folders.get(seg);
      }
      return node;
    };
    for (const f of folders) ensure(f);
    for (const t of tests) ensure(t.meta && t.meta.folder ? t.meta.folder : "").tests.push(t);
    return root;
  }

  function countTests(node) {
    let n = node.tests.length;
    for (const f of node.folders.values()) n += countTests(f);
    return n;
  }

  function pruneEmptyFolders(node) {
    for (const [name, folder] of [...node.folders]) {
      pruneEmptyFolders(folder);
      if (countTests(folder) === 0) node.folders.delete(name);
    }
  }

  function testRow(t, depth) {
    const status = testStatus(t);
    return el("li", {}, el("button", {
      class: `test-item${t.file === state.file ? " active" : ""}`,
      title: t.file,
      "aria-label": `Open test ${t.name || t.file}`,
      onclick: () => openTest(t.file)
    },
      el("span", { class: "library-name", style: `--depth:${Math.min(depth, 4)}` }, el("span", { class: "test-file-icon", "aria-hidden": "true", text: "✓" }), el("span", { class: "meta" },
        el("span", { class: "title" },
          t.name || t.file,
          t.meta && t.meta.visibility === "restricted" ? el("span", { class: "share-badge", title: "Restricted sharing" }, " 🔒") : null
        ),
        el("span", { class: "sub", text: t.error ? "Invalid test definition" : t.file })
      )),
      el("span", { class: "library-step-count", text: String(t.stepCount) }),
      el("span", { class: "library-last-run", text: t.lastRun ? fmtRelative(t.lastRun.startedAt) : "—" }),
      el("span", { class: `badge ${t.error ? "failed" : status}`, text: t.error ? "Invalid" : status === "none" ? "Not run" : status })
    ));
  }

  function renderFolderNode(node, depth) {
    const rows = [];
    const sortedFolders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of sortedFolders) {
      const collapsed = state.collapsedFolders.has(folder.path);
      rows.push(
        el("li", { class: "folder-row", style: `--depth:${Math.min(depth, 4)}` },
          el("button", { class: "folder-toggle", "data-folder": folder.path, "aria-expanded": String(!collapsed), "aria-label": `${collapsed ? "Expand" : "Collapse"} folder ${folder.path}`, onclick: () => toggleFolder(folder.path) },
            el("span", { "aria-hidden": "true", text: collapsed ? "▸" : "▾" }), el("span", { class: "folder-name", text: folder.name }), el("span", { class: "folder-count", text: String(countTests(folder)) })),
          el("div", { class: "folder-actions" },
            can("tests.create") ? el("button", { class: "btn-icon", title: "New test in this folder", onclick: () => createTest(folder.path) }, "+") : null,
            can("folders.manage") ? el("button", { class: "btn-icon", title: "New subfolder", onclick: () => createFolder(folder.path) }, "⊞") : null,
            can("folders.manage") && countTests(folder) === 0 ? el("button", { class: "btn-icon", title: "Delete this empty folder", onclick: () => deleteFolder(folder.path) }, "✕") : null
          )
        )
      );
      if (!collapsed) rows.push(...renderFolderNode(folder, depth + 1));
    }
    const sortedTests = [...node.tests].sort((a, b) => (a.name || a.file).localeCompare(b.name || b.file));
    for (const t of sortedTests) rows.push(testRow(t, depth));
    return rows;
  }

  function toggleFolder(path) {
    if (state.collapsedFolders.has(path)) state.collapsedFolders.delete(path);
    else state.collapsedFolders.add(path);
    renderTestList();
    [...document.querySelectorAll(".folder-toggle")].find(button => button.dataset.folder === path)?.focus();
  }

  function revealMatches() {
    for (const test of visibleTests()) {
      let folder = test.meta?.folder || "";
      while (folder) {
        state.collapsedFolders.delete(folder);
        folder = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
      }
    }
  }

  function renderTestList() {
    const list = $("test-tree");
    list.replaceChildren();
    $("nav-test-count").textContent = state.tests.length;
    $("library-count").textContent = state.tests.length;
    $("library-summary").replaceChildren(document.createTextNode(`${visibleTests().length} of ${state.tests.length} tests${state.statusFilter === "attention" ? " · Needs attention" : ""}`));
    if (state.statusFilter !== "all" || state.search) $("library-summary").append(el("button", { class: "btn-link", text: "Clear filters", onclick: () => { state.statusFilter = "all"; state.search = ""; $("test-search").value = ""; renderTestList(); } }));

    for (const chip of document.querySelectorAll("#status-filter .chip")) {
      const count = chip.dataset.filter === "all"
        ? state.tests.length
        : state.tests.filter(t => testStatus(t) === chip.dataset.filter).length;
      chip.textContent = `${chip.dataset.filter === "none" ? "Not run" : chip.dataset.filter[0].toUpperCase() + chip.dataset.filter.slice(1)} ${count}`;
      chip.classList.toggle("active", chip.dataset.filter === state.statusFilter);
      chip.setAttribute("aria-pressed", String(chip.dataset.filter === state.statusFilter));
    }

    if (!state.tests.length && !state.folders.length) {
      list.append(el("li", { class: "library-empty", text: "No tests yet. Create a test or import your existing JSON to get started." }));
      return;
    }

    const filtering = Boolean(state.search.trim()) || state.statusFilter !== "all";
    const visible = visibleTests();
    const tree = buildTree(visible, state.folders);
    if (filtering) pruneEmptyFolders(tree);

    const rows = renderFolderNode(tree, 0);
    if (!rows.length) {
      list.append(el("li", { class: "library-empty", text: "No matching tests. Try a different search or clear your filters." }));
      return;
    }
    for (const r of rows) list.append(r);
  }

  async function createFolder(parentPath) {
    const raw = await promptDialog("Folder name:", { title: "New folder", okLabel: "Create" });
    if (!raw || !raw.trim()) return;
    const full = parentPath ? `${parentPath}/${raw.trim()}` : raw.trim();
    try {
      await api("/api/folders", { method: "POST", body: JSON.stringify({ path: full }) });
      await loadFolders();
      toast(`Created folder ${full}`, "ok");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function deleteFolder(path) {
    const ok = await confirmDialog(`Delete the empty folder "${path}"?`, { title: "Delete folder", okLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await api(`/api/folders?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      await loadFolders();
      toast("Folder deleted", "ok");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  // ---------------------------------------------------------
  // Access mode (view vs edit, based on sharing settings)
  // ---------------------------------------------------------

  function applyAccessMode() {
    const readOnly = state.test.access !== "edit" || !can("tests.edit");
    $("test-fieldset").disabled = readOnly;
    $("test-name").disabled = readOnly;
    $("btn-save").disabled = readOnly;
    $("btn-move-folder").disabled = readOnly || !can("folders.manage");
    $("btn-record").hidden = readOnly || !can("tests.create");
    $("access-badge").hidden = !readOnly;

    const isOwnerOrAdmin = ["admin", "site_admin"].includes(state.user.role) ||
      (state.test.meta && state.test.meta.createdBy === state.user.username);
    $("btn-share").hidden = !isOwnerOrAdmin;
    $("btn-delete").hidden = !isOwnerOrAdmin || !can("tests.delete");
    $("btn-run").disabled = !can("tests.run");
  }

  function renderTestMeta() {
    const meta = state.test.meta || {};
    $("btn-move-folder").textContent = meta.folder ? `📁 ${meta.folder}` : "📁 No folder";
  }

  // ---------------------------------------------------------
  // Open / create / save / delete
  // ---------------------------------------------------------

  async function openTest(file, { force = false } = {}) {
    if (!force && file === state.file && state.test) {
      activateView("tests", "workspace");
      location.hash = encodeURIComponent(file);
      return;
    }
    if (!force && state.dirty && !(await confirmDialog("Discard unsaved changes?", { okLabel: "Discard", danger: true }))) return;
    try {
      state.test = await api(`/api/tests/${encodeURIComponent(file)}`);
    } catch (e) {
      toast(e.message, "error");
      return;
    }
    state.file = file;
    setDirty(false);
    location.hash = encodeURIComponent(file);
    activateView("tests", "workspace");

    $("test-name").value = state.test.name || "";
    $("test-description").value = state.test.description || "";
    $("test-file").textContent = `json/${file}`;

    renderTestMeta();
    applyAccessMode();
    renderSteps();
    renderTestList();

    testPanel.file = file;
    testPanel.kind = "test";
    detachRun(testPanel);
    await loadHistory(testPanel, { autoOpenLatest: true });
  }

  async function createTest(folder) {
    if (state.dirty && !(await confirmDialog("Discard unsaved test changes before creating another test?", { okLabel: "Discard", danger: true }))) return;
    const raw = await promptDialog("File name for the new test (saved in ./json):", {
      title: "New test",
      okLabel: "Create",
      defaultValue: "new-test.json"
    });
    if (!raw) return;
    try {
      const created = await api("/api/tests", {
        method: "POST",
        body: JSON.stringify({ file: raw.trim(), name: raw.trim().replace(/\.json$/i, ""), folder: folder || undefined })
      });
      await Promise.all([loadTests(), loadFolders()]);
      await openTest(created.file, { force: true });
      toast(`Created ${created.file}`, "ok");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function saveTest() {
    if (!state.file || !can("tests.edit") || state.test.access !== "edit") return false;
    $("test-validation").hidden = true;
    const body = {
      name: $("test-name").value,
      description: $("test-description").value,
      steps: state.test.steps
    };
    try {
      state.test = await api(`/api/tests/${encodeURIComponent(state.file)}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
      setDirty(false);
      renderSteps();
      renderTestMeta();
      await loadTests();
      toast("Saved", "ok");
      return true;
    } catch (e) {
      $("test-validation").textContent = e.message;
      $("test-validation").hidden = false;
      const match = /Step (\d+)/.exec(e.message);
      const card = match && $("steps").children[Number(match[1]) - 1];
      if (card) { card.classList.add("invalid"); card.scrollIntoView({ block: "nearest" }); card.querySelector("input, select")?.focus(); }
      toast(e.message, "error");
      return false;
    }
  }

  async function moveToFolder() {
    if (!state.file) return;
    const current = (state.test.meta && state.test.meta.folder) || "";
    const raw = await promptDialog(
      "Folder path (leave empty for no folder). Use / to nest, e.g. Sales/Deals:",
      { title: "Move to folder", okLabel: "Move", defaultValue: current }
    );
    if (raw === null) return;
    try {
      const res = await api(`/api/tests/${encodeURIComponent(state.file)}/folder`, {
        method: "PUT",
        body: JSON.stringify({ folder: raw.trim() })
      });
      state.test.meta = res.meta;
      renderTestMeta();
      await Promise.all([loadTests(), loadFolders()]);
      toast(raw.trim() ? `Moved to ${raw.trim()}` : "Moved to root", "ok");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function deleteTest() {
    if (!state.file) return;
    const ok = await confirmDialog(`Delete json/${state.file}? This removes the file from disk.`, {
      title: "Delete test",
      okLabel: "Delete",
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/api/tests/${encodeURIComponent(state.file)}`, { method: "DELETE" });
      toast(`Deleted ${state.file}`, "ok");
      state.file = null;
      state.test = null;
      setDirty(false);
      switchTab("tests");
      detachRun(testPanel);
      await Promise.all([loadTests(), loadFolders()]);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  // ---------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------

  let shareDraft = null;

  async function openShareModal() {
    if (!state.file) return;
    try {
      state.allUsers = await api("/api/users");
    } catch (e) {
      toast(e.message, "error");
      return;
    }
    const meta = state.test.meta || {};
    shareDraft = {
      visibility: meta.visibility === "restricted" ? "restricted" : "team",
      sharedWith: (meta.sharedWith || []).map(g => ({ ...g }))
    };
    $("share-file").textContent = state.file;
    $("share-link").value = `${location.origin}/#${encodeURIComponent(state.file)}`;
    renderShareModal();
    $("share-modal").hidden = false;
  }

  function closeShareModal() {
    $("share-modal").hidden = true;
    shareDraft = null;
  }

  function renderShareModal() {
    $("share-vis-team").checked = shareDraft.visibility === "team";
    $("share-vis-restricted").checked = shareDraft.visibility === "restricted";
    $("share-restricted-body").hidden = shareDraft.visibility !== "restricted";

    const addSelect = $("share-add-user");
    addSelect.replaceChildren(el("option", { value: "", text: "Add a person…" }));
    const already = new Set(shareDraft.sharedWith.map(g => g.username));
    for (const u of state.allUsers) {
      if (u.username === state.user.username || already.has(u.username)) continue;
      addSelect.append(el("option", { value: u.username, text: u.username }));
    }

    const list = $("share-list");
    list.replaceChildren();
    if (!shareDraft.sharedWith.length) {
      list.append(el("li", { class: "empty-history", text: "Not shared with anyone yet." }));
    }
    for (const g of shareDraft.sharedWith) {
      list.append(
        el("li", {},
          el("span", { class: "u-name", text: g.username }),
          el("span", { class: "u-role", text: g.permission === "edit" ? "Can edit" : "Can view" }),
          el("button", {
            class: "btn-icon",
            title: "Remove access",
            onclick: () => {
              shareDraft.sharedWith = shareDraft.sharedWith.filter(x => x.username !== g.username);
              renderShareModal();
            }
          }, "✕")
        )
      );
    }
  }

  async function saveSharing() {
    try {
      const res = await api(`/api/tests/${encodeURIComponent(state.file)}/sharing`, {
        method: "PUT",
        body: JSON.stringify({ visibility: shareDraft.visibility, sharedWith: shareDraft.sharedWith })
      });
      state.test.meta = res.meta;
      applyAccessMode();
      await loadTests();
      closeShareModal();
      toast("Sharing updated", "ok");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  // ---------------------------------------------------------
  // Step editor
  // ---------------------------------------------------------

  function renderSteps() {
    $("test-validation").hidden = true;
    const container = $("steps");
    container.replaceChildren();
    const steps = state.test.steps;
    $("step-count").textContent = steps.length ? `(${steps.length})` : "";
    if (!steps.length) {
      container.append(el("div", { class: "muted", text: "No steps. Add one to get started." }));
    }
    steps.forEach((step, i) => container.append(stepCard(step, i)));
  }

  function actionSelect(current) {
    const select = el("select");
    const groups = new Map();
    for (const spec of state.actions) {
      if (!groups.has(spec.group)) groups.set(spec.group, []);
      groups.get(spec.group).push(spec);
    }
    let known = false;
    for (const [group, specs] of groups) {
      const og = el("optgroup", { label: group });
      for (const spec of specs) {
        const opt = el("option", { value: spec.action, text: spec.action });
        const matches = spec.action === current || (spec.aliases || []).includes(current);
        if (matches) { opt.selected = true; known = true; }
        og.append(opt);
      }
      select.append(og);
    }
    if (!known) {
      const opt = el("option", { value: current, text: `${current} (unknown)` });
      opt.selected = true;
      select.prepend(opt);
    }
    return select;
  }

  function fieldInput(step, name, required, index) {
    const meta = state.fields[name] || { label: name, type: "text" };
    const label = el("label", {}, meta.label, required ? el("span", { class: "req", text: " *" }) : null);
    let input;
    const current = step[name] === undefined || step[name] === null ? "" : String(step[name]);

    if (meta.type === "select") {
      input = el("select");
      for (const opt of meta.options || []) {
        input.append(el("option", { value: opt, text: opt || "(default)" }));
      }
      input.value = current;
    } else {
      input = el("input", {
        type: meta.type === "number" ? "number" : "text",
        placeholder: meta.placeholder || "",
        class: ["selector", "url", "value", "text"].includes(name) ? "wide" : "",
        autocomplete: "off"
      });
      input.value = current;
    }

    input.addEventListener("input", () => {
      const v = input.value;
      if (v === "" && !["value", "text", "message", "promptText"].includes(name)) delete state.test.steps[index][name];
      else state.test.steps[index][name] = meta.type === "number" ? Number(v) : v;
      setDirty(true);
    });
    input.id = `step-${index}-${name}`;
    label.htmlFor = input.id;
    if (required) input.setAttribute("aria-required", "true");
    if (name === "timeout") { input.min = "1"; input.max = "600000"; }

    const wide = ["selector", "url", "value", "text"].includes(name);
    return el("div", { class: `field${wide ? " span-2" : ""}` }, label, input);
  }

  function stepCard(step, index) {
    const name = String(step.action || "").toLowerCase();
    const spec = state.actionMap.get(name);
    const body = el("div", { class: "step-body" });

    const shown = new Set();
    if (spec) {
      for (const f of spec.required) { body.append(fieldInput(step, f, true, index)); shown.add(f); }
      for (const f of spec.optional) { body.append(fieldInput(step, f, false, index)); shown.add(f); }
    }
    // Keep any extra keys the JSON already has so nothing is silently dropped.
    for (const key of Object.keys(step)) {
      if (key === "action" || shown.has(key)) continue;
      body.append(fieldInput(step, key, false, index));
    }
    if (!body.childElementCount) {
      body.append(el("div", { class: "muted", text: "This action takes no parameters." }));
    }

    const select = actionSelect(name);
    select.setAttribute("aria-label", `Step ${index + 1} action`);
    select.addEventListener("change", () => {
      state.test.steps[index].action = select.value;
      setDirty(true);
      renderSteps();
    });

    const move = (from, to) => {
      const steps = state.test.steps;
      if (to < 0 || to >= steps.length) return;
      [steps[from], steps[to]] = [steps[to], steps[from]];
      setDirty(true);
      renderSteps();
    };

    const head = el("div", { class: "step-head" },
      el("span", { class: "step-index", text: String(index + 1) }),
      select,
      el("span", { class: "step-desc", text: spec ? spec.description : "Not in the action catalog" }),
      el("div", { class: "step-tools" },
        el("button", { class: "btn-icon", title: "Move up", disabled: index === 0, onclick: () => move(index, index - 1) }, "↑"),
        el("button", { class: "btn-icon", title: "Move down", disabled: index === state.test.steps.length - 1, onclick: () => move(index, index + 1) }, "↓"),
        el("button", { class: "btn-icon", title: "Duplicate", onclick: () => {
          state.test.steps.splice(index + 1, 0, JSON.parse(JSON.stringify(step)));
          setDirty(true);
          renderSteps();
        } }, "⧉"),
        el("button", { class: "btn-icon", title: "Delete step", onclick: () => {
          state.test.steps.splice(index, 1);
          setDirty(true);
          renderSteps();
        } }, "✕")
      )
    );

    return el("div", { class: "step-card" }, head, body);
  }

  function addStep() {
    state.test.steps.push({ action: "click", selector: "" });
    setDirty(true);
    renderSteps();
    const container = $("steps");
    container.scrollTop = container.scrollHeight;
    const last = container.querySelector(".step-card:last-child input");
    if (last) last.focus();
  }

  // ---------------------------------------------------------
  // Generic run panel (used for both a single test's run and a suite's run)
  // ---------------------------------------------------------

  function makeRunPanel(prefix) {
    const withPrefix = suffix => prefix ? `${prefix}-${suffix}` : suffix;
    return {
      ids: {
        runStatus: withPrefix("run-status"), runEmpty: withPrefix("run-empty"), runBody: withPrefix("run-body"),
        btnRun: withPrefix("btn-run"), btnStop: withPrefix("btn-stop"),
        runSteps: withPrefix("run-steps"),
        viewerTitle: withPrefix("viewer-title"), viewerEmpty: withPrefix("viewer-empty"), viewerImg: withPrefix("viewer-img"),
        viewerError: withPrefix("viewer-error"), viewerErrorMessage: withPrefix("viewer-error-message"),
        btnAnalyze: withPrefix("btn-analyze"), aiNote: withPrefix("ai-note"), aiAnalysis: withPrefix("ai-analysis"),
        aiModel: withPrefix("ai-model"), aiSummary: withPrefix("ai-summary"), aiCause: withPrefix("ai-cause"), aiFix: withPrefix("ai-fix"),
        btnReanalyze: withPrefix("btn-reanalyze"),
        runLog: withPrefix("run-log"), history: withPrefix("history"),
        runReport: withPrefix("run-report")
      },
      kind: "test",
      file: null,
      run: null,
      runSource: null,
      selectedStep: null,
      follow: true
    };
  }

  const testPanel = makeRunPanel("");
  const suitePanel = makeRunPanel("suite");

  function pel(panel, key) { return $(panel.ids[key]); }

  function detachRun(panel) {
    if (panel.runSource) {
      panel.runSource.close();
      panel.runSource = null;
    }
    panel.run = null;
    panel.selectedStep = null;
    panel.reportFor = null;
    pel(panel, "runBody").hidden = true;
    pel(panel, "runEmpty").hidden = false;
    pel(panel, "runStatus").replaceChildren();
    pel(panel, "btnStop").hidden = true;
    pel(panel, "btnRun").disabled = !can(panel.kind === "suite" ? "suites.run" : "tests.run");
  }

  function attachRun(panel, id, { live }) {
    detachRun(panel);
    panel.follow = true;
    const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
    panel.runSource = source;

    source.addEventListener("snapshot", e => {
      panel.run = JSON.parse(e.data);
      renderRun(panel);
    });
    source.addEventListener("step", e => {
      if (!panel.run) return;
      const step = JSON.parse(e.data);
      panel.run.steps[step.index - 1] = step;
      renderRun(panel);
    });
    source.addEventListener("log", e => {
      if (!panel.run) return;
      const line = JSON.parse(e.data).line;
      panel.run.log.push(line);
      appendLog(panel, line);
    });
    source.addEventListener("done", e => {
      const done = JSON.parse(e.data);
      if (panel.run) Object.assign(panel.run, done, { log: panel.run.log });
      source.close();
      panel.runSource = null;
      renderRun(panel);
      if (panel === testPanel) loadTests(); else loadSuites();
      loadHistory(panel, { autoOpenLatest: false });
      if (live) toast(done.status === "passed" ? "Run passed" : "Run failed", done.status === "passed" ? "ok" : "error");
    });
    source.onerror = () => {
      if (panel.run && panel.run.status === "running") toast("Lost connection to the run stream", "error");
    };
  }

  function appendLog(panel, line) {
    const pre = pel(panel, "runLog");
    pre.textContent += (pre.textContent ? "\n" : "") + line;
    pre.scrollTop = pre.scrollHeight;
  }

  function renderRun(panel) {
    const run = panel.run;
    if (!run) return;
    pel(panel, "runEmpty").hidden = true;
    pel(panel, "runBody").hidden = false;

    const running = run.status === "running";
    pel(panel, "btnRun").disabled = running || !can(panel.kind === "suite" ? "suites.run" : "tests.run");
    pel(panel, "btnStop").hidden = !running || !can(panel.kind === "suite" ? "suites.run" : "tests.run") || (run.startedBy !== state.user.username && !["admin", "site_admin"].includes(state.user.role));

    const passedCount = run.steps.filter(s => s.status === "passed").length;
    pel(panel, "runStatus").replaceChildren(
      el("span", { class: `badge ${run.status}`, text: run.status }),
      el("span", { text: `${passedCount}/${run.steps.length} steps` }),
      el("span", { text: running ? `started ${fmtRelative(run.startedAt)}` : fmtMs(run.durationMs), title: fmtTime(run.startedAt) }),
      run.startedBy ? el("span", { text: `by ${run.startedBy}` }) : null,
      run.error ? el("span", { class: "validation-message", text: run.error }) : null,
      !running && run.kind !== "suite" ? el("a", { href: `/runs/${encodeURIComponent(run.id)}/report/index.html`, target: "_blank", rel: "noopener", text: "HTML report ↗" }) : null
    );

    if (panel.follow) {
      const active = [...run.steps].reverse().find(s => s.status !== "pending");
      if (active) panel.selectedStep = active.index;
    }

    const list = pel(panel, "runSteps");
    list.replaceChildren();
    let lastTestFile;
    for (const step of run.steps) {
      if (run.kind === "suite" && step.testFile !== lastTestFile) {
        lastTestFile = step.testFile;
        list.append(el("li", { class: "run-step-group", text: lastTestFile }));
      }
      const def = panel === testPanel && state.test ? state.test.steps[step.index - 1] : null;
      list.append(
        el("li", {
          class: `run-step ${step.status}${panel.selectedStep === step.index ? " selected" : ""}`,
          onclick: () => { panel.follow = false; panel.selectedStep = step.index; renderRun(panel); }
        },
          el("span", { class: "icon", text: ICONS[step.status] || "" }),
          el("span", { class: "label" }, `${step.index}. ${step.action} `, el("small", { text: def ? summarizeStep(def) : "" })),
          el("span", { class: "time", text: fmtMs(step.durationMs) })
        )
      );
    }

    const pre = pel(panel, "runLog");
    pre.textContent = run.log.join("\n");
    pre.scrollTop = pre.scrollHeight;

    renderViewer(panel);
    void loadRunReport(panel);
  }

  function renderViewer(panel) {
    const run = panel.run;
    const step = run && run.steps[panel.selectedStep - 1];
    const img = pel(panel, "viewerImg");
    const err = pel(panel, "viewerError");
    const empty = pel(panel, "viewerEmpty");
    if (!step) {
      img.hidden = true; err.hidden = true; empty.hidden = false;
      pel(panel, "viewerTitle").textContent = "";
      return;
    }

    const prefix = step.testFile ? `${step.testFile} · ` : "";
    pel(panel, "viewerTitle").textContent = `${prefix}Step ${step.index} · ${step.action} · ${step.status}` +
      (step.durationMs !== undefined ? ` · ${fmtMs(step.durationMs)}` : "");

    if (step.screenshot) {
      img.src = `/runs/${encodeURIComponent(run.id)}/${encodeURIComponent(step.screenshot)}`;
      img.hidden = false;
      empty.hidden = true;
    } else {
      img.hidden = true;
      empty.hidden = false;
      empty.textContent = step.status === "running" ? "Running… screenshot arrives when the step finishes."
        : step.status === "pending" ? "Not started yet."
        : step.status === "skipped" ? "Skipped because an earlier step failed."
        : "No screenshot was captured for this step.";
    }

    err.hidden = !step.error;
    $(panel.ids.viewerErrorMessage).textContent = step.error || "";
    renderAiSection(panel, step);

    img.onclick = step.screenshot
      ? () => openLightbox(img.src, `${prefix}Step ${step.index} · ${step.action}`)
      : null;
  }

  // ---------------------------------------------------------
  // Per-run report: where the time went and what it means
  // ---------------------------------------------------------

  async function loadRunReport(panel) {
    const run = panel.run;
    const box = pel(panel, "runReport");
    if (!run || !box) return;

    // While a run is still going the numbers churn; wait for the end.
    if (run.status === "running") {
      box.replaceChildren(el("div", { class: "muted", text: "The report is generated when the run finishes." }));
      return;
    }
    if (panel.reportFor === run.id) return;
    panel.reportFor = run.id;

    let data;
    try {
      data = await api(`/api/runs/${encodeURIComponent(run.id)}/report`);
    } catch (e) {
      panel.reportFor = null;
      box.replaceChildren(el("div", { class: "muted", text: e.message }));
      return;
    }
    if (panel.run !== run) return; // the user moved on while this loaded
    renderRunReport(box, data, run);
  }

  function renderRunReport(box, data, run) {
    const r = data.report;
    const insights = data.insights || [];
    const k = data.knowledge;
    box.replaceChildren();

    // Headline numbers.
    const wall = r.durationMs ? fmtMs(r.durationMs) : "—";
    const stepTime = r.stepTimeMs ? fmtMs(r.stepTimeMs) : "—";
    const overhead = r.durationMs && r.stepTimeMs ? fmtMs(Math.max(0, r.durationMs - r.stepTimeMs)) : "—";
    box.append(
      el("div", { class: "rr-cards" },
        rrCard("Result", r.status, r.status),
        rrCard("Time spent", wall, null, `${stepTime} in steps · ${overhead} startup/teardown`),
        rrCard("Steps passed", `${r.counts.passed}/${r.counts.total}`, null,
          `${r.counts.failed} failed · ${r.counts.skipped} skipped`),
        rrCard("Step pass rate", r.passRate === null ? "—" : `${r.passRate}%`)
      )
    );

    // What the history says about this run.
    if (insights.length) {
      const list = el("div", { class: "rr-insights" });
      for (const i of insights) {
        list.append(
          el("div", { class: `rr-insight ${i.level}` },
            el("div", { class: "rr-insight-title", text: i.title }),
            el("div", { class: "rr-insight-detail", text: i.detail })
          )
        );
      }
      box.append(rrSection("What this run tells us", list));
    }

    // Failures first - the thing people came for.
    if (r.failures.length) {
      const list = el("div", { class: "rr-failures" });
      for (const f of r.failures) {
        list.append(
          el("div", { class: "rr-failure" },
            el("div", { class: "rr-failure-head" },
              `Step ${f.index} · ${f.action}`,
              f.testFile ? el("span", { class: "rr-chip", text: f.testFile }) : null
            ),
            f.error ? el("pre", { class: "rr-failure-error", text: f.error.split("\n")[0].slice(0, 300) }) : null
          )
        );
      }
      box.append(rrSection("Failures", list));
    }

    // Where the time actually went.
    if (r.slowestSteps.length) {
      box.append(rrSection("Slowest steps", rrBars(r.slowestSteps.map(s => ({
        label: `${s.index}. ${s.action}`,
        sub: s.testFile || "",
        value: s.durationMs,
        share: s.share
      })))));
    }

    if (r.timeByAction.length > 1) {
      box.append(rrSection("Time by action", rrBars(r.timeByAction.map(a => ({
        label: a.action,
        sub: `${a.count}×`,
        value: a.totalMs,
        share: a.share
      })))));
    }

    // Suites: a row per test in the chain.
    if (r.perTest.length) {
      const table = el("table", { class: "report-table" },
        el("thead", {}, el("tr", {},
          el("th", { text: "Test" }), el("th", { text: "Steps" }), el("th", { text: "Passed" }),
          el("th", { text: "Failed" }), el("th", { text: "Skipped" }), el("th", { text: "Time" })
        ))
      );
      const body = el("tbody");
      for (const t of r.perTest) {
        body.append(el("tr", {},
          el("td", { text: t.file }),
          el("td", { text: String(t.total) }),
          el("td", { text: String(t.passed) }),
          el("td", { text: String(t.failed) }),
          el("td", { text: String(t.skipped) }),
          el("td", { text: fmtMs(t.durationMs) })
        ));
      }
      table.append(body);
      box.append(rrSection("Per test in this suite", el("div", { class: "report-table-wrap" }, table)));
    }

    // Long-run context.
    if (k && k.finishedRuns > 0) {
      const facts = [
        `${k.finishedRuns} recorded run${k.finishedRuns === 1 ? "" : "s"}`,
        k.passRate === null ? null : `${k.passRate}% pass rate`,
        k.medianDurationMs ? `typically ${fmtMs(k.medianDurationMs)}` : null,
        k.flakinessScore ? `${k.flakinessScore}% flaky` : null,
        k.streak ? `${k.streak.length} ${k.streak.status} in a row` : null
      ].filter(Boolean).join(" · ");
      box.append(rrSection("History", el("div", { class: "muted rr-history", text: facts })));
    }

    // AI summary of the whole run.
    const aiRow = el("div", { class: "rr-ai" });
    if (run.aiSummary) {
      aiRow.append(renderRunAi(run.aiSummary));
    } else if (state.aiConfigured) {
      aiRow.append(el("button", {
        class: "btn btn-small ai-btn",
        onclick: async e => {
          const btn = e.target;
          btn.disabled = true;
          btn.textContent = "Summarizing…";
          try {
            const result = await api(`/api/runs/${encodeURIComponent(run.id)}/summarize`, { method: "POST" });
            run.aiSummary = result;
            aiRow.replaceChildren(renderRunAi(result));
          } catch (ex) {
            toast(ex.message, "error");
            btn.disabled = false;
            btn.textContent = "✨ Summarize this run with AI";
          }
        }
      }, "✨ Summarize this run with AI"));
    } else {
      aiRow.append(el("div", { class: "muted", text: "Set ANTHROPIC_API_KEY on the server to get an AI summary of each run." }));
    }
    box.append(rrSection("AI summary", aiRow));
  }

  function renderRunAi(a) {
    return el("div", { class: "ai-analysis" },
      el("div", { class: "ai-analysis-head" },
        el("span", {}, "✨ AI summary"),
        el("span", { class: "ai-model", text: a.model || "" })
      ),
      el("p", { class: "ai-summary", text: a.headline || "" }),
      a.whatHappened ? el("div", { class: "ai-field" }, el("strong", { text: "What happened" }), el("p", { text: a.whatHappened })) : null,
      a.priority ? el("div", { class: "ai-field" }, el("strong", { text: "Fix first" }), el("p", { text: a.priority })) : null,
      a.recommendation ? el("div", { class: "ai-field" }, el("strong", { text: "Recommendation" }), el("p", { text: a.recommendation })) : null
    );
  }

  function rrCard(label, value, tone, sub) {
    return el("div", { class: "rr-card" },
      el("div", { class: `rr-card-value${tone ? " " + tone : ""}`, text: String(value) }),
      el("div", { class: "rr-card-label", text: label }),
      sub ? el("div", { class: "rr-card-sub", text: sub }) : null
    );
  }

  function rrSection(title, content) {
    return el("div", { class: "rr-section" },
      el("h4", { class: "rr-section-title", text: title }),
      content
    );
  }

  function rrBars(rows) {
    const box = el("div", { class: "rr-bars" });
    const max = Math.max(...rows.map(r => r.value), 1);
    for (const row of rows) {
      box.append(
        el("div", { class: "rr-bar-row" },
          el("div", { class: "rr-bar-label" },
            row.label,
            row.sub ? el("span", { class: "rr-bar-sub", text: ` ${row.sub}` }) : null
          ),
          el("div", { class: "rr-bar-track" },
            el("div", { class: "rr-bar-fill", style: `width:${Math.max(2, (row.value / max) * 100)}%` })
          ),
          el("div", { class: "rr-bar-value", text: `${fmtMs(row.value)}${row.share ? ` · ${row.share}%` : ""}` })
        )
      );
    }
    return box;
  }

  // ---------------------------------------------------------
  // AI failure analysis
  // ---------------------------------------------------------

  function renderAiSection(panel, step) {
    const btn = pel(panel, "btnAnalyze");
    const note = pel(panel, "aiNote");
    const box = pel(panel, "aiAnalysis");

    if (!step.error || step.status !== "failed") {
      btn.hidden = true;
      note.hidden = true;
      box.hidden = true;
      return;
    }

    if (step.analysis) {
      btn.hidden = true;
      note.hidden = true;
      showAiAnalysis(panel, step.analysis);
      return;
    }

    box.hidden = true;

    if (!state.aiConfigured) {
      btn.hidden = true;
      note.hidden = false;
      note.textContent = "AI analysis is not configured. Set ANTHROPIC_API_KEY on the server and restart to enable it.";
      return;
    }

    note.hidden = true;
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = "✨ Analyze with AI";
  }

  function showAiAnalysis(panel, a) {
    pel(panel, "aiAnalysis").hidden = false;
    pel(panel, "aiModel").textContent = a.model || "";
    pel(panel, "aiSummary").textContent = a.summary || "";
    pel(panel, "aiCause").textContent = a.likelyCause || "—";
    pel(panel, "aiFix").textContent = a.suggestedFix || "—";
  }

  async function analyzeStep(panel, force) {
    const run = panel.run;
    const step = run && run.steps[panel.selectedStep - 1];
    if (!run || !step) return;
    const btn = pel(panel, force ? "btnReanalyze" : "btnAnalyze");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = force ? "Re-analyzing…" : "Analyzing…";
    try {
      const result = await api(
        `/api/runs/${encodeURIComponent(run.id)}/steps/${step.index}/analyze${force ? "?force=1" : ""}`,
        { method: "POST" }
      );
      step.analysis = result;
      renderViewer(panel);
    } catch (e) {
      toast(e.message, "error");
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  // ---------------------------------------------------------
  // Run history (shared by both panels)
  // ---------------------------------------------------------

  async function loadHistory(panel, { autoOpenLatest }) {
    if (!panel.file) return;
    let runs = [];
    try {
      runs = await api(`/api/runs?test=${encodeURIComponent(panel.file)}&kind=${panel.kind}`);
    } catch (e) {
      toast(e.message, "error");
    }
    const list = pel(panel, "history");
    list.replaceChildren();
    if (!runs.length) {
      list.append(el("li", { class: "empty-history", text: "No runs yet." }));
      return;
    }
    for (const run of runs) {
      list.append(
        el("li", {
          class: panel.run && panel.run.id === run.id ? "active" : "",
          onclick: () => attachRun(panel, run.id, { live: false })
        },
          el("span", { class: `badge ${run.status}`, text: run.status }),
          el("span", { class: "when", text: fmtRelative(run.startedAt), title: fmtTime(run.startedAt) }),
          el("span", { class: "dur", text: run.status === "running" ? "live" : fmtMs(run.durationMs) })
        )
      );
    }
    if (autoOpenLatest && !panel.run) {
      panel.follow = runs[0].status === "running";
      attachRun(panel, runs[0].id, { live: false });
    }
  }

  // ---------------------------------------------------------
  // Test run / stop
  // ---------------------------------------------------------

  async function runTest() {
    if (!state.file) return;
    if (state.dirty) {
      const ok = await saveTest();
      if (!ok) return;
    }
    try {
      const rec = await api(`/api/tests/${encodeURIComponent(state.file)}/run`, { method: "POST" });
      attachRun(testPanel, rec.id, { live: true });
      await loadTests();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function stopRun() {
    if (!testPanel.run || testPanel.run.status !== "running") return;
    try {
      await api(`/api/runs/${encodeURIComponent(testPanel.run.id)}/stop`, { method: "POST" });
      toast("Stopping…");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  // ---------------------------------------------------------
  // Suites
  // ---------------------------------------------------------

  async function loadSuites() {
    state.suites = await api("/api/suites");
    renderSuiteList();
  }

  function suiteStatus(s) {
    return s.running ? "running" : (s.lastRun ? s.lastRun.status : "none");
  }

  function renderSuiteList() {
    const list = $("suite-list");
    list.replaceChildren();
    $("nav-suite-count").textContent = state.suites.length;
    $("suite-library-count").textContent = state.suites.length;
    if (!state.suites.length) {
      list.append(el("li", { class: "library-empty", text: "Create your first suite to connect tests into one shared browser journey." }));
      return;
    }
    for (const s of state.suites) {
      const status = suiteStatus(s);
      list.append(
        el("li", {}, el("button", {
          class: `test-item${s.file === state.suiteFile ? " active" : ""}`,
          title: s.file,
          "aria-label": `Open suite ${s.name || s.file}`,
          onclick: () => openSuite(s.file)
        },
          el("span", { class: "library-name" }, el("span", { class: "test-file-icon suite-file-icon", "aria-hidden": "true", text: "⇄" }), el("span", { class: "meta" },
            el("span", { class: "title", text: s.name || s.file }),
            el("span", { class: "sub", text: s.error ? "Invalid suite definition" : s.file })
          )),
          el("span", { class: "library-step-count", text: String(s.testCount) }),
          el("span", { class: "library-last-run", text: s.lastRun ? fmtRelative(s.lastRun.startedAt) : "—" }),
          el("span", { class: `badge ${s.error ? "failed" : status}`, text: s.error ? "Invalid" : status === "none" ? "Not run" : status })
        ))
      );
    }
  }

  async function openSuite(file, { force = false } = {}) {
    if (!force && file === state.suiteFile && state.suite) {
      activateView("suites", "suite-workspace");
      location.hash = `suite:${encodeURIComponent(file)}`;
      return;
    }
    if (!force && state.suiteDirty && !(await confirmDialog("Discard unsaved changes?", { okLabel: "Discard", danger: true }))) return;
    try {
      state.suite = await api(`/api/suites/${encodeURIComponent(file)}`);
    } catch (e) {
      toast(e.message, "error");
      return;
    }
    state.suiteFile = file;
    state.suiteDirty = false;
    $("suite-dirty").hidden = true;
    location.hash = `suite:${encodeURIComponent(file)}`;
    activateView("suites", "suite-workspace");

    $("suite-name").value = state.suite.name || "";
    $("suite-description").value = state.suite.description || "";
    $("suite-continue-on-failure").checked = Boolean(state.suite.continueOnFailure);
    $("suite-file").textContent = `suites/${file}`;

    renderSuiteTests();
    renderSuiteList();

    suitePanel.file = file;
    suitePanel.kind = "suite";
    detachRun(suitePanel);
    await loadHistory(suitePanel, { autoOpenLatest: true });
  }

  function renderSuiteTests() {
    const container = $("suite-tests");
    container.replaceChildren();
    const tests = state.suite.tests;
    $("suite-test-count").textContent = tests.length ? `(${tests.length})` : "";
    if (!tests.length) {
      container.append(el("div", { class: "muted", text: "No tests yet. Add one below." }));
    }
    tests.forEach((file, i) => {
      const known = state.tests.find(t => t.file === file);
      container.append(
        el("div", { class: "suite-test-row" },
          el("span", { class: "step-index", text: String(i + 1) }),
          el("div", { class: "suite-test-name" }, known ? (known.name || file) : `${file} (not found)`),
          el("div", { class: "step-tools" },
            el("button", { class: "btn-icon", title: "Move up", disabled: i === 0, onclick: () => moveSuiteTest(i, i - 1) }, "↑"),
            el("button", { class: "btn-icon", title: "Move down", disabled: i === tests.length - 1, onclick: () => moveSuiteTest(i, i + 1) }, "↓"),
            el("button", { class: "btn-icon", title: "Remove from suite", onclick: () => {
              tests.splice(i, 1);
              markSuiteDirty();
              renderSuiteTests();
            } }, "✕")
          )
        )
      );
    });
    renderSuiteAddOptions();
    const editable = can("suites.manage");
    for (const id of ["suite-name", "suite-description", "suite-continue-on-failure", "suite-add-test", "btn-suite-save"]) $(id).disabled = !editable;
    $("btn-suite-delete").hidden = !editable;
    for (const button of container.querySelectorAll("button")) if (!editable) button.disabled = true;
  }

  function moveSuiteTest(from, to) {
    const tests = state.suite.tests;
    if (to < 0 || to >= tests.length) return;
    [tests[from], tests[to]] = [tests[to], tests[from]];
    markSuiteDirty();
    renderSuiteTests();
  }

  function renderSuiteAddOptions() {
    const select = $("suite-add-test");
    select.replaceChildren(el("option", { value: "", text: "+ Add a test…" }));
    for (const t of state.tests) {
      if (state.suite.tests.includes(t.file)) continue;
      select.append(el("option", { value: t.file, text: t.name || t.file }));
    }
  }

  function markSuiteDirty() {
    state.suiteDirty = true;
    $("suite-dirty").hidden = false;
  }

  async function createSuite() {
    if (state.suiteDirty && !(await confirmDialog("Discard unsaved suite changes before creating another suite?", { okLabel: "Discard", danger: true }))) return;
    const raw = await promptDialog("File name for the new suite (saved in ./suites):", {
      title: "New suite",
      okLabel: "Create",
      defaultValue: "new-suite.json"
    });
    if (!raw) return;
    try {
      const created = await api("/api/suites", {
        method: "POST",
        body: JSON.stringify({ file: raw.trim(), name: raw.trim().replace(/\.json$/i, "") })
      });
      await loadSuites();
      await openSuite(created.file, { force: true });
      toast(`Created ${created.file}`, "ok");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function saveSuite() {
    if (!state.suiteFile || !can("suites.manage")) return false;
    const body = {
      name: $("suite-name").value,
      description: $("suite-description").value,
      continueOnFailure: $("suite-continue-on-failure").checked,
      tests: state.suite.tests
    };
    try {
      state.suite = await api(`/api/suites/${encodeURIComponent(state.suiteFile)}`, {
        method: "PUT",
        body: JSON.stringify(body)
      });
      state.suiteDirty = false;
      $("suite-dirty").hidden = true;
      renderSuiteTests();
      await loadSuites();
      toast("Saved", "ok");
      return true;
    } catch (e) {
      toast(e.message, "error");
      return false;
    }
  }

  async function deleteSuite() {
    if (!state.suiteFile) return;
    const ok = await confirmDialog(`Delete suites/${state.suiteFile}?`, { title: "Delete suite", okLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await api(`/api/suites/${encodeURIComponent(state.suiteFile)}`, { method: "DELETE" });
      toast(`Deleted ${state.suiteFile}`, "ok");
      state.suiteFile = null;
      state.suite = null;
      state.suiteDirty = false;
      switchTab("suites");
      detachRun(suitePanel);
      await loadSuites();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function runSuite() {
    if (!state.suiteFile) return;
    if (state.suiteDirty) {
      const ok = await saveSuite();
      if (!ok) return;
    }
    try {
      const rec = await api(`/api/suites/${encodeURIComponent(state.suiteFile)}/run`, { method: "POST" });
      attachRun(suitePanel, rec.id, { live: true });
      await loadSuites();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function stopSuiteRun() {
    if (!suitePanel.run || suitePanel.run.status !== "running") return;
    try {
      await api(`/api/runs/${encodeURIComponent(suitePanel.run.id)}/stop`, { method: "POST" });
      toast("Stopping…");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  // ---------------------------------------------------------
  // Reports
  // ---------------------------------------------------------

  async function openReports() {
    if (!can("reports.view")) { switchTab("overview"); return; }
    activateView("reports", "reports-workspace");
    location.hash = "view:reports";
    await loadReport();
  }

  async function loadReport() {
    if (!can("reports.view")) {
      $("report-cards").replaceChildren(el("div", { class: "muted", text: "You do not have access to reports." }));
      return;
    }
    const days = Number($("report-days").value) || 30;
    try {
      state.report = await api(`/api/reports/summary?days=${days}`);
    } catch (e) {
      toast(e.message, "error");
      return;
    }
    renderReport();
  }

  function statCard(label, value, sub) {
    return el("div", { class: "stat-card" },
      el("div", { class: "stat-value", text: value }),
      el("div", { class: "stat-label", text: label }),
      sub ? el("div", { class: "stat-sub", text: sub }) : null
    );
  }

  function renderReport() {
    const r = state.report;
    if (!r) return;
    $("report-range-label").textContent = `last ${r.days} days · generated ${fmtRelative(r.generatedAt)}`;

    $("report-cards").replaceChildren(
      statCard("Runs", String(r.totals.runs), `${r.totals.running} running now`),
      statCard("Pass rate", r.totals.passRate == null ? "—" : `${r.totals.passRate}%`, `${r.totals.passed} passed · ${r.totals.failed} failed`),
      statCard("Steps executed", String(r.totals.stepsExecuted), ""),
      statCard("Avg duration", fmtMs(r.totals.avgDurationMs) || "—", "per finished run")
    );

    // Trend: simple stacked bars, no chart library.
    const trend = $("report-trend");
    trend.replaceChildren();
    const max = Math.max(1, ...r.dailyTrend.map(d => d.passed + d.failed));
    for (const day of r.dailyTrend) {
      const total = day.passed + day.failed;
      trend.append(
        el("div", { class: "trend-col", title: `${day.date}: ${day.passed} passed, ${day.failed} failed` },
          el("div", { class: "trend-bars" },
            el("div", { class: "trend-bar failed", style: `height:${(day.failed / max) * 100}%` }),
            el("div", { class: "trend-bar passed", style: `height:${(day.passed / max) * 100}%` })
          ),
          el("div", { class: "trend-label", text: total ? String(total) : "" })
        )
      );
    }

    renderProjectTable($("report-projects"), r.perProject || []);
    renderUserTable($("report-users"), r.perUser || []);
    renderReportTable($("report-tests"), r.perTest, "test");
    renderReportTable($("report-suites"), r.perSuite, "suite");

    const failures = $("report-failures");
    failures.replaceChildren();
    if (!r.recentFailures.length) {
      failures.append(el("li", { class: "muted", text: "No failures in this window." }));
    }
    for (const f of r.recentFailures) {
      failures.append(
        el("li", { class: "report-failure", onclick: () => { location.hash = f.kind === "suite" ? `suite:${f.file}` : f.file; } },
          el("div", { class: "rf-head" },
            el("span", { class: "badge failed", text: f.kind }),
            el("span", { class: "rf-name", text: f.name || f.file }),
            el("span", { class: "rf-when", text: fmtRelative(f.startedAt), title: fmtTime(f.startedAt) })
          ),
          el("div", { class: "rf-detail", text: f.action ? `Step ${f.stepIndex} · ${f.action}${f.testFile ? ` · ${f.testFile}` : ""}` : "" }),
          f.error ? el("div", { class: "rf-error", text: f.error }) : null
        )
      );
    }
  }

  // A run still in flight is neither a pass nor a failure, so show "-"
  // rather than a misleading 0%.
  function rateCell(passRate) {
    if (passRate === null || passRate === undefined) {
      return el("span", { class: "rate none", text: "—" });
    }
    const cls = passRate >= 80 ? "good" : passRate >= 50 ? "mid" : "bad";
    return el("span", { class: `rate ${cls}`, text: `${passRate}%` });
  }

  function renderProjectTable(container, rows) {
    container.replaceChildren();
    if (!rows.length) {
      container.append(el("div", { class: "muted", text: "No projects yet. Group tests into folders to see them here." }));
      return;
    }
    const table = el("table", { class: "report-table" },
      el("thead", {}, el("tr", {},
        el("th", { text: "Project" }), el("th", { text: "Tests" }), el("th", { text: "Runs" }),
        el("th", { text: "Passed" }), el("th", { text: "Failed" }), el("th", { text: "Pass rate" }),
        el("th", { text: "Never run" }), el("th", { text: "Steps" }), el("th", { text: "Avg" }), el("th", { text: "Last run" })
      ))
    );
    const body = el("tbody");
    for (const row of rows) {
      body.append(el("tr", {},
        el("td", {}, el("span", { class: "report-project" },
          el("span", { class: "project-icon", text: row.folder ? "📁" : "•" }),
          row.label
        )),
        el("td", { text: String(row.tests) }),
        el("td", { text: String(row.runs) + (row.running ? ` (${row.running} running)` : "") }),
        el("td", { text: String(row.passed) }),
        el("td", { text: String(row.failed) }),
        el("td", {}, rateCell(row.passRate)),
        el("td", {}, row.neverRun
          ? el("span", { class: "never-run", title: "Tests in this project with no run in this window", text: String(row.neverRun) })
          : el("span", { class: "muted", text: "0" })),
        el("td", { text: String(row.stepsExecuted) }),
        el("td", { text: fmtMs(row.avgDurationMs) || "—" }),
        el("td", { text: row.lastRunAt ? fmtRelative(row.lastRunAt) : "—", title: row.lastRunAt ? fmtTime(row.lastRunAt) : "" })
      ));
    }
    table.append(body);
    container.append(table);
  }

  function renderUserTable(container, rows) {
    container.replaceChildren();
    if (!rows.length) {
      container.append(el("div", { class: "muted", text: "No runs by anyone in this window." }));
      return;
    }
    const table = el("table", { class: "report-table" },
      el("thead", {}, el("tr", {},
        el("th", { text: "User" }), el("th", { text: "Runs" }), el("th", { text: "Tests" }),
        el("th", { text: "Suites" }), el("th", { text: "Passed" }), el("th", { text: "Failed" }),
        el("th", { text: "Pass rate" }), el("th", { text: "Steps" }), el("th", { text: "Avg" }), el("th", { text: "Last run" })
      ))
    );
    const body = el("tbody");
    for (const row of rows) {
      body.append(el("tr", {},
        el("td", {}, el("span", { class: "report-user" },
          el("span", { class: "user-avatar", text: (row.username[0] || "?").toUpperCase() }),
          row.username
        )),
        el("td", { text: String(row.runs) + (row.running ? ` (${row.running} running)` : "") }),
        el("td", { text: String(row.testRuns) }),
        el("td", { text: String(row.suiteRuns) }),
        el("td", { text: String(row.passed) }),
        el("td", { text: String(row.failed) }),
        el("td", {}, rateCell(row.passRate)),
        el("td", { text: String(row.stepsExecuted) }),
        el("td", { text: fmtMs(row.avgDurationMs) || "—" }),
        el("td", { text: row.lastRunAt ? fmtRelative(row.lastRunAt) : "—", title: row.lastRunAt ? fmtTime(row.lastRunAt) : "" })
      ));
    }
    table.append(body);
    container.append(table);
  }

  function renderReportTable(container, rows, kind) {
    container.replaceChildren();
    if (!rows.length) {
      container.append(el("div", { class: "muted", text: `No ${kind} runs in this window.` }));
      return;
    }
    const table = el("table", { class: "report-table" },
      el("thead", {}, el("tr", {},
        el("th", { text: "Name" }), el("th", { text: "Runs" }), el("th", { text: "Passed" }),
        el("th", { text: "Failed" }), el("th", { text: "Pass rate" }), el("th", { text: "Avg" }), el("th", { text: "Last run" })
      ))
    );
    const body = el("tbody");
    for (const row of rows) {
      body.append(el("tr", { onclick: () => { location.hash = kind === "suite" ? `suite:${row.file}` : row.file; } },
        el("td", { text: row.name || row.file }),
        el("td", { text: String(row.runs) + (row.running ? ` (${row.running} running)` : "") }),
        el("td", { text: String(row.passed) }),
        el("td", { text: String(row.failed) }),
        el("td", {}, rateCell(row.passRate)),
        el("td", { text: fmtMs(row.avgDurationMs) || "—" }),
        el("td", { text: row.lastRunAt ? fmtRelative(row.lastRunAt) : "—", title: row.lastRunAt ? fmtTime(row.lastRunAt) : "" })
      ));
    }
    table.append(body);
    container.append(table);
  }

  // ---------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------

  async function loadNotifications() {
    try {
      const res = await api("/api/notifications");
      state.notifications = res.items || [];
      state.unread = res.unread || 0;
      renderBell();
    } catch {
      // a transient failure here should never interrupt the app
    }
  }

  function renderBell() {
    const badge = $("bell-count");
    badge.textContent = String(state.unread);
    badge.hidden = state.unread === 0;
  }

  async function openNotifications() {
    await loadNotifications();
    renderNotificationsList();
    $("notifications-modal").hidden = false;
  }

  function closeNotifications() {
    $("notifications-modal").hidden = true;
  }

  function renderNotificationsList() {
    const list = $("notifications-list");
    list.replaceChildren();
    if (!state.notifications.length) {
      list.append(el("li", { class: "muted", text: "Nothing yet. Run a test or get a test shared with you." }));
      return;
    }
    for (const n of state.notifications) {
      list.append(
        el("li", {
          class: `notification${n.readAt ? "" : " unread"}`,
          onclick: async () => {
            if (!n.readAt) {
              await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ ids: [n.id] }) }).catch(() => {});
            }
            closeNotifications();
            if (n.link) location.hash = n.link;
            loadNotifications();
          }
        },
          el("div", { class: "n-head" },
            el("span", { class: `n-dot ${n.type}` }),
            el("span", { class: "n-title", text: n.title }),
            el("span", { class: "n-when", text: fmtRelative(n.createdAt), title: fmtTime(n.createdAt) })
          ),
          el("div", { class: "n-body", text: n.body })
        )
      );
    }
  }

  async function markAllNotificationsRead() {
    try {
      await api("/api/notifications/read", { method: "POST", body: JSON.stringify({}) });
      await loadNotifications();
      renderNotificationsList();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  // ---------------------------------------------------------
  // Import / export
  // ---------------------------------------------------------

  async function importTestFile(file) {
    if (state.dirty && !(await confirmDialog("Discard unsaved test changes before importing another test?", { okLabel: "Discard", danger: true }))) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast("That file is not valid JSON.", "error");
      return;
    }
    try {
      const res = await api("/api/tests/import", {
        method: "POST",
        body: JSON.stringify({ file: file.name, content: parsed })
      });
      await Promise.all([loadTests(), loadFolders()]);
      await openTest(res.file, { force: true });
      const skipped = res.skipped && res.skipped.length
        ? ` ${res.skipped.length} step${res.skipped.length === 1 ? "" : "s"} could not be mapped.`
        : "";
      toast(`Imported ${res.imported} steps from ${res.format}.${skipped}`, "ok");
      if (skipped) {
        console.info("Skipped steps:", res.skipped);
      }
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function exportTest() {
    if (!state.test) return;
    const payload = {
      name: state.test.name || state.file.replace(/\.json$/, ""),
      description: state.test.description || undefined,
      steps: state.test.steps
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.file;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`Exported ${state.file}`, "ok");
  }

  // ---------------------------------------------------------
  // Recorder
  // ---------------------------------------------------------

  function openRecordModal() {
    if (!state.file) return;
    resetRecordModal();
    $("record-modal").hidden = false;
    $("record-url").focus();
  }

  function resetRecordModal() {
    stopRecordStream();
    state.recording = null;
    $("record-setup").hidden = false;
    $("record-live").hidden = true;
    $("record-error").hidden = true;
    $("record-steps").replaceChildren();
    $("record-count").textContent = "0 steps";
    $("btn-record-apply").disabled = true;
    $("btn-record-stop").hidden = false;
    $("record-replace").checked = false;
  }

  function closeRecordModal() {
    // Leave the browser running only if the user is still recording on purpose;
    // closing the panel should not silently abandon a live session.
    if (state.recording && state.recording.status === "recording") {
      void api(`/api/record/${encodeURIComponent(state.recording.id)}/stop`, { method: "POST" }).catch(() => {});
    }
    stopRecordStream();
    $("record-modal").hidden = true;
    state.recording = null;
  }

  function stopRecordStream() {
    if (state.recordSource) {
      state.recordSource.close();
      state.recordSource = null;
    }
  }

  async function startRecording(url) {
    const err = $("record-error");
    err.hidden = true;
    try {
      const session = await api("/api/record/start", {
        method: "POST",
        body: JSON.stringify({ url })
      });
      state.recording = session;
      $("record-setup").hidden = true;
      $("record-live").hidden = false;
      renderRecordedSteps();
      streamRecording(session.id);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  }

  function streamRecording(id) {
    stopRecordStream();
    const source = new EventSource(`/api/record/${encodeURIComponent(id)}/events`);
    state.recordSource = source;

    source.addEventListener("snapshot", e => {
      state.recording = JSON.parse(e.data);
      renderRecordedSteps();
    });
    source.addEventListener("step", e => {
      if (!state.recording) return;
      const step = JSON.parse(e.data);
      // The server collapses repeated fills on one field; mirror that here.
      const steps = state.recording.steps;
      const last = steps[steps.length - 1];
      if (last && step.action === "fill" && last.action === "fill" && last.selector === step.selector) {
        steps[steps.length - 1] = step;
      } else {
        steps.push(step);
      }
      renderRecordedSteps();
    });
    source.addEventListener("ended", e => {
      state.recording = JSON.parse(e.data);
      stopRecordStream();
      renderRecordedSteps();
      toast(`Recording stopped with ${state.recording.steps.length} steps`, "ok");
    });
  }

  function renderRecordedSteps() {
    const session = state.recording;
    const list = $("record-steps");
    list.replaceChildren();
    if (!session) return;

    const recording = session.status === "recording";
    $("record-badge").textContent = recording ? "recording" : "stopped";
    $("record-badge").className = `badge ${recording ? "running" : "passed"}`;
    $("btn-record-stop").hidden = !recording;
    $("record-count").textContent = `${session.steps.length} step${session.steps.length === 1 ? "" : "s"}`;
    $("btn-record-apply").disabled = !session.steps.length;

    if (!session.steps.length) {
      list.append(el("li", { class: "muted", text: "Interact with the browser window and steps will appear here." }));
      return;
    }

    session.steps.forEach((step, i) => {
      const detail = step.selector || step.url || step.key || "";
      list.append(
        el("li", { class: "record-step" },
          el("span", { class: "step-index", text: String(i + 1) }),
          el("div", { class: "record-step-body" },
            el("div", { class: "record-step-action" },
              step.action,
              step.fragile ? el("span", { class: "fragile-flag", title: "Positional selector - may break if the layout changes" }, " fragile") : null
            ),
            el("div", { class: "record-step-detail", text: detail }),
            step.value ? el("div", { class: "record-step-detail", text: `value: ${step.value}` }) : null
          ),
          el("button", {
            class: "btn-icon", title: "Drop this step",
            onclick: () => { session.steps.splice(i, 1); renderRecordedSteps(); }
          }, "✕")
        )
      );
    });
  }

  async function stopRecording() {
    if (!state.recording) return;
    try {
      const session = await api(`/api/record/${encodeURIComponent(state.recording.id)}/stop`, { method: "POST" });
      state.recording = session;
      stopRecordStream();
      renderRecordedSteps();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function applyRecording() {
    if (!state.recording || !state.file) return;
    try {
      const res = await api(`/api/record/${encodeURIComponent(state.recording.id)}/apply`, {
        method: "POST",
        body: JSON.stringify({
          file: state.file,
          mode: $("record-replace").checked ? "replace" : "append",
          steps: state.recording.steps
        })
      });
      state.test = res.test;
      setDirty(false);
      renderSteps();
      renderTestMeta();
      await loadTests();
      closeRecordModal();
      toast(`Added ${res.added} recorded steps`, "ok");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function wireRecorder() {
    $("btn-record").addEventListener("click", openRecordModal);
    $("btn-close-record").addEventListener("click", closeRecordModal);
    $("btn-record-cancel").addEventListener("click", closeRecordModal);
    $("record-modal").addEventListener("click", e => {
      if (e.target.id === "record-modal") closeRecordModal();
    });
    $("record-start-form").addEventListener("submit", e => {
      e.preventDefault();
      startRecording($("record-url").value.trim());
    });
    $("btn-record-stop").addEventListener("click", stopRecording);
    $("btn-record-apply").addEventListener("click", applyRecording);

    $("btn-export").addEventListener("click", exportTest);
    $("btn-import").addEventListener("click", () => $("import-file").click());
    $("import-file").addEventListener("change", async e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (file) await importTestFile(file);
    });
  }

  // ---------------------------------------------------------
  // Auth: setup / login / logout / session bootstrap
  // ---------------------------------------------------------

  function showAuthScreen(mode) {
    $("app-shell").hidden = true;
    $("auth-screen").hidden = false;
    $("auth-setup").hidden = mode !== "setup";
    $("auth-login").hidden = mode !== "login";
  }

  function wireAuthForms() {
    $("setup-form").addEventListener("submit", async e => {
      e.preventDefault();
      const err = $("setup-error");
      err.hidden = true;
      try {
        await authApi("/api/auth/setup", {
          username: $("setup-username").value,
          password: $("setup-password").value
        });
        location.reload();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });

    $("login-form").addEventListener("submit", async e => {
      e.preventDefault();
      const err = $("login-error");
      err.hidden = true;
      try {
        await authApi("/api/auth/login", {
          username: $("login-username").value,
          password: $("login-password").value
        });
        location.reload();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      }
    });
  }

  const ROLE_LABELS = { site_admin: "Site admin", admin: "Admin", member: "Member" };

  function renderAccount() {
    if (!state.user) return;
    $("account-name").textContent = state.user.username;
    $("account-avatar").textContent = state.user.username.slice(0, 2).toUpperCase();
    $("account-role").textContent = ROLE_LABELS[state.user.role] || state.user.role;
    $("btn-manage-users").hidden = !can("users.manage");

    // Hide whole areas the account has no access to.
    const reportsTab = document.querySelector('.sidebar-tabs .tab[data-tab="reports"]');
    if (reportsTab) reportsTab.hidden = !can("reports.view");
    $("btn-new").hidden = !can("tests.create");
    $("btn-new-folder").hidden = !can("folders.manage");
    $("btn-new-suite").hidden = !can("suites.manage");
    const importButton = $("btn-import");
    if (importButton) importButton.hidden = !can("tests.create");
  }

  function wireAccountControls() {
    $("btn-password").addEventListener("click", () => {
      $("password-form").reset();
      $("password-error").hidden = true;
      $("password-modal").hidden = false;
    });
    $("btn-close-password").addEventListener("click", () => { $("password-modal").hidden = true; });
    $("password-form").addEventListener("submit", async event => {
      event.preventDefault();
      const error = $("password-error");
      error.hidden = true;
      if ($("password-new").value !== $("password-confirm").value) { error.textContent = "The new passwords do not match."; error.hidden = false; return; }
      const button = event.submitter;
      button.disabled = true;
      try {
        await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: $("password-current").value, newPassword: $("password-new").value }) });
        $("password-form").reset();
        $("password-modal").hidden = true;
        toast("Password updated. Other sessions signed out.", "ok");
      } catch (e) { error.textContent = e.message; error.hidden = false; }
      finally { button.disabled = false; }
    });
    $("btn-logout").addEventListener("click", async () => {
      try {
        await authApi("/api/auth/logout", {});
      } finally {
        location.reload();
      }
    });

    $("btn-manage-users").addEventListener("click", openUsersModal);
    $("btn-close-users").addEventListener("click", closeUsersModal);
    $("btn-done-users").addEventListener("click", closeUsersModal);
    $("btn-refresh-users").addEventListener("click", renderUsersList);
    $("users-search").addEventListener("input", drawManagedUsers);
    $("new-role").addEventListener("change", renderNewUserRole);
    $("btn-toggle-new-password").addEventListener("click", () => {
      setNewPasswordVisible($("new-password").type === "password");
    });
    $("users-modal").addEventListener("click", e => {
      if (e.target.id === "users-modal") closeUsersModal();
    });
    $("users-modal").addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); closeUsersModal(); }
    });

    $("add-user-form").addEventListener("submit", async e => {
      e.preventDefault();
      const button = $("btn-add-user");
      if (button.disabled) return;
      const err = $("users-error");
      err.hidden = true;
      $("new-user-fields").disabled = true;
      button.disabled = true;
      button.textContent = "Adding user…";
      try {
        await api("/api/users", {
          method: "POST",
          body: JSON.stringify({
            username: $("new-username").value,
            password: $("new-password").value,
            role: $("new-role").value
          })
        });
        $("add-user-form").reset();
        setNewPasswordVisible(false);
        renderNewUserRole();
        $("users-search").value = "";
        await renderUsersList();
        toast("User added", "ok");
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        $("new-user-fields").disabled = false;
        button.disabled = false;
        button.textContent = "+ Add user";
      }
    });
  }

  async function openUsersModal() {
    $("users-modal").hidden = false;
    $("users-error").hidden = true;
    $("users-search").value = "";
    const siteAdmin = state.user.role === "site_admin";
    for (const option of $("new-role").options) option.disabled = !siteAdmin && option.value !== "member";
    if (!siteAdmin) $("new-role").value = "member";
    renderNewUserRole();
    $("users-access-hint").textContent = siteAdmin ? "Use Manage access to adjust roles and permissions." : "Only a site admin can change roles and permissions.";
    await renderUsersList();
  }

  function closeUsersModal() {
    $("users-modal").hidden = true;
    setNewPasswordVisible(false);
  }

  function setNewPasswordVisible(visible) {
    $("new-password").type = visible ? "text" : "password";
    $("btn-toggle-new-password").textContent = visible ? "Hide" : "Show";
    $("btn-toggle-new-password").setAttribute("aria-label", visible ? "Hide password" : "Show password");
    $("btn-toggle-new-password").setAttribute("aria-pressed", String(visible));
  }

  function renderNewUserRole() {
    $("new-role-help").textContent = {
      member: "Build tests, run suites, and view reports.",
      admin: "Manage tests, suites, and member accounts.",
      site_admin: "Full workspace access, including roles and permissions."
    }[$("new-role").value];
  }

  let managedUsers = [];

  async function renderUsersList() {
    const message = $("users-list-message");
    message.textContent = "Loading members…";
    message.hidden = false;
    $("btn-refresh-users").disabled = true;
    $("users-list").setAttribute("aria-busy", "true");
    try {
      managedUsers = await api("/api/users");
      drawManagedUsers();
    } catch (e) {
      message.textContent = `${e.message} Use Refresh members to try again.`;
      message.hidden = false;
    } finally {
      $("btn-refresh-users").disabled = false;
      $("users-list").setAttribute("aria-busy", "false");
    }
  }

  function drawManagedUsers() {
    const query = $("users-search").value.trim().toLowerCase();
    const users = managedUsers.filter(user => `${user.username} ${ROLE_LABELS[user.role] || user.role}`.toLowerCase().includes(query));
    $("users-count").textContent = managedUsers.length;
    $("users-list-message").hidden = users.length > 0;
    $("users-list-message").textContent = query ? "No matching members. Try another name or role." : "No members to show.";
    const list = $("users-list");
    list.replaceChildren();
    for (const u of users) {
      const isSelf = u.id === state.user.id;
      list.append(
        el("li", { class: "member-row" },
          el("span", { class: `member-avatar avatar-${u.role}`, "aria-hidden": "true", text: u.username.slice(0, 2).toUpperCase() }),
          el("div", { class: "member-details" },
            el("div", { class: "member-name-line" }, el("span", { class: "u-name", text: u.username }), isSelf ? el("span", { class: "member-self", text: "You" }) : null),
            el("span", { class: `u-role role-${u.role}`, text: ROLE_LABELS[u.role] || u.role })),
          state.user.role === "site_admin"
            ? el("button", { class: "btn member-access", "aria-label": `Manage access for ${u.username}`, onclick: () => openFeaturesModal(u) }, "Manage access")
            : null,
          el("button", {
            class: "btn-icon member-remove",
            "aria-label": `Remove ${u.username}`,
            title: isSelf ? "You cannot delete your own account" : "Delete user",
            disabled: isSelf || (u.role !== "member" && state.user.role !== "site_admin"),
            onclick: async () => {
              const ok = await confirmDialog(`Delete user "${u.username}"?`, { title: "Delete user", okLabel: "Delete", danger: true });
              if (!ok) return;
              try {
                await api(`/api/users/${encodeURIComponent(u.id)}`, { method: "DELETE" });
                await renderUsersList();
                toast("User deleted", "ok");
              } catch (ex) {
                toast(ex.message, "error");
              }
            }
          }, userIcon("trash"))
        )
      );
    }
  }

  function userIcon(name) {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "icon icon-small");
    icon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `brand/icons.svg#${name}`);
    icon.append(use);
    return icon;
  }

  // ---------------------------------------------------------
  // Wiring for sharing, folders, and suite controls
  // ---------------------------------------------------------

  function wireShareModal() {
    $("btn-share").addEventListener("click", openShareModal);
    $("btn-close-share").addEventListener("click", closeShareModal);
    $("btn-share-cancel").addEventListener("click", closeShareModal);
    $("share-modal").addEventListener("click", e => {
      if (e.target.id === "share-modal") closeShareModal();
    });
    $("btn-share-save").addEventListener("click", saveSharing);
    $("btn-move-folder").addEventListener("click", moveToFolder);

    $("share-vis-team").addEventListener("change", () => { shareDraft.visibility = "team"; renderShareModal(); });
    $("share-vis-restricted").addEventListener("change", () => { shareDraft.visibility = "restricted"; renderShareModal(); });

    $("share-add-form").addEventListener("submit", e => {
      e.preventDefault();
      const username = $("share-add-user").value;
      if (!username) return;
      shareDraft.sharedWith.push({ username, permission: $("share-add-permission").value === "edit" ? "edit" : "view" });
      $("share-add-form").reset();
      renderShareModal();
    });

    $("btn-copy-link").addEventListener("click", async () => {
      const input = $("share-link");
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand("copy");
      }
      toast("Link copied", "ok");
    });
  }

  function wireFolderControls() {
    $("btn-new-folder").addEventListener("click", () => createFolder(""));
  }

  function wireSuiteControls() {
    $("btn-new-suite").addEventListener("click", createSuite);
    $("btn-suite-save").addEventListener("click", saveSuite);
    $("btn-suite-delete").addEventListener("click", deleteSuite);
    $("suite-btn-run").addEventListener("click", runSuite);
    $("suite-btn-stop").addEventListener("click", stopSuiteRun);
    $("suite-btn-analyze").addEventListener("click", () => analyzeStep(suitePanel, false));
    $("suite-btn-reanalyze").addEventListener("click", () => analyzeStep(suitePanel, true));

    $("suite-name").addEventListener("input", markSuiteDirty);
    $("suite-description").addEventListener("input", markSuiteDirty);
    $("suite-continue-on-failure").addEventListener("change", markSuiteDirty);

    $("suite-add-test").addEventListener("change", e => {
      const file = e.target.value;
      if (!file) return;
      state.suite.tests.push(file);
      markSuiteDirty();
      renderSuiteTests();
    });
  }

  // ---------------------------------------------------------
  // Feature access (site admin only)
  // ---------------------------------------------------------

  let featureDraft = null;

  async function openFeaturesModal(user) {
    if (!state.featureCatalog.length) {
      try {
        state.featureCatalog = await api("/api/features");
      } catch (e) {
        toast(e.message, "error");
        return;
      }
    }
    featureDraft = {
      id: user.id,
      username: user.username,
      role: user.role,
      features: [...(user.effectiveFeatures || [])],
      custom: Array.isArray(user.features)
    };
    $("features-user").textContent = user.username;
    $("features-role").value = user.role;
    renderFeaturesModal();
    $("features-modal").hidden = false;
  }

  function closeFeaturesModal() {
    $("features-modal").hidden = true;
    featureDraft = null;
  }

  function renderFeaturesModal() {
    const isSiteAdmin = featureDraft.role === "site_admin";
    $("features-hint").textContent = isSiteAdmin
      ? "Site admins always have every feature."
      : "Tick the features this account can use.";

    const list = $("features-list");
    list.replaceChildren();
    for (const f of state.featureCatalog) {
      const checked = isSiteAdmin || featureDraft.features.includes(f.id);
      const box = el("input", { type: "checkbox" });
      box.checked = checked;
      box.disabled = isSiteAdmin;
      box.addEventListener("change", () => {
        if (box.checked) {
          if (!featureDraft.features.includes(f.id)) featureDraft.features.push(f.id);
        } else {
          featureDraft.features = featureDraft.features.filter(x => x !== f.id);
        }
      });
      list.append(el("li", { class: "feature-row" },
        el("label", { class: "feature-label" }, box, el("span", { class: "feature-name", text: f.label })),
        el("div", { class: "feature-desc", text: f.description })
      ));
    }
  }

  async function saveFeatures() {
    try {
      await api(`/api/users/${encodeURIComponent(featureDraft.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          role: featureDraft.role,
          features: featureDraft.role === "site_admin" ? null : featureDraft.features
        })
      });
      closeFeaturesModal();
      await renderUsersList();
      toast("Access updated", "ok");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  function wireFeatureControls() {
    $("btn-close-features").addEventListener("click", closeFeaturesModal);
    $("btn-features-cancel").addEventListener("click", closeFeaturesModal);
    $("btn-features-save").addEventListener("click", saveFeatures);
    $("features-modal").addEventListener("click", e => {
      if (e.target.id === "features-modal") closeFeaturesModal();
    });
    $("features-role").addEventListener("change", e => {
      featureDraft.role = e.target.value;
      renderFeaturesModal();
    });

    $("btn-notifications").addEventListener("click", openNotifications);
    $("btn-close-notifications").addEventListener("click", closeNotifications);
    $("btn-mark-all-read").addEventListener("click", markAllNotificationsRead);
    $("notifications-modal").addEventListener("click", e => {
      if (e.target.id === "notifications-modal") closeNotifications();
    });

    $("report-days").addEventListener("change", loadReport);
    $("btn-refresh-report").addEventListener("click", loadReport);
  }

  async function checkAiStatus() {
    try {
      const status = await api("/api/ai/status");
      state.aiConfigured = Boolean(status.configured);
    } catch {
      state.aiConfigured = false;
    }
  }

  async function boot() {
    wireAccessibleDialogs();
    wireAuthForms();

    let status;
    try {
      status = await fetch("/api/auth/status").then(r => r.json());
    } catch {
      toast("Could not reach the Test Studio server.", "error");
      return;
    }

    if (status.needsSetup) { showAuthScreen("setup"); return; }
    if (!status.user) { showAuthScreen("login"); return; }

    state.user = status.user;
    $("auth-screen").hidden = true;
    $("app-shell").hidden = false;
    renderAccount();
    wireAccountControls();
    wireFeatureControls();
    await checkAiStatus();
    await loadNotifications();
    setInterval(loadNotifications, 25000);
    await init();
  }

  async function init() {
    try {
      const catalog = await api("/api/actions");
      state.actions = catalog.actions;
      state.fields = catalog.fields;
      for (const spec of catalog.actions) {
        state.actionMap.set(spec.action, spec);
        for (const alias of spec.aliases || []) state.actionMap.set(alias, spec);
      }
      await Promise.all([loadTests(), loadFolders(), loadSuites()]);
    } catch (e) {
      toast(`Failed to load: ${e.message}`, "error");
      return;
    }

    for (const btn of document.querySelectorAll(".sidebar-tabs .tab")) {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    }

    $("btn-new").addEventListener("click", () => createTest());
    $("btn-mobile-browse").addEventListener("click", () => mobileNavigation($("btn-mobile-browse").getAttribute("aria-expanded") !== "true"));
    $("nav-backdrop").addEventListener("click", () => { mobileNavigation(false); $("btn-mobile-browse").focus(); });
    window.matchMedia("(max-width: 760px)").addEventListener("change", () => mobileNavigation(false));
    $("btn-overview-new").addEventListener("click", () => createTest());
    $("btn-overview-reports").addEventListener("click", () => switchTab("reports"));
    $("btn-overview-library").addEventListener("click", () => switchTab("tests"));
    for (const button of document.querySelectorAll("[data-back]")) button.addEventListener("click", () => switchTab(button.dataset.back));
    document.addEventListener("click", event => {
      for (const dropdown of document.querySelectorAll(".dropdown[open]")) {
        if (event.target.closest(".dropdown-panel button") && dropdown.contains(event.target)) {
          const focusedInMenu = dropdown.contains(document.activeElement);
          dropdown.open = false;
          if (focusedInMenu) dropdown.querySelector("summary").focus();
        } else if (!dropdown.contains(event.target)) dropdown.open = false;
      }
    });
    $("btn-save").addEventListener("click", saveTest);
    $("btn-run").addEventListener("click", runTest);
    $("btn-stop").addEventListener("click", stopRun);
    $("btn-delete").addEventListener("click", deleteTest);
    $("btn-add-step").addEventListener("click", addStep);
    $("btn-analyze").addEventListener("click", () => analyzeStep(testPanel, false));
    $("btn-reanalyze").addEventListener("click", () => analyzeStep(testPanel, true));
    $("test-name").addEventListener("input", () => setDirty(true));
    $("test-description").addEventListener("input", () => setDirty(true));

    $("test-search").addEventListener("input", e => {
      state.search = e.target.value;
      revealMatches();
      renderTestList();
    });

    $("status-filter").addEventListener("click", e => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      state.statusFilter = chip.dataset.filter;
      revealMatches();
      renderTestList();
    });

    wireFolderControls();
    wireShareModal();
    wireRecorder();
    wireSuiteControls();

    window.addEventListener("beforeunload", e => {
      if (state.dirty || state.suiteDirty) { e.preventDefault(); e.returnValue = ""; }
    });

    document.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!$("workspace").hidden && state.file) saveTest();
        else if (!$("suite-workspace").hidden && state.suiteFile) saveSuite();
      }
      if (e.key === "Escape") {
        closeLightbox();
        if ($("btn-mobile-browse").getAttribute("aria-expanded") === "true") { mobileNavigation(false); $("btn-mobile-browse").focus(); }
        for (const dropdown of document.querySelectorAll(".dropdown[open]")) { dropdown.open = false; dropdown.querySelector("summary").focus(); }
      }
    });

    async function followRoute() {
      let raw;
      try { raw = decodeURIComponent(location.hash.slice(1)); } catch { switchTab("overview"); return; }
      if (!raw || raw.startsWith("view:")) {
        const section = raw.slice(5) || "overview";
        const valid = ["overview", "tests", "suites", "reports"].includes(section) ? section : "overview";
        const view = valid === "overview" ? "empty" : valid === "reports" ? "reports-workspace" : `${valid}-panel`;
        if (state.view !== view) switchTab(valid);
        return;
      }
      if (raw.startsWith("suite:")) {
        const file = raw.slice(6);
        if ((file !== state.suiteFile || state.view !== "suite-workspace") && state.suites.some(s => s.file === file)) await openSuite(file);
      } else if (raw && (raw !== state.file || state.view !== "workspace") && state.tests.some(t => t.file === raw)) {
        await openTest(raw);
      }
    }
    window.addEventListener("hashchange", followRoute);
    activateView("overview", "empty");
    await followRoute();
  }

  function wireAccessibleDialogs() {
    for (const input of document.querySelectorAll("input, select")) {
      if (!input.labels?.length && !input.hasAttribute("aria-label")) input.setAttribute("aria-label", input.placeholder || input.id.replaceAll("-", " "));
    }
    for (const overlay of document.querySelectorAll(".modal-overlay")) {
      const dialog = overlay.querySelector(".modal");
      if (!dialog) continue;
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.tabIndex = -1;
      const title = dialog.querySelector("h2");
      if (title) { title.id ||= `${overlay.id}-title`; dialog.setAttribute("aria-labelledby", title.id); }
      let previousFocus;
      new MutationObserver(() => {
        if (!overlay.hidden) {
          if (!overlay.contains(document.activeElement)) previousFocus = document.activeElement;
          (dialog.querySelector("input:not([hidden]), button:not([disabled]), select") || dialog).focus();
        } else if (previousFocus?.isConnected) {
          (previousFocus.closest("details:not([open])")?.querySelector("summary") || previousFocus).focus();
        }
      }).observe(overlay, { attributes: true, attributeFilter: ["hidden"] });
      overlay.addEventListener("keydown", event => {
        if (event.key !== "Tab") return;
        const focusable = [...dialog.querySelectorAll("button, input, select, a[href], [tabindex='0']")].filter(node => !node.disabled && node.getClientRects().length);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (!first) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      });
    }
  }

  boot();
})();
