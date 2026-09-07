/* Chat-agent evaluation workspace. Uses the same session and design system as Studio. */
window.AgentTesting = (() => {
  "use strict";
  let ctx, root, plans = [], selected = null, draft = null, dirty = false, aiConfigured = false;
  let tab = "connection", runs = [], run = null, timer, loading = false, generation = 0;
  let manualDraft = null;
  const $ = id => document.getElementById(id);
  const node = (...args) => ctx.el(...args);
  const button = (text, action, primary = false) => node("button", { type: "button", class: `btn${primary ? " btn-primary" : ""}`, onclick: action }, text);
  const badge = status => node("span", { class: `agent-badge agent-${status}` }, ({ review: "Needs review", passed: "Passed", failed: "Failed", running: "Running", error: "Error", cancelled: "Cancelled" }[status] || status));
  const initialScenario = () => ({ name: "Helpful first response", persona: "A new customer who needs clear, simple guidance.", goal: "Get a useful answer and a clear next step.", mode: "scripted", messages: ["Hello, what can you help me with?", "Can you explain the next step?"], maxTurns: 3, criteria: [{ name: "Provides a next step", kind: "contains", value: "help", critical: true, threshold: 0.8 }] });
  const initial = () => ({ testType: "api", name: "", projectId: ctx.projects[0]?.id || "", environmentId: ctx.projects[0]?.environments[0]?.id || "", requirements: "", endpoint: "", headersEnv: "", body: { message: "{{message}}", messages: "{{messages}}", sessionId: "{{sessionId}}" }, responsePath: "reply", profile: {}, iterations: 1, timeoutMs: 15000, scenarios: [initialScenario()] });
  function changed() { dirty = true; const status = $("agent-save-state"); if (status) status.textContent = "Unsaved changes"; }
  function field(label, value, set, options = {}) {
    const { area, choices, help, number, ...attrs } = options;
    const input = choices ? node("select", attrs, choices.map(([value, label]) => node("option", { value }, label))) : node(area ? "textarea" : "input", { ...attrs, type: area ? undefined : number ? "number" : "text", rows: area ? 4 : undefined });
    input.value = value;
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => { set(number ? Number(input.value) : input.value); changed(); });
    return node("label", { class: "agent-field" }, node("span", {}, label), input, help ? node("small", {}, help) : null);
  }
  function jsonField(label, key, help) {
    const value = typeof draft[key] === "string" ? draft[key] : JSON.stringify(draft[key], null, 2);
    return field(label, value, value => { draft[key] = value; }, { area: true, class: "agent-code", spellcheck: "false", help });
  }
  function payload() {
    const value = structuredClone(draft);
    for (const key of ["body", "profile"]) if (typeof value[key] === "string") {
      try { value[key] = JSON.parse(value[key]); } catch { throw new Error(`Fix the JSON in ${key === "body" ? "Request body" : "Test data profile"}.`); }
    }
    return value;
  }
  async function attempt(action) {
    const error = $("agent-error"); if (error) error.hidden = true;
    try { await action(); } catch (e) {
      const error = $("agent-error"); if (error) { error.textContent = e.message; error.hidden = false; error.focus(); } else ctx.toast(e.message, "error");
    }
  }
  async function choose(saved) {
    if (dirty && !await ctx.confirmDialog("Discard unsaved agent test changes?", { title: "Unsaved changes", okLabel: "Discard changes" })) return;
    generation++; clearTimeout(timer); selected = saved; draft = structuredClone(saved?.plan || initial()); dirty = false; tab = "connection"; run = null; runs = []; manualDraft = null;
    render();
    if (saved) await attempt(loadHistory);
  }
  async function save() {
    const next = payload();
    const saved = await ctx.api(selected ? `/api/agent-tests/${selected.id}` : "/api/agent-tests", { method: selected ? "PUT" : "POST", body: JSON.stringify(selected ? { revision: selected.revision, plan: next } : next) });
    selected = saved; draft = structuredClone(saved.plan); dirty = false;
    plans = plans.filter(p => p.id !== saved.id); plans.unshift(saved); render(); ctx.toast("Agent test saved", "ok");
    return saved;
  }
  async function loadHistory() {
    const id = selected?.id; if (!id) return;
    const data = await ctx.api(`/api/agent-tests/${id}/runs`);
    if (selected?.id !== id) return;
    runs = data;
    if (tab === "results") renderResults();
  }
  async function openRun(id) {
    clearTimeout(timer);
    const stamp = generation;
    const result = await ctx.api(`/api/agent-tests/runs/${id}`);
    if (generation !== stamp) return;
    run = result; tab = "results"; render();
    if (run.status === "running") timer = setTimeout(() => attempt(() => pollRun(id, stamp)), 1400);
    else await loadHistory();
  }
  async function pollRun(id, stamp) {
    if (generation !== stamp || run?.id !== id) return;
    const result = await ctx.api(`/api/agent-tests/runs/${id}`);
    if (generation !== stamp || run?.id !== id) return;
    run = result;
    if (tab === "results" && !root.hidden) renderResults();
    if (result.status === "running") timer = setTimeout(() => attempt(() => pollRun(id, stamp)), 1400);
    else await loadHistory();
  }
  async function startRun(index) {
    if (loading) return;
    if (manualDraft?.replies.some(replies => replies.some(Boolean)) && !await ctx.confirmDialog("Start again and discard the replies in this manual test?", { title: "Manual evidence", okLabel: "Start again" })) return;
    loading = true;
    try {
      if (dirty || !selected) await save();
      if (draft.testType === "manual") {
        manualDraft = { revision: selected.revision, index, scenarios: index === undefined ? structuredClone(draft.scenarios) : [structuredClone(draft.scenarios[index])], replies: [] };
        manualDraft.replies = manualDraft.scenarios.map(s => s.messages.map(() => ""));
        tab = "manual"; render(); return;
      }
      const result = await ctx.api(`/api/agent-tests/${selected.id}/run`, { method: "POST", body: JSON.stringify({ revision: selected.revision, scenarioIndex: index }) });
      await loadHistory(); await openRun(result.id);
    } finally { loading = false; }
  }
  function render() {
    root.replaceChildren();
    const head = node("div", { class: "page-heading" }, node("div", {}, node("span", { class: "eyebrow" }, "CONVERSATIONS → EVIDENCE"), node("h1", {}, "Agent Testing"), node("p", {}, "Test manually or through an API. Add AI when you need it.")), button("+ New agent test", () => choose(null), true));
    const library = node("aside", { class: "agent-library surface", "aria-label": "Agent tests" }, node("div", { class: "agent-library-heading" }, node("h2", {}, "Your agents"), node("span", { class: "heading-count" }, plans.length)));
    for (const saved of plans) {
      const project = ctx.projects.find(p => p.id === saved.plan.projectId);
      library.append(node("button", { class: `agent-library-item${selected?.id === saved.id ? " selected" : ""}`, "aria-pressed": selected?.id === saved.id, onclick: () => choose(saved) }, node("strong", {}, saved.plan.name), node("small", {}, `${project?.name || "Project unavailable"} · ${saved.plan.scenarios.length} scenarios`)));
    }
    if (!plans.length) library.append(node("p", { class: "agent-muted" }, "Save your first agent test to build a reusable conversation library."));
    library.append(node("div", { class: "agent-library-note" }, "Manual + API testing", node("br"), "Private to you and site admins"));
    const workspace = node("div", { class: "agent-workspace" });
    if (!draft) {
      workspace.append(node("section", { class: "agent-welcome surface" }, node("span", { class: "eyebrow" }, "A TEST PLAN FOR YOUR AI"), node("h2", {}, "Better conversations start with better tests."), node("p", {}, "Choose manual testing or connect an API, describe expected behavior, then run scenarios with different personas."),
        node("div", { class: "agent-workflow" }, ["01 Connect your agent", "02 Define conversations", "03 Review the evidence"].map(text => node("div", {}, text))), button("Create your first agent test", () => choose(null), true), node("small", {}, "Scripted conversations and text checks work without an AI key. Adaptive personas and rubric checks use your configured AI provider.")));
    } else {
      const top = node("div", { class: "agent-editor-heading" }, node("div", {}, node("h2", {}, draft.name || "New agent test"), node("small", { id: "agent-save-state" }, dirty ? "Unsaved changes" : selected ? "All changes saved" : "Not saved yet")), node("div", { class: "agent-actions" }, button("Save", () => attempt(save)), button(draft.testType === "manual" ? "Start manual test" : "Run all scenarios", () => attempt(() => startRun()), true)));
      const tabs = node("div", { class: "agent-tabs", "aria-label": "Agent test sections" }, [["connection", "1  Connection"], ["scenarios", "2  Scenarios"], ["results", "3  Results"], ...(manualDraft ? [["manual", "Manual evidence"]] : [])].map(([id, label]) => node("button", { type: "button", class: tab === id ? "active" : "", "aria-pressed": tab === id, onclick: () => { tab = id; render(); if (id === "results") attempt(loadHistory); } }, label)));
      workspace.append(top, tabs, node("p", { id: "agent-error", class: "agent-error", role: "alert", tabindex: "-1", hidden: true }), node("div", { id: "agent-content" }));
    }
    root.append(head, node("div", { class: "agent-layout" }, library, workspace));
    if (draft) { if (tab === "connection") renderConnection(); else if (tab === "scenarios") renderScenarios(); else if (tab === "manual") renderManual(); else renderResults(); }
  }
  function renderConnection() {
    const project = ctx.projects.find(p => p.id === draft.projectId);
    const manual = draft.testType === "manual";
    const connection = node("section", { class: "surface agent-card" }, node("h3", {}, "Choose how to test"), field("Testing method", draft.testType || "api", v => { draft.testType = v; if (v === "manual") { draft.iterations = 1; draft.scenarios.forEach(s => s.mode = "scripted"); } changed(); render(); }, { choices: [["api", "API testing — call a chat endpoint"], ["manual", "Manual testing — enter observed replies"]] }), node("p", { class: "agent-muted" }, manual ? "Follow each scenario in your agent's interface and enter its actual replies. An API connection is not required." : "MMQA sends JSON messages to this endpoint and reads a text reply. Each scenario gets a fresh session ID."));
    connection.append(node("div", { class: "agent-form-grid" }, field("Agent name", draft.name, v => draft.name = v, { maxlength: 100, placeholder: "Customer support agent" }),
      field("Project", draft.projectId, v => { draft.projectId = v; draft.environmentId = ctx.projects.find(p => p.id === v)?.environments[0]?.id || ""; renderConnection(); }, { choices: [["", "Choose project"], ...ctx.projects.map(p => [p.id, p.name])] }),
      field("Environment", draft.environmentId, v => draft.environmentId = v, { choices: [["", "Choose environment"], ...(project?.environments || []).map(e => [e.id, e.name])] }),
      field("Chat API URL", draft.endpoint, v => draft.endpoint = v, { type: "url", placeholder: "https://your-agent.example/chat", help: "The exact endpoint is saved for this environment. HTTP is supported on localhost." }),
      field("Response path", draft.responsePath, v => draft.responsePath = v, { placeholder: "reply", help: "Examples: reply, output.0.content, choices.0.message.content" }),
      field("Server headers variable (optional)", draft.headersEnv, v => draft.headersEnv = v, { placeholder: "MMQA_AGENT_SUPPORT_HEADERS", help: "Name of a server environment variable containing JSON headers. Keep credentials out of this form." })));
    if (manual) for (const input of connection.querySelectorAll('input[aria-label="Chat API URL"],input[aria-label="Response path"],input[aria-label="Server headers variable (optional)"]')) input.closest("label").hidden = true;
    if (!manual) connection.append(jsonField("Request body", "body", "Use {{message}} for this turn, {{messages}} for the conversation array, {{sessionId}} for session continuity, and {{profile.key}} for test data."));
    const behavior = node("section", { class: "surface agent-card" }, node("h3", {}, "Define correct behavior"), field("Agent requirements", draft.requirements, v => draft.requirements = v, { area: true, rows: 6, maxlength: 12000, placeholder: "Describe what this agent should do, the facts it can rely on, and how it should handle uncertainty.", help: "Used as the baseline for AI generation and evaluation. Include only content you intend to send to your evaluator." }), jsonField("Test data profile", "profile", "Reusable JSON values for this agent test. For example: {\"plan\":\"standard\",\"returnWindowDays\":30}"),
      manual ? node("p", { class: "agent-notice" }, "AI is optional. On the Scenarios tab, choose AI rubric score for any check you want the model to evaluate. Text checks use no evaluator tokens.") : node("div", { class: "agent-form-grid" }, field("Iterations per scenario", draft.iterations, v => draft.iterations = v, { number: true, min: 1, max: 3 }), field("Response timeout (milliseconds)", draft.timeoutMs, v => draft.timeoutMs = v, { number: true, min: 1000, max: 30000 })), button("Continue to scenarios →", () => { tab = "scenarios"; render(); }));
    $("agent-content").replaceChildren(connection, behavior);
  }
  function renderScenarios() {
    const content = $("agent-content"); content.replaceChildren();
    const generate = button("Generate from requirements", () => attempt(async () => {
      if (!draft.requirements.trim()) throw new Error("Add agent requirements on the Connection tab first.");
      if (draft.scenarios.length > 9) throw new Error("Keep at most 9 scenarios before generating three more.");
      const stamp = generation; generate.disabled = true; generate.textContent = "Generating…";
      try {
        const data = await ctx.api("/api/agent-tests/generate", { method: "POST", body: JSON.stringify({ requirements: draft.requirements }) });
        if (stamp !== generation) return;
        draft.scenarios.push(...data.scenarios.slice(0, 12 - draft.scenarios.length)); changed(); renderScenarios();
        ctx.toast("Draft scenarios added. Review them before running.", "ok");
      } finally { generate.disabled = false; generate.textContent = "Generate from requirements"; }
    }));
    generate.disabled = !aiConfigured || !ctx.can("ai.analyze");
    content.append(node("div", { class: "agent-section-heading" }, node("div", {}, node("h3", {}, `${draft.scenarios.length} conversation scenarios`), node("p", { class: "agent-muted" }, "Set a persona, a goal, and observable checks for each conversation.")), node("div", { class: "agent-actions" }, generate, button("+ Add scenario", () => { if (draft.scenarios.length >= 12) return ctx.toast("Maximum 12 scenarios per agent test."); draft.scenarios.push(initialScenario()); changed(); renderScenarios(); }))));
    if (!aiConfigured) content.append(node("p", { class: "agent-notice" }, "AI is not configured. Scripted messages and text checks are available now. AI generation, adaptive follow-ups and rubric checks need ANTHROPIC_API_KEY on the server."));
    draft.scenarios.forEach((s, index) => {
      const details = node("details", { class: "surface agent-scenario", open: index === 0 }, node("summary", {}, node("span", { class: "agent-number" }, String(index + 1).padStart(2, "0")), node("strong", {}, s.name || "Untitled scenario"), node("small", {}, `${s.mode} · ${s.criteria.length} checks`)));
      const body = node("div", { class: "agent-scenario-body" },
        field("Scenario name", s.name, v => s.name = v, { maxlength: 100 }),
        node("div", { class: "agent-form-grid" }, field("Persona", s.persona, v => s.persona = v, { area: true }), field("Conversation goal", s.goal, v => s.goal = v, { area: true })),
        node("div", { class: "agent-form-grid" }, field("Conversation mode", s.mode, v => { s.mode = v; changed(); }, { choices: draft.testType === "manual" ? [["scripted", "Manual scripted conversation"]] : [["scripted", "Scripted messages"], ["adaptive", "AI adaptive persona"]], help: "Adaptive mode starts with the first message, then generates follow-ups from the replies." }), field("Maximum turns", s.maxTurns, v => s.maxTurns = v, { number: true, min: 1, max: 8 })),
        field("User messages (one per line)", s.messages.join("\n"), v => s.messages = v.split("\n").filter(m => m.trim()), { area: true, help: "Scripted mode sends every line in order. Persona and goal guide AI mode; scripted messages are sent exactly as written." }), node("h4", {}, "Validation checks"));
      s.criteria.forEach((c, ci) => {
        const row = node("div", { class: "agent-check" }, node("div", { class: "agent-form-grid" }, field("Check name", c.name, v => c.name = v), field("Check type", c.kind, v => c.kind = v, { choices: [["contains", "Reply contains text"], ["not-contains", "Reply excludes text"], ["ai", "AI rubric score"]] })),
          field("Expected behavior or text", c.value, v => c.value = v, { area: true, rows: 2 }), node("div", { class: "agent-form-grid" }, field("Minimum AI score", c.threshold, v => c.threshold = v, { number: true, min: 0, max: 1, step: 0.05, help: "0–1, higher is better. Text checks always use exact, case-insensitive matching." }), field("Priority", String(c.critical), v => c.critical = v === "true", { choices: [["true", "Critical — failure blocks this test"], ["false", "Advisory — failure needs review"]] })), button("Remove check", () => { if (s.criteria.length <= 1) return ctx.toast("Keep at least one check."); s.criteria.splice(ci, 1); changed(); renderScenarios(); }));
        body.append(row);
      });
      body.append(node("div", { class: "agent-actions" }, button("+ Add check", () => { if (s.criteria.length >= 8) return ctx.toast("Maximum 8 checks per scenario."); s.criteria.push({ name: "New check", kind: "contains", value: "", critical: true, threshold: 0.8 }); changed(); renderScenarios(); }), button("Run this scenario", () => attempt(() => startRun(index))), button("Remove scenario", () => { if (draft.scenarios.length <= 1) return ctx.toast("Keep at least one scenario."); draft.scenarios.splice(index, 1); changed(); renderScenarios(); })));
      details.append(body); content.append(details);
    });
  }
  function renderManual() {
    const content = $("agent-content"); content.replaceChildren();
    if (!manualDraft) { content.append(node("p", {}, "Start a manual test to record responses.")); return; }
    content.append(node("section", { class: "surface agent-card" }, node("h3", {}, "Record your manual test"), node("p", { class: "agent-muted" }, "Send these messages to your agent in order. Paste its real reply after each message. Results will be marked as manually entered evidence.")));
    manualDraft.scenarios.forEach((s, si) => {
      const card = node("section", { class: "surface agent-card" }, node("h3", {}, s.name), node("p", { class: "agent-muted" }, `${s.persona} · ${s.goal}`));
      s.messages.forEach((message, mi) => card.append(node("div", { class: "agent-message user" }, node("small", {}, `Message ${mi + 1} · Send to your agent`), node("p", {}, message)), field(`Observed reply ${si + 1}.${mi + 1}`, manualDraft.replies[si][mi], value => { manualDraft.replies[si][mi] = value; }, { area: true, maxlength: 12000, placeholder: "Paste the actual agent response…" })));
      content.append(card);
    });
    content.append(button("Save evidence & evaluate", () => attempt(async () => {
      if (loading) return;
      if (manualDraft.replies.some(replies => replies.some(reply => !reply.trim()))) throw new Error("Enter every observed reply before evaluating.");
      loading = true;
      try {
        const result = await ctx.api(`/api/agent-tests/${selected.id}/run`, { method: "POST", body: JSON.stringify({ revision: manualDraft.revision, scenarioIndex: manualDraft.index, manualReplies: manualDraft.replies }) });
        dirty = false; manualDraft = null; await loadHistory(); await openRun(result.id);
      } finally { loading = false; }
    }), true));
  }
  function renderResults() {
    const content = $("agent-content"); if (!content || tab !== "results") return;
    content.replaceChildren();
    const history = node("div", { class: "surface agent-card" }, node("div", { class: "agent-section-heading" }, node("h3", {}, "Run history"), button("Refresh", () => attempt(loadHistory))));
    if (!runs.length) history.append(node("p", { class: "agent-muted" }, "No runs yet. Save your agent test and run a scenario to collect evidence."));
    else history.append(node("div", { class: "agent-history" }, runs.map(r => node("button", { class: `agent-history-item${run?.id === r.id ? " selected" : ""}`, onclick: () => attempt(() => openRun(r.id)) }, node("span", {}, new Date(r.startedAt).toLocaleString()), badge(r.status), node("small", {}, `${r.passed}/${r.count} passed`)))));
    content.append(history);
    if (!run) return;
    const completed = run.results.filter(r => r.status !== "running").length;
    const expected = run.plan.scenarios.length * run.plan.iterations;
    const actions = node("div", { class: "agent-actions" });
    if (run.status === "running") actions.append(button("Stop run", () => attempt(async () => { await ctx.api(`/api/agent-tests/runs/${run.id}/cancel`, { method: "POST", body: "{}" }); await openRun(run.id); })));
    else for (const [format, label] of [["json", "Export JSON"], ["junit", "Export JUnit"]]) actions.append(node("a", { class: "btn", href: `/api/agent-tests/runs/${run.id}/export?format=${format}`, download: "" }, label));
    content.append(node("section", { class: "surface agent-card" }, node("div", { class: "agent-section-heading" }, node("div", {}, node("h3", {}, "Conversation evidence"), node("p", { class: "agent-muted" }, `${completed} of ${expected} evaluations complete · ${run.plan.name} · ${run.plan.testType === "manual" ? "Manually entered evidence" : "API conversation"}`)), badge(run.status), actions), node("p", { class: "agent-notice" }, "This verdict covers the scenarios and checks in this run. It is not a production-readiness certification. AI conclusions require human review."), run.error ? node("p", { class: "agent-error" }, run.error) : null));
    run.results.forEach(result => {
      const card = node("details", { class: "surface agent-scenario", open: true }, node("summary", {}, node("strong", {}, result.name), node("small", {}, `Iteration ${result.iteration}`), badge(result.status)));
      const body = node("div", { class: "agent-evidence-grid" });
      const transcript = node("div", { class: "agent-transcript" }, node("h4", {}, "Transcript"));
      result.transcript.forEach((message, index) => transcript.append(node("div", { class: `agent-message ${message.role}` }, node("small", {}, `${index + 1} · ${message.role === "user" ? "Test persona" : "Your agent"}${message.latencyMs !== undefined ? ` · ${message.latencyMs} ms` : ""}`), node("p", {}, message.content))));
      if (!result.transcript.length) transcript.append(node("p", { class: "agent-muted" }, "Waiting for the conversation to start…"));
      const checks = node("div", { class: "agent-check-results" }, node("h4", {}, "Checks & evidence"));
      if (result.error) checks.append(node("p", { class: "agent-error" }, result.error));
      if (!result.checks.length && !result.error) checks.append(node("p", { class: "agent-muted" }, "Checks run after the conversation finishes."));
      result.checks.forEach(c => checks.append(node("div", { class: "agent-result-check" }, node("div", { class: "agent-section-heading" }, node("strong", {}, c.name), badge(c.status)), node("small", {}, `${c.critical ? "Critical" : "Advisory"} · ${c.score === null ? "Unscored" : `Score ${c.score.toFixed(2)} / threshold ${c.threshold.toFixed(2)}`}`), node("p", {}, c.reason), c.evidence ? node("blockquote", {}, c.evidence, node("cite", {}, `Transcript entry ${c.turn}`)) : null)));
      body.append(transcript, checks); card.append(body); content.append(card);
    });
  }
  return {
    async open(context) {
      ctx = context; root = $("agents-panel");
      if (!ctx.can("agents.manage")) { root.replaceChildren(node("p", {}, "Agent testing access has not been granted to this account.")); return; }
      try {
        const data = await ctx.api("/api/agent-tests"); plans = data.plans; aiConfigured = data.aiConfigured; render();
        if (run?.status === "running") await openRun(run.id);
      } catch (e) { root.replaceChildren(node("p", { role: "alert", class: "agent-error" }, e.message), button("Retry", () => window.AgentTesting.open(context))); }
    },
    isDirty: () => dirty
  };
})();
