(() => {
  let ctx; const cache = new Map();
  const endpoint = project => `/api/projects/${encodeURIComponent(project.id)}/documents`;
  function modal(title) {
    const { el } = ctx, origin = document.activeElement;
    const dialog = el("dialog", { class: "document-dialog", "aria-label": title });
    const body = el("div", { class: "document-dialog-body" });
    dialog.append(el("header", { class: "document-dialog-head" }, el("div", {}, el("span", { class: "eyebrow", text: "DOCUMENT → REQUIREMENTS → TEST CASES" }), el("h2", { text: title })), el("button", { class: "btn", text: "Close", "aria-label": `Close ${title}`, onclick: () => dialog.close() })), body);
    dialog.addEventListener("close", () => { dialog.remove(); origin?.focus(); }); document.body.append(dialog); dialog.showModal(); return { dialog, body };
  }
  async function changed(project) { cache.delete(project.id); await ctx.refresh(); }
  function source(row) { const { el } = ctx; const view = modal(`Source · ${row.name}`); view.body.append(el("p", { class: "muted", text: "Use this source text to verify the requirements and their expected behavior." }), el("pre", { class: "document-source", text: row.text || row.quote })); }
  function mount(container, project) {
    const { el, api, can } = ctx;
    const render = rows => {
      if (!container.isConnected) return;
      container.replaceChildren(el("div", { class: "document-section-head" }, el("div", {}, el("h3", { text: `Documents · ${rows.length}` }), el("p", { class: "muted", text: "Upload → review requirements → create linked test drafts." })), can("folders.manage") ? el("button", { class: "btn", text: "Upload document", onclick: () => upload(project) }) : null));
      if (!rows.length) container.append(el("p", { class: "muted", text: "Add PDF, Word (.docx), TXT or Markdown requirements. Text extraction works without AI." }));
      for (const row of rows) container.append(el("div", { class: "document-row" }, el("div", {}, el("strong", { text: row.name }), el("small", { text: `${row.characters.toLocaleString()} characters · ${row.importedCount} saved requirements · ${row.method === "ai" ? "AI draft" : "Document sections"}` })), el("div", { class: "agent-actions" }, el("button", { class: "btn-link", text: can("folders.manage") ? "Review" : "View source", onclick: async () => { try { const data = await api(`${endpoint(project)}/${row.id}`); if (can("folders.manage")) review(project, data); else source(data); } catch (error) { ctx.toast(error.message, "error"); } } }), can("folders.manage") ? el("button", { class: "btn-link danger-text", "aria-label": `Remove document ${row.name}`, text: "Remove", onclick: async () => { if (!await ctx.confirmDialog(`Remove the saved source text for ${row.name}? Imported requirements, their source excerpts and test cases will remain.`, { title: "Remove document", okLabel: "Remove document", danger: true })) return; try { await api(`${endpoint(project)}/${row.id}`, { method: "DELETE", body: JSON.stringify({ revision: row.revision }) }); await changed(project); } catch (error) { ctx.toast(error.message, "error"); } } }) : null)));
    };
    const entry = cache.get(project.id);
    if (entry?.rows) { render(entry.rows); return; }
    container.replaceChildren(el("p", { class: "muted", text: "Loading documents…" }));
    const pending = entry?.pending || api(endpoint(project)); cache.set(project.id, { pending });
    pending.then(rows => { cache.set(project.id, { rows }); render(rows); }).catch(error => { cache.delete(project.id); if (container.isConnected) container.replaceChildren(el("p", { role: "alert", text: error.message }), el("button", { class: "btn", text: "Retry documents", onclick: () => mount(container, project) })); });
  }
  function upload(project) {
    const { el, api } = ctx;
    const input = el("input", { type: "file", accept: ".pdf,.docx,.txt,.md", required: true, "aria-label": "Requirement document" });
    let form;
    form = ctx.formDialog("Upload requirement document", el("div", { class: "document-upload" }, el("p", { text: `Project: ${project.name}. Saved source text and requirements are shared with this workspace.` }), el("label", {}, "Choose document", input), el("p", { class: "muted", text: "PDF, DOCX, TXT or Markdown · up to 3 MB, 40 PDF pages and 60,000 extracted characters. Scanned PDFs need OCR first. Uploading does not call AI." })), "Extract document", async () => {
      const file = input.files[0]; if (!file) throw new Error("Choose a document first.");
      if (file.size > 3 * 1024 * 1024) throw new Error("Choose a document no larger than 3 MB.");
      const content = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("Could not read this file.")); reader.readAsDataURL(file); });
      const row = await api(endpoint(project), { method: "POST", body: JSON.stringify({ name: file.name, content }) });
      await changed(project); if (form.dialog.open) { form.close(); review(project, row); } return false;
    });
  }
  function review(project, initial) {
    const { el, api, can } = ctx, view = modal(`Review · ${initial.name}`); let row = initial, controls = [], busy = false;
    const draw = () => {
      controls = [];
      const error = el("p", { class: "auth-error", role: "alert", hidden: true });
      const list = el("div", { class: "document-candidates" });
      const ai = el("button", { class: "btn ai-btn", text: "Extract with AI", disabled: !row.aiAvailable || !can("ai.analyze") || row.importedCount > 0 || row.characters > 24000 });
      const run = async action => { if (busy) return; busy = true; error.hidden = true; save.disabled = true; ai.disabled = true; try { await action(); } catch (e) { error.textContent = e.message; error.hidden = false; } finally { busy = false; save.disabled = false; ai.disabled = !row.aiAvailable || !can("ai.analyze") || row.importedCount > 0 || row.characters > 24000; } };
      ai.onclick = () => run(async () => { row = await api(`${endpoint(project)}/${row.id}/generate`, { method: "POST", body: JSON.stringify({ revision: row.revision }) }); cache.delete(project.id); draw(); });
      for (const candidate of row.candidates) {
        const imported = row.importedCandidateIds.includes(candidate.id);
        const checked = el("input", { type: "checkbox", checked: !imported, disabled: imported, "aria-label": `Select ${candidate.title}` });
        const title = el("input", { value: candidate.title, maxlength: 160, disabled: imported, "aria-label": "Requirement title" });
        const description = el("textarea", { rows: 5, maxlength: 6000, disabled: imported, "aria-label": "Acceptance criteria" }); description.value = candidate.description;
        controls.push({ candidate, checked, title, description });
        const steps = candidate.design.steps.map(step => el("li", {}, el("strong", { text: step.instruction }), el("p", { text: `Expected: ${step.expected}` })));
        list.append(el("article", { class: "document-candidate" },
          el("label", { class: "checkbox-row" }, checked, imported ? "Already saved" : "Include requirement"),
          el("label", {}, "Requirement title", title), el("label", {}, "Acceptance criteria", description),
          el("details", {}, el("summary", { text: "Source excerpt" }), el("pre", { class: "document-source", text: candidate.quote })),
          el("details", {}, el("summary", { text: "Proposed test design" }), el("p", { class: "muted", text: candidate.design.preconditions }), el("ol", {}, ...steps))));
      }
      const save = el("button", { class: "btn btn-primary", text: "Save selected requirements" });
      save.onclick = () => run(async () => { const candidates = controls.filter(c => c.checked.checked && !c.checked.disabled).map(c => ({ ...c.candidate, title: c.title.value, description: c.description.value })); if (!candidates.length) throw new Error("Select at least one requirement that has not been saved."); const result = await api(`${endpoint(project)}/${row.id}/import`, { method: "POST", body: JSON.stringify({ revision: row.revision, candidates }) }); await changed(project); view.dialog.close(); ctx.toast(`${result.created} requirements saved. Use Create test draft beside a requirement.`, "ok"); });
      view.body.replaceChildren(el("p", { class: "muted", text: `${row.method === "ai" ? "AI suggestions" : "Text sections"} are drafts. Edit and select the actual requirements; no tests run during import.` }), el("div", { class: "document-section-head" }, el("span", { text: `${row.candidates.length} candidates · ${row.importedCount} saved` }), el("div", { class: "agent-actions" }, el("button", { class: "btn", text: "View source text", onclick: () => source(row) }), ai)), el("p", { class: "muted", text: !row.aiAvailable ? "AI is not configured. You can review and save these sections without it." : "Extract with AI sends this document's text to the configured provider and records token usage. AI supports documents up to 24,000 characters; source quotes are checked." }), error, list, el("div", { class: "document-review-footer" }, save));
    }; draw();
  }
  function designFields(design, editable = true, onChange = () => {}) {
    const { el } = ctx;
    const preconditions = el("textarea", { rows: 2, maxlength: 3000, disabled: !editable, "aria-label": "Test preconditions", oninput: event => { design.preconditions = event.target.value; onChange(); } }); preconditions.value = design.preconditions;
    const list = el("div");
    const draw = () => { list.replaceChildren(...design.steps.map((step, index) => {
      const instruction = el("textarea", { rows: 2, maxlength: 3000, disabled: !editable, "aria-label": `Test action ${index + 1}`, oninput: event => { step.instruction = event.target.value; onChange(); } }); instruction.value = step.instruction;
      const expected = el("textarea", { rows: 3, maxlength: 6000, disabled: !editable, "aria-label": `Expected result ${index + 1}`, oninput: event => { step.expected = event.target.value; onChange(); } }); expected.value = step.expected;
      return el("div", { class: "test-design-step" }, el("strong", { text: `Step ${index + 1}` }), el("label", {}, "Tester action", instruction), el("label", {}, "Expected result", expected), editable && design.steps.length > 1 ? el("button", { class: "btn-link", type: "button", text: "Remove design step", onclick: () => { design.steps.splice(index, 1); onChange(); draw(); } }) : null);
    })); };
    const container = el("div", { class: "test-design-fields" }, el("label", {}, "Preconditions", preconditions), list, editable ? el("button", { class: "btn", type: "button", text: "Add design step", onclick: () => { if (design.steps.length >= 12) { ctx.toast("A test design supports up to 12 steps."); return; } design.steps.push({ instruction: "", expected: "" }); onChange(); draw(); } }) : null); draw(); return container;
  }
  function createTest(project, requirement) {
    const { el, api } = ctx;
    const environment = el("select", { required: true, "aria-label": "Test environment" }, ...project.environments.map(e => el("option", { value: e.id, text: e.name })));
    const design = structuredClone(requirement.design || { preconditions: "Open the project environment with a suitable account and data.", steps: [{ instruction: `Verify: ${requirement.title}`, expected: requirement.description }] });
    let form;
    form = ctx.formDialog("Create linked test draft", el("div", {}, el("h3", { text: requirement.title }), el("p", { class: "muted", text: "Review the test design. The saved draft contains tester actions and expected results. Add recorded or manual automation steps in the editor before running it." }), el("label", {}, "Environment", environment), designFields(design)), "Create test draft", async () => {
      const result = await api(`/api/projects/${project.id}/requirements/${requirement.id}/test-draft`, { method: "POST", body: JSON.stringify({ revision: requirement.revision, environmentId: environment.value, design }) });
      await changed(project); form.close(); await ctx.openTest(result.file); return false;
    });
  }
  window.ProjectDocuments = { init(services) { ctx = services; }, mount, createTest, source, designFields };
})();
