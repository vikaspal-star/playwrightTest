/* Run evidence stays on the local server and uses the run's existing access rules. */
(() => {
  let services;
  const time = value => value === undefined || value === null ? "—" : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
  const tabs = [["commands", "Commands"], ["logs", "Logs"], ["network", "Network"], ["evidence", "Video & screenshots"], ["metadata", "Metadata"], ["performance", "Performance"], ["visual", "Visual comparison"], ["accessibility", "Accessibility"]];
  function options() { try { return { video: true, accessibility: false, ...JSON.parse(localStorage.getItem("mmqa.capture") || "{}") }; } catch { return { video: true, accessibility: false }; } }
  function settings() {
    const saved = options();
    for (const key of ["video", "accessibility"]) {
      const input = document.getElementById(`capture-${key}`); input.checked = saved[key];
      input.onchange = () => { try { localStorage.setItem("mmqa.capture", JSON.stringify({ video: document.getElementById("capture-video").checked, accessibility: document.getElementById("capture-accessibility").checked })); services.toast("Capture preferences saved for this browser", "ok"); } catch { services.toast("Browser storage is unavailable", "error"); } };
    }
  }
  async function open(id) {
    const { el, api } = services;
    document.querySelector(".run-inspector")?.close();
    const origin = document.activeElement;
    const dialog = el("dialog", { class: "run-inspector", "aria-labelledby": "inspector-title" });
    const heading = el("h2", { id: "inspector-title", text: "Run details" });
    const summary = el("div", { class: "inspector-summary" });
    const content = el("div", { class: "inspector-content", tabindex: 0 });
    const nav = el("div", { class: "inspector-tabs", role: "tablist", "aria-label": "Run detail tabs" });
    const close = el("button", { class: "btn", text: "Close", "aria-label": "Close run details", onclick: () => dialog.close() });
    dialog.append(el("header", { class: "inspector-heading" }, el("div", {}, el("span", { class: "eyebrow", text: "RUN INSPECTOR" }), heading), close), summary, nav, content);
    document.body.append(dialog); dialog.addEventListener("close", () => { dialog.remove(); origin?.focus(); }); dialog.showModal();
    let data, active = "commands", selectedStep = 1, revision = 0;
    const note = text => el("p", { class: "inspector-note", text });
    const asset = (run, file) => `/runs/${encodeURIComponent(run.id)}/${file.split("/").map(encodeURIComponent).join("/")}`;
    const picture = (run, step) => step?.screenshot ? el("a", { href: asset(run, step.screenshot), target: "_blank", rel: "noopener" }, el("img", { class: "inspector-image", src: asset(run, step.screenshot), alt: `${run.name}, step ${step.index}: ${step.action}`, loading: "lazy" })) : note("No screenshot was captured for this step.");
    const table = (headers, rows) => el("div", { class: "inspector-table-wrap" }, el("table", { class: "report-table" }, el("thead", {}, el("tr", {}, ...headers.map(text => el("th", { text })))), el("tbody", {}, ...rows.map(cells => el("tr", {}, ...cells.map(cell => el("td", {}, cell)))))));
    const cards = values => el("div", { class: "inspector-cards" }, ...values.map(([label, value]) => el("div", {}, el("span", { text: label }), el("strong", { text: String(value) }))));
    const diagNote = () => note(data.run.status === "running" ? "Capture is in progress. Refresh to see the latest completed steps." : "This older run has no diagnostic capture. Run it again to collect this evidence.");
    const buttons = tabs.map(([key, label], index) => {
      const button = el("button", { role: "tab", id: `inspector-tab-${key}`, "aria-controls": "inspector-tab-content", "aria-selected": String(key === active), tabindex: key === active ? 0 : -1, text: label, onclick: () => select(key) });
      button.addEventListener("keydown", event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length; select(tabs[next][0]); buttons[next].focus(); });
      return button;
    });
    nav.append(...buttons); content.id = "inspector-tab-content"; content.setAttribute("role", "tabpanel");
    function select(key) { active = key; buttons.forEach((button, i) => { button.setAttribute("aria-selected", String(tabs[i][0] === key)); button.tabIndex = tabs[i][0] === key ? 0 : -1; }); content.setAttribute("aria-labelledby", `inspector-tab-${key}`); content.scrollTop = 0; render(); }
    async function refresh() {
      const request = ++revision; content.replaceChildren(note("Loading run evidence…"));
      try {
        const result = await api(`/api/runs/${encodeURIComponent(id)}/evidence`);
        if (!dialog.open || request !== revision) return; data = result; heading.textContent = data.run.name || data.run.file;
        summary.replaceChildren(el("span", { class: `badge ${data.run.status}`, text: data.run.status }), el("span", { text: `${data.run.steps.filter(s => s.status === "passed").length}/${data.run.steps.length} steps · ${time(data.run.durationMs)}` }), el("span", { text: new Date(data.run.startedAt).toLocaleString() }), el("button", { class: "btn-link", text: "Refresh run", onclick: refresh }));
        if (data.run.status !== "running") summary.append(el("a", { class: "btn-link", href: `/api/runs/${encodeURIComponent(id)}/evidence?download=1`, download: "", text: "Export evidence JSON" }));
        select(active);
      } catch (error) { if (dialog.open && request === revision) content.replaceChildren(note(error.message), el("button", { class: "btn", text: "Retry", onclick: refresh })); }
    }
    function render() {
      if (!data) return;
      const { run, diagnostics: d } = data; content.replaceChildren();
      if (active === "commands") {
        const search = el("input", { type: "search", placeholder: "Search actions or test files…", "aria-label": "Search commands" });
        const filter = el("select", { "aria-label": "Command status" }, ...["all", "failed", "passed", "skipped", "running", "pending"].map(value => el("option", { value, text: value === "all" ? "All steps" : value })));
        const list = el("div", { class: "inspector-command-list" }); const viewer = el("div", { class: "inspector-step-evidence" });
        const show = () => {
          const step = run.steps.find(s => s.index === selectedStep) || run.steps[0]; viewer.replaceChildren(); if (!step) return;
          viewer.append(el("h3", { text: `Step ${step.index} · ${step.action}` }), note(`${step.testFile || run.file} · ${step.status} · ${time(step.durationMs)}`), picture(run, step));
          if (step.error) viewer.append(el("pre", { class: "inspector-error", text: step.error }));
          list.querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", String(Number(button.dataset.step) === selectedStep)));
        };
        const draw = () => { const rows = run.steps.filter(s => (filter.value === "all" || s.status === filter.value) && `${s.index} ${s.action} ${s.testFile || run.file}`.toLowerCase().includes(search.value.toLowerCase())); list.replaceChildren(...rows.map(s => el("button", { class: "inspector-command", "data-step": s.index, onclick: () => { selectedStep = s.index; show(); } }, el("span", { class: `badge ${s.status}`, text: s.status }), el("strong", { text: `${s.index}. ${s.action}` }), el("small", { text: `${s.testFile || run.file} · ${time(s.durationMs)}` })))); if (!rows.length) list.append(note("No matching commands.")); show(); };
        search.oninput = draw; filter.onchange = draw;
        content.append(el("div", { class: "inspector-tools" }, search, filter, el("button", { class: "btn", text: "First failure", onclick: () => { const step = run.steps.find(s => s.status === "failed"); if (step) { selectedStep = step.index; search.value = ""; filter.value = "failed"; draw(); } else services.toast("No failed step in this run"); } })), el("div", { class: "inspector-command-layout" }, list, viewer)); draw();
      } else if (active === "logs") {
        const source = el("select", { "aria-label": "Log source" }, el("option", { value: "browser", text: "Browser console" }), el("option", { value: "terminal", text: "Runner / terminal" }));
        const query = el("input", { type: "search", placeholder: "Search logs…", "aria-label": "Search logs" });
        const level = el("select", { "aria-label": "Log level" }, ...["all", "error", "warning", "info"].map(value => el("option", { value, text: value === "all" ? "All levels" : value })));
        const output = el("div");
        const draw = () => {
          level.disabled = source.value === "terminal";
          if (source.value === "browser" && !d) { output.replaceChildren(diagNote()); return; }
          const rows = source.value === "terminal" ? run.log.filter(line => !line.startsWith("@@STEP ") && !line.startsWith("@@TEST ")) : d.console.filter(line => level.value === "all" || (level.value === "error" ? ["error", "pageerror"].includes(line.level) : level.value === "warning" ? line.level === "warning" || line.level === "warn" : ["info", "log", "debug"].includes(line.level))).map(line => `[${time(line.at)}] [step ${line.step}] ${line.level}: ${line.text}`);
          const filtered = rows.filter(line => line.toLowerCase().includes(query.value.toLowerCase())); output.replaceChildren(filtered.length ? el("pre", { class: "inspector-log", text: filtered.join("\n") }) : note("No matching log entries."));
        }; source.onchange = draw; query.oninput = draw; level.onchange = draw;
        content.append(note("Browser messages are captured during test actions. Common token/password fields and URL queries are redacted; application logs can still contain business data."), el("div", { class: "inspector-tools" }, source, level, query), output); draw();
        if (d?.omitted.console) content.append(note(`${d.omitted.console} entries omitted after the 500-entry capture limit.`));
      } else if (active === "network") {
        if (!d) { content.append(diagNote()); return; }
        const query = el("input", { type: "search", placeholder: "Search URL or method…", "aria-label": "Search network" });
        const filter = el("select", { "aria-label": "Network status" }, el("option", { value: "all", text: "All requests" }), el("option", { value: "failed", text: "Failed requests" }));
        const output = el("div"); const failed = row => row.error || row.status >= 400;
        const draw = () => { const rows = d.network.filter(row => (filter.value === "all" || failed(row)) && `${row.method} ${row.url}`.toLowerCase().includes(query.value.toLowerCase())); const total = Math.max(1, ...d.network.map(row => row.at + (row.durationMs || 0))); output.replaceChildren(rows.length ? table(["Request", "Status", "Type / step", "Duration", "Timeline"], rows.map(row => [el("div", {}, el("strong", { text: row.method }), el("span", { class: "inspector-url", text: row.url }), row.error ? el("small", { class: "danger-text", text: row.error }) : null), el("span", { class: `badge ${failed(row) ? "failed" : row.status ? "passed" : "none"}`, text: row.status || (row.error ? "Failed" : "Pending") }), `${row.type} · ${row.step}`, time(row.durationMs), el("span", { class: "network-waterfall", title: `Started ${time(row.at)} after capture began` }, el("i", { style: `margin-left:${row.at / total * 100}%;width:${Math.max(0.5, (row.durationMs || 0) / total * 100)}%` }))])) : note("No matching network requests.")); };
        query.oninput = draw; filter.onchange = draw; content.append(cards([["Captured requests", d.network.length], ["Failed requests", d.network.filter(failed).length], ["Omitted", d.omitted.network]]), note("Request metadata only. Headers, bodies, URL credentials and query values are excluded. Timing measures observed request completion, not load-test throughput."), el("div", { class: "inspector-tools" }, query, filter), output); draw();
      } else if (active === "evidence") {
        if (data.videos.length) {
          const video = el("video", { class: "inspector-video", controls: true, preload: "metadata", src: asset(run, data.videos[0]) });
          const download = el("a", { href: asset(run, data.videos[0]), download: "", class: "btn-link", text: "Download video" });
          const picker = el("select", { "aria-label": "Recorded page", onchange: event => { video.src = asset(run, event.target.value); download.href = video.src; } }, ...data.videos.map((file, index) => el("option", { value: file, text: `Page recording ${index + 1}` })));
          content.append(el("div", { class: "inspector-tools" }, picker, download), video);
        } else content.append(note(run.status === "running" ? "Video becomes available when the browser closes." : run.capture?.video === false ? "Video recording was disabled for this run." : "No video was saved for this run."));
        const shots = run.steps.filter(step => step.screenshot); content.append(el("h3", { text: `Step screenshots · ${shots.length}` }), el("div", { class: "inspector-gallery" }, ...shots.map(step => el("figure", {}, picture(run, step), el("figcaption", { text: `${step.index}. ${step.action} · ${step.status}` })))));
      } else if (active === "metadata") {
        const c = d?.configuration;
        content.append(table(["Field", "Recorded value"], [["Run ID", run.id], ["Type", run.kind || "test"], ["Source", run.file], ["Started by", run.startedBy || "Unknown"], ["Started", new Date(run.startedAt).toLocaleString()], ["Finished", run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "In progress"], ["Browser", c ? `${c.browser} ${c.browserVersion}` : "Not captured"], ["Operating system", c?.os || "Not captured"], ["Viewport", c?.viewport ? `${c.viewport.width} × ${c.viewport.height}` : "Not captured"], ["Node.js", c?.node || "Not captured"], ["Video", run.capture ? run.capture.video ? "Enabled" : "Disabled" : "Not captured"], ["Accessibility", run.capture?.accessibility ? "Enabled" : "Not enabled"]]), el("h3", { text: "Project context at execution" }), run.projectContext?.length ? table(["Test", "Project", "Environment"], run.projectContext.map(p => [p.file, p.project, p.environment])) : note("Project context was not captured for this older run."));
      } else if (active === "performance") {
        const steps = run.steps.filter(s => s.durationMs !== undefined).sort((a, b) => b.durationMs - a.durationMs);
        content.append(note("Observed execution and navigation timings. These are diagnostic samples, not a Lighthouse score or a load test. Repeated page samples show the same navigation until the page reloads."), cards([["Run duration", time(run.durationMs)], ["Measured step time", time(steps.reduce((n, s) => n + s.durationMs, 0))], ["Slowest step", steps[0] ? `${steps[0].index}. ${steps[0].action}` : "—"]]), el("h3", { text: "Slowest steps" }), table(["Step", "Action", "Status", "Duration"], steps.slice(0, 20).map(s => [s.index, s.action, s.status, time(s.durationMs)])), el("h3", { text: "Page navigation samples" }), d?.performance.length ? table(["Step / page", "TTFB", "DOM ready", "Load event"], d.performance.map(p => [`${p.step} · ${p.url}`, time(p.ttfbMs), time(p.domContentLoadedMs), time(p.loadMs)])) : note("No navigation timings captured."));
      } else if (active === "accessibility") {
        content.append(note("Optional axe-core WCAG 2.1 A/AA checks on the final reached page of each test, up to 10 tests per run. Findings are advisory and do not change the functional test result. Manual keyboard and screen-reader testing is still needed."));
        if (!d || !d.options.accessibility) { content.append(note("Enable Accessibility checks in Settings before your next run.")); return; }
        if (!d.accessibility.length) content.append(note(run.status === "running" ? "Accessibility checks run after the test actions." : "No accessibility scan completed; the run may have stopped before scanning."));
        for (const scan of d.accessibility) {
          content.append(el("h3", { text: scan.testFile }), note(`${scan.url} · ${scan.engine || scan.status}`));
          if (scan.status === "error") { content.append(el("p", { class: "inspector-error", text: scan.error })); continue; }
          content.append(cards([["Violations", scan.violations.length], ["Rules passed", scan.passed], ["Need manual review", scan.incomplete]]));
          for (const issue of scan.violations) content.append(el("article", { class: "inspector-finding" }, el("span", { class: "badge failed", text: issue.impact || "Unrated" }), el("h4", { text: issue.help }), note(`${issue.id} · ${issue.affectedNodes} affected elements`), el("pre", { text: issue.targets.join("\n") }), el("a", { href: issue.helpUrl, target: "_blank", rel: "noopener", text: "Rule guidance ↗" })));
        }
        if (d.omitted.accessibility) content.append(note(`${d.omitted.accessibility} tests exceeded the 10-scan limit.`));
      } else if (active === "visual") { void visual(); }
    }
    async function visual() {
      const current = data.run;
      content.append(note("Compare screenshots with an earlier run of the same test or suite. This is a manual visual review: step changes, dynamic data and viewport differences can affect the comparison. No automatic pass/fail is assigned."));
      const body = el("div"); content.append(body); body.append(note("Loading earlier runs…"));
      try {
        const history = await api(`/api/runs?test=${encodeURIComponent(current.file)}&kind=${current.kind || "test"}`);
        if (!dialog.open || active !== "visual" || data.run !== current) return;
        const candidates = history.filter(r => r.id !== current.id && r.status !== "running" && r.startedAt < current.startedAt).slice(0, 30);
        if (!candidates.length) { body.replaceChildren(note("No earlier completed run is available for comparison.")); return; }
        const picker = el("select", { "aria-label": "Compare with run" }, ...candidates.map(r => el("option", { value: r.id, text: `${new Date(r.startedAt).toLocaleString()} · ${r.status}` })));
        const stepPicker = el("select", { "aria-label": "Comparison step" }, ...current.steps.map(s => el("option", { value: s.index, text: `${s.index}. ${s.action}` })));
        const pair = el("div", { class: "inspector-comparison" }); let earlier, pending = 0;
        const draw = () => { const step = current.steps.find(s => s.index === Number(stepPicker.value)); const old = earlier?.steps.find(s => s.index === step.index && s.action === step.action && s.testFile === step.testFile); pair.replaceChildren(el("section", {}, el("h3", { text: "Earlier run" }), old ? picture(earlier, old) : note("No matching step in the earlier run.")), el("section", {}, el("h3", { text: "Selected run" }), picture(current, step))); };
        const load = async () => { const ticket = ++pending; pair.replaceChildren(note("Loading comparison…")); try { const result = await api(`/api/runs/${encodeURIComponent(picker.value)}`); if (ticket !== pending || !dialog.open || active !== "visual") return; earlier = result; draw(); } catch (error) { if (ticket === pending) pair.replaceChildren(note(error.message)); } };
        picker.onchange = load; stepPicker.onchange = () => { if (earlier) draw(); }; body.replaceChildren(el("div", { class: "inspector-tools" }, picker, stepPicker), pair); await load();
      } catch (error) { body.replaceChildren(note(error.message)); }
    }
    await refresh();
  }
  async function history(container) {
    const { api, el } = services;
    container.replaceChildren(el("p", { class: "muted", text: "Loading runs…" }));
    try {
      const runs = await api("/api/runs");
      const search = el("input", { type: "search", "aria-label": "Search run history", placeholder: "Search tests, suites or run IDs…" });
      const status = el("select", { "aria-label": "Run status" }, ...["all", "passed", "failed", "running"].map(value => el("option", { value, text: value === "all" ? "All statuses" : value })));
      const list = el("div", { class: "inspector-history-list" }); const count = el("span", { class: "muted" }); let limit = 15;
      const more = el("button", { class: "btn", text: "Show next 15 runs", onclick: () => { limit += 15; draw(); } });
      const draw = () => { const rows = runs.filter(r => (status.value === "all" || r.status === status.value) && `${r.name} ${r.file} ${r.id}`.toLowerCase().includes(search.value.toLowerCase())); count.textContent = `${Math.min(limit, rows.length)} of ${rows.length} runs`; more.hidden = limit >= rows.length; list.replaceChildren(...rows.slice(0, limit).map(r => el("button", { class: "inspector-history-row", onclick: () => open(r.id) }, el("span", { class: `badge ${r.status}`, text: r.status }), el("span", {}, el("strong", { text: r.name || r.file }), el("small", { text: `${r.kind || "test"} · ${new Date(r.startedAt).toLocaleString()} · ${r.startedBy || "Unknown"}` })), el("span", { text: time(r.durationMs) }), el("span", { text: "Inspect →" })))); if (!rows.length) list.append(el("p", { class: "muted", text: "No matching runs." })); };
      search.oninput = status.onchange = () => { limit = 15; draw(); }; container.replaceChildren(el("div", { class: "inspector-tools" }, search, status, count), list, more); draw();
    } catch (error) { container.replaceChildren(el("p", { class: "muted", text: error.message })); }
  }
  window.RunInspector = { init(deps) { services = deps; settings(); }, open, options, history };
})();
