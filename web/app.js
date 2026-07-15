const state = {
  bootstrap: null,
  references: [],
  referencePreviewUrls: new Map(),
  currentSession: null,
  derivedFromSessionId: undefined,
  inheritReferences: false,
  poll: undefined,
  focusedCandidateId: undefined,
  exportSelectedIds: new Set(),
  exporting: false,
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Request failed (${response.status})`);
    error.code = body?.error?.code;
    error.details = body?.error?.details;
    throw error;
  }
  return body;
}

function selectedRecipeIds() {
  return [...document.querySelectorAll('input[name="recipe"]:checked')].map((input) => input.value);
}

function showRecipeFeedback(message) {
  $("#recipe-feedback").textContent = message;
}

function renderRecipes() {
  $("#recipe-options").innerHTML = state.bootstrap.recipes
    .map(
      (recipe) => `<label class="recipe-option">
        <input type="checkbox" name="recipe" value="${recipe.id}">
        <span class="recipe-card"><strong>${escapeHtml(recipe.name)}</strong><small>${escapeHtml(recipe.description)}</small><span class="recipe-state" aria-hidden="true"><span class="checked">✓ Included</span><span class="unchecked">Include</span></span></span>
      </label>`,
    )
    .join("");
  for (const id of state.bootstrap.defaults.recipeIds) {
    const input = document.querySelector(`input[name="recipe"][value="${id}"]`);
    if (input) input.checked = true;
  }
  for (const input of document.querySelectorAll('input[name="recipe"]')) {
    input.addEventListener("change", () => {
      showRecipeFeedback("");
      if (input.value === "custom" && input.checked) {
        const replaced = selectedRecipeIds().filter((id) => id !== "custom").length;
        for (const other of document.querySelectorAll('input[name="recipe"]')) {
          if (other !== input) other.checked = false;
        }
        if (replaced) showRecipeFeedback("Custom replaces the selected Folio style recipes.");
      } else if (input.checked) {
        const custom = document.querySelector('input[name="recipe"][value="custom"]');
        if (custom?.checked) {
          custom.checked = false;
          showRecipeFeedback("Custom was replaced so these styles can be compared.");
        }
        if (selectedRecipeIds().filter((id) => id !== "custom").length > 3) {
          input.checked = false;
          showRecipeFeedback("Choose up to three style recipes per run.");
        }
      }
      if (!selectedRecipeIds().length) {
        input.checked = true;
        showRecipeFeedback("At least one style recipe is required.");
      }
      updateEstimate();
    });
  }
}

function updateModelSettings() {
  const model = state.bootstrap.models.find((item) => item.id === $("#model").value);
  const previousSize = $("#size").value;
  $("#size").innerHTML = model.sizes
    .map((size) => `<option value="${size}">${size}</option>`)
    .join("");
  $("#size").value = model.sizes.includes(previousSize)
    ? previousSize
    : model.sizes.includes(state.bootstrap.defaults.size)
      ? state.bootstrap.defaults.size
      : model.sizes[0];
  const previousAspect = $("#aspect").value;
  $("#aspect").innerHTML = model.aspects
    .map((aspect) => `<option value="${aspect}">${aspect}</option>`)
    .join("");
  $("#aspect").value = model.aspects.includes(previousAspect)
    ? previousAspect
    : state.bootstrap.defaults.aspectRatio;
  $("#google-search").disabled = !model.searchGrounding;
  if (!model.searchGrounding) $("#google-search").checked = false;
  updateEstimate();
}

function updateEstimate() {
  if (!state.bootstrap) return;
  const recipeCount = selectedRecipeIds().length || 1;
  const variants = Math.max(1, Math.min(8, Number($("#variants").value) || 4));
  const calls = recipeCount * variants;
  const model = state.bootstrap.models.find((item) => item.id === $("#model").value);
  const imageEstimate = model?.pricing.estimatedImageUsd[$("#size").value];
  const estimate = imageEstimate === undefined ? undefined : imageEstimate * calls;
  $("#call-estimate").textContent =
    `${recipeCount} style${recipeCount === 1 ? "" : "s"} × ${variants} variant${variants === 1 ? "" : "s"} = ${calls} call${calls === 1 ? "" : "s"}`;
  $("#cost-estimate").textContent =
    estimate === undefined
      ? "Estimate unavailable"
      : `Approx. $${estimate.toFixed(3)} before grounding`;
  const gate = calls > 8 || (estimate !== undefined && estimate > 1);
  $("#confirmation-row").classList.toggle("hidden", !gate);
  if (!gate) $("#confirmation").checked = false;
}

function renderReferences() {
  $("#reference-list").innerHTML = state.references
    .map(
      (file, index) => `<li class="reference-item">
        <img src="${referencePreviewUrl(file)}" alt="">
        <span>${index + 1}. ${escapeHtml(file.name)}</span>
        <span class="reference-controls">
          <button type="button" data-ref-up="${index}" aria-label="Move ${escapeHtml(file.name)} up" ${index === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-ref-down="${index}" aria-label="Move ${escapeHtml(file.name)} down" ${index === state.references.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-ref-remove="${index}" aria-label="Remove ${escapeHtml(file.name)}">×</button>
        </span>
      </li>`,
    )
    .join("");
  for (const button of document.querySelectorAll("[data-ref-up]")) {
    button.onclick = () => moveReference(Number(button.dataset.refUp), -1);
  }
  for (const button of document.querySelectorAll("[data-ref-down]")) {
    button.onclick = () => moveReference(Number(button.dataset.refDown), 1);
  }
  for (const button of document.querySelectorAll("[data-ref-remove]")) {
    button.onclick = () => {
      const [file] = state.references.splice(Number(button.dataset.refRemove), 1);
      revokeReferencePreview(file);
      renderReferences();
    };
  }
}

function referencePreviewUrl(file) {
  let url = state.referencePreviewUrls.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    state.referencePreviewUrls.set(file, url);
  }
  return url;
}

function revokeReferencePreview(file) {
  const url = state.referencePreviewUrls.get(file);
  if (!url) return;
  URL.revokeObjectURL(url);
  state.referencePreviewUrls.delete(file);
}

function clearReferences() {
  for (const file of state.references) revokeReferencePreview(file);
  state.references = [];
}

function moveReference(index, offset) {
  const [file] = state.references.splice(index, 1);
  state.references.splice(index + offset, 0, file);
  renderReferences();
}

function candidateImageUrl(sessionId, candidateId) {
  return `/api/sessions/${sessionId}/candidates/${candidateId}/images/0`;
}

function findCandidate(session, candidateId) {
  for (const arm of session.arms) {
    const candidate = arm.candidates.find((item) => item.id === candidateId);
    if (candidate) return { arm, candidate };
  }
}

function candidateIdentity(session, arm, candidate) {
  return `${arm.recipe.name} → ${session.subject} → Variant ${candidate.variant} of ${arm.candidates.length}`;
}

function candidateExportReady(arm, candidate) {
  if (candidate.status !== "succeeded" || !candidate.images.length) return false;
  if (arm.recipe.export.type !== "folio-icon") return true;
  return candidate.images[0]?.width === candidate.images[0]?.height;
}

function candidateMessages(arm, candidate) {
  const messages = [];
  if (candidate.cancellation?.billing === "unknown-may-be-charged") {
    messages.push("Cancellation requested; billing may still occur.");
  }
  if (candidate.error) messages.push(candidate.error);
  if (
    candidate.status === "succeeded" &&
    arm.recipe.export.type === "folio-icon" &&
    candidate.images[0]?.width !== candidate.images[0]?.height
  ) {
    messages.push("Export unavailable: project icons require a square generated image.");
  }
  return messages.join(" ");
}

function renderCandidate(session, arm, candidate) {
  const identity = candidateIdentity(session, arm, candidate);
  const ready = candidate.status === "succeeded" && candidate.images.length;
  const primary = session.selectedCandidateId === candidate.id;
  const focused = state.focusedCandidateId === candidate.id;
  const selectedForExport = state.exportSelectedIds.has(candidate.id);
  const exported = session.exports.some((record) => record.candidateId === candidate.id);
  const message = candidateMessages(arm, candidate);
  return `<article class="candidate${focused ? " focused" : ""}${primary ? " primary-candidate" : ""}" data-candidate="${candidate.id}" aria-label="${escapeHtml(identity)}">
    <div class="candidate-flags">
      <label class="export-check"><input type="checkbox" data-export-select="${candidate.id}" ${selectedForExport ? "checked" : ""} ${candidateExportReady(arm, candidate) ? "" : "disabled"}><span class="sr-only">Select ${escapeHtml(identity)} for export</span></label>
      <span class="candidate-flag-list">${primary ? '<strong class="flag flag-primary">Primary</strong>' : ""}${exported ? '<strong class="flag flag-exported">Exported</strong>' : ""}</span>
    </div>
    <button class="candidate-focus" type="button" data-focus-candidate="${candidate.id}" aria-pressed="${focused}" aria-label="Inspect ${escapeHtml(identity)}">
      ${ready ? `<img src="${candidateImageUrl(session.id, candidate.id)}" alt="Generated ${escapeHtml(identity)}">` : `<span class="candidate-placeholder" aria-hidden="true"></span>`}
      ${primary ? '<span class="primary-badge" aria-hidden="true">✓</span>' : ""}
    </button>
    <div class="candidate-label"><strong>Variant ${candidate.variant} of ${arm.candidates.length}</strong>${candidate.status === "succeeded" ? "" : `<span>${escapeHtml(candidate.status)}</span>`}</div>
    ${message ? `<p class="candidate-message">${escapeHtml(message)}</p>` : ""}
  </article>`;
}

function candidateSignature(session, candidate) {
  return JSON.stringify({
    candidate,
    primary: session.selectedCandidateId === candidate.id,
    exported: session.exports.some((record) => record.candidateId === candidate.id),
    exportSelected: state.exportSelectedIds.has(candidate.id),
  });
}

function candidateElement(session, arm, candidate) {
  const template = document.createElement("template");
  template.innerHTML = renderCandidate(session, arm, candidate).trim();
  const element = template.content.firstElementChild;
  element.dataset.signature = candidateSignature(session, candidate);
  return element;
}

function renderCandidateGroups(session, sameSession) {
  const container = $("#candidate-groups");
  if (!sameSession || !container.querySelector(".candidate-group")) {
    container.innerHTML = session.arms
      .map(
        (
          arm,
        ) => `<section class="candidate-group" data-arm="${arm.id}" aria-labelledby="arm-${arm.id}">
          <div class="group-heading">
            <div><h3 id="arm-${arm.id}">${escapeHtml(arm.recipe.name)}</h3></div>
            <details class="arm-prompt"><summary>Style recipe and full prompt</summary><pre>${escapeHtml(arm.renderedPrompt)}</pre></details>
          </div>
          <div class="candidate-grid"></div>
        </section>`,
      )
      .join("");
  }

  for (const arm of session.arms) {
    const group = container.querySelector(`[data-arm="${arm.id}"]`);
    const grid = group?.querySelector(".candidate-grid");
    if (!grid) continue;
    const expected = new Set(arm.candidates.map((candidate) => candidate.id));
    for (const existing of grid.querySelectorAll("[data-candidate]")) {
      if (!expected.has(existing.dataset.candidate)) existing.remove();
    }
    for (const candidate of arm.candidates) {
      const signature = candidateSignature(session, candidate);
      const existing = grid.querySelector(`[data-candidate="${candidate.id}"]`);
      if (existing?.dataset.signature === signature) continue;
      const replacement = candidateElement(session, arm, candidate);
      if (existing) existing.replaceWith(replacement);
      else grid.append(replacement);
    }
  }
  updateFocusedCandidateClasses();
}

function updateFocusedCandidateClasses() {
  for (const candidate of document.querySelectorAll("[data-candidate]")) {
    const focused = candidate.dataset.candidate === state.focusedCandidateId;
    candidate.classList.toggle("focused", focused);
    candidate
      .querySelector("[data-focus-candidate]")
      ?.setAttribute("aria-pressed", String(focused));
  }
}

function renderInspector(session) {
  const container = $("#candidate-inspector");
  const found = findCandidate(session, state.focusedCandidateId);
  if (!found) {
    container.innerHTML = '<p class="hint">Choose a candidate to inspect it.</p>';
    return;
  }
  const { arm, candidate } = found;
  const identity = candidateIdentity(session, arm, candidate);
  const ready = candidate.status === "succeeded" && candidate.images.length;
  const primary = session.selectedCandidateId === candidate.id;
  const exportReady = candidateExportReady(arm, candidate);
  const exportedCount = session.exports.filter(
    (record) => record.candidateId === candidate.id,
  ).length;
  const cost = candidate.cost?.usd;
  const signature = JSON.stringify({
    candidate,
    primary,
    exportedCount,
    selected: [...state.exportSelectedIds],
    exporting: state.exporting,
  });
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  const imageUrl = ready ? candidateImageUrl(session.id, candidate.id) : "";
  const nativePreview =
    ready && arm.recipe.preview.type === "folio-icon"
      ? `<details class="native-details"><summary>Small-size previews</summary><div class="native-preview" aria-label="Small-size previews">${arm.recipe.preview.sizes
          .map(
            (size) =>
              `<div class="native-row"><span>${size}px</span><div class="native-cell light"><img src="${imageUrl}" width="${size}" height="${size}" alt=""></div><div class="native-cell dark"><img src="${imageUrl}" width="${size}" height="${size}" alt=""></div></div>`,
          )
          .join("")}</div></details>`
      : "";
  const message = candidateMessages(arm, candidate);
  container.innerHTML = `<div class="inspector-content">
    <ol class="identity-path" aria-label="Candidate identity"><li>${escapeHtml(arm.recipe.name)}</li><li>${escapeHtml(session.subject)}</li><li>Variant ${candidate.variant} of ${arm.candidates.length}</li></ol>
    ${ready ? `<img class="inspector-image" src="${imageUrl}" alt="Generated ${escapeHtml(identity)}">` : '<div class="inspector-placeholder" aria-hidden="true"></div>'}
    ${nativePreview}
    <div class="inspector-section"><h3>Status and cost</h3><dl class="inspector-facts"><div class="inspector-fact"><dt>Status</dt><dd>${escapeHtml(candidate.status)}</dd></div>${cost === undefined ? "" : `<div class="inspector-fact"><dt>Cost</dt><dd>$${cost.toFixed(4)}</dd></div>`}</dl>${message ? `<p class="candidate-message">${escapeHtml(message)}</p>` : ""}</div>
    <div class="inspector-section"><h3>Primary</h3><p>${primary ? "This is the Primary candidate for the run." : "Primary is optional and does not control exports."}</p>${primary ? '<button type="button" data-clear-primary>Clear Primary</button>' : `<button type="button" data-primary="${candidate.id}" ${ready ? "" : "disabled"}>Set as Primary</button>`}</div>
    <div class="inspector-section"><h3>Export</h3><p>${exportedCount ? `Exported ${exportedCount} time${exportedCount === 1 ? "" : "s"}.` : "Export this candidate without changing Primary or the export checklist."}</p><button class="primary" type="button" data-export="${candidate.id}" ${exportReady && !state.exporting ? "" : "disabled"}>Export candidate</button></div>
  </div>`;
}

function exportDisplayPath(session, exported) {
  return `${state.bootstrap.storageDisplayRoot}/sessions/${session.createdAt.slice(0, 10)}/${session.id}/${exported.directory}`;
}

function renderExports(session) {
  const container = $("#export-history");
  const signature = JSON.stringify({ sessionId: session.id, exports: session.exports });
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.hidden = !session.exports.length;
  container.innerHTML = session.exports.length
    ? `<summary>Export history (${session.exports.length})</summary><div class="export-records">${session.exports
        .map((exported) => {
          const found = findCandidate(session, exported.candidateId);
          const identity = found
            ? candidateIdentity(session, found.arm, found.candidate)
            : "Candidate no longer available";
          return `<article class="export-record" data-export-record="${exported.id}">
            <h3>${escapeHtml(identity)}</h3><p>Exported</p>
          </article>`;
        })
        .join("")}</div>`
    : "";
}

function stopPolling() {
  clearTimeout(state.poll);
  state.poll = undefined;
}

function schedulePoll(sessionId) {
  if (state.poll) return;
  state.poll = setTimeout(async () => {
    state.poll = undefined;
    await refreshSession(sessionId, true);
  }, 900);
}

function updateRunSummary(session) {
  $("#summary-recipes").textContent = session.arms.map((arm) => arm.recipe.name).join(" + ");
  $("#summary-subject").textContent = session.subject;
  $("#summary-settings").innerHTML =
    `<div><dt>Model</dt><dd>${escapeHtml(modelShortLabel(session.settings.modelId))}</dd></div><div><dt>Resolution</dt><dd>${escapeHtml(formatSize(session.settings.size))}</dd></div><div><dt>Aspect</dt><dd>${escapeHtml(session.settings.aspectRatio || "default")}</dd></div><div><dt>Variants</dt><dd>${session.settings.variantsPerRecipe} per style</dd></div>`;
}

function setEditorCollapsed(collapsed) {
  $("#generation-form").classList.toggle("collapsed", collapsed);
  $("#run-summary").classList.toggle("hidden", !collapsed);
}

function updateHistoryCurrent() {
  for (const button of document.querySelectorAll("[data-session]")) {
    if (button.dataset.session === state.currentSession?.id)
      button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
  const current = state.currentSession ? `, current session: ${state.currentSession.subject}` : "";
  $("#history-toggle").setAttribute(
    "aria-label",
    `${$("#history-toggle").getAttribute("aria-expanded") === "true" ? "Hide" : "Show"} history${current}`,
  );
}

function renderExportTray() {
  const tray = $("#export-tray");
  const count = state.exportSelectedIds.size;
  tray.hidden = count === 0;
  tray.innerHTML = count
    ? `<button class="primary" type="button" data-export-selected ${state.exporting ? "disabled" : ""}>${state.exporting ? "Exporting…" : `Export selected (${count})`}</button>`
    : "";
}

function renderSession(session) {
  const sameSession = state.currentSession?.id === session.id;
  if (!sameSession) {
    stopPolling();
    state.focusedCandidateId = session.arms.flatMap((arm) => arm.candidates)[0]?.id;
    state.exportSelectedIds.clear();
    $("#candidate-inspector").dataset.signature = "";
    $("#export-history").dataset.signature = "";
    showSessionMessage("");
  }
  state.currentSession = session;
  $("#session-view").classList.remove("hidden", "loading");
  $("#session-meta").textContent =
    `${session.arms.length} style${session.arms.length === 1 ? "" : "s"} · ${modelShortLabel(session.settings.modelId)} · ${formatSize(session.settings.size)}`;
  $("#session-title").textContent = session.subject;
  const candidates = session.arms.flatMap((arm) => arm.candidates);
  const counts = Object.groupBy(candidates, (candidate) => candidate.status);
  $("#progress").textContent = [
    `${candidates.length} total`,
    `${counts.succeeded?.length || 0} succeeded`,
    `${counts.running?.length || 0} running`,
    `${counts.queued?.length || 0} queued`,
    `${counts.failed?.length || 0} failed`,
    `${counts["cancel-requested"]?.length || 0} cancel requested`,
  ].join(" · ");
  renderCandidateGroups(session, sameSession);
  renderInspector(session);
  renderExportTray();
  renderExports(session);
  updateRunSummary(session);
  if (!sameSession) setEditorCollapsed(true);
  updateHistoryCurrent();
  const active = candidates.some((candidate) => ["queued", "running"].includes(candidate.status));
  $("#cancel").disabled = !active;
  if (active) schedulePoll(session.id);
  else stopPolling();
}

function renderLoadingSession(subject) {
  $("#session-view").classList.remove("hidden");
  $("#session-view").classList.add("loading");
  $("#session-meta").textContent = "Starting generation";
  $("#session-title").textContent = subject;
  $("#progress").textContent = "Preparing candidates…";
  const loadingVariants = Math.min(8, Math.max(1, Number($("#variants").value) || 4));
  const loadingRecipes = Math.max(
    1,
    document.querySelectorAll('input[name="recipe"]:checked').length,
  );
  $("#candidate-groups").innerHTML = Array.from(
    { length: loadingRecipes },
    () =>
      `<section class="loading-group" aria-hidden="true"><div class="loading-line"></div><div class="loading-grid">${'<div class="loading-candidate"></div>'.repeat(loadingVariants)}</div></section>`,
  ).join("");
  $("#candidate-inspector").innerHTML =
    '<div class="inspector-placeholder" aria-hidden="true"></div>';
  $("#export-history").hidden = true;
}

function transitionToResults() {
  requestAnimationFrame(() => {
    $("#session-title").focus({ preventScroll: true });
    $("#session-view").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function refreshSession(sessionId, fromPoll = false) {
  try {
    const result = await api(`/api/sessions/${sessionId}`);
    if (fromPoll && state.currentSession?.id !== sessionId) return;
    renderSession(result.session);
    if (!fromPoll) transitionToResults();
    if (fromPoll && !["queued", "running"].includes(result.session.status)) await loadHistory();
  } catch (error) {
    showSessionMessage(error.message, true);
    const active = state.currentSession?.arms
      .flatMap((arm) => arm.candidates)
      .some((candidate) => ["queued", "running"].includes(candidate.status));
    if (fromPoll && state.currentSession?.id === sessionId && active) schedulePoll(sessionId);
  }
}

function showSessionMessage(message, isError = false) {
  const element = $("#session-message");
  element.textContent = message;
  element.classList.toggle("error", isError);
}

async function loadHistory() {
  const result = await api("/api/history");
  $("#history-list").innerHTML = result.sessions.length
    ? result.sessions
        .map(
          (session) =>
            `<button class="history-item" type="button" data-session="${session.id}" ${session.id === state.currentSession?.id ? 'aria-current="true"' : ""}><strong>${escapeHtml(session.recipes.join(" + "))}</strong><span>${escapeHtml(session.subject)}</span><small>${escapeHtml(session.status)} · ${new Date(session.createdAt).toLocaleString()}</small></button>`,
        )
        .join("")
    : '<p class="hint">No workbench sessions yet.</p>';
  for (const button of document.querySelectorAll("[data-session]")) {
    button.onclick = () => refreshSession(button.dataset.session);
  }
  renderSpend(result.sessions);
  updateHistoryCurrent();
}

async function setPrimary(candidateId) {
  const sessionId = state.currentSession.id;
  showSessionMessage(candidateId === null ? "Clearing Primary…" : "Setting Primary…");
  try {
    const result = await api(`/api/sessions/${sessionId}/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateId }),
    });
    if (state.currentSession?.id !== sessionId) return;
    renderSession(result.session);
    showSessionMessage(
      candidateId === null
        ? "Primary cleared. Exports remain independent."
        : "Primary updated. Exports remain independent.",
    );
    requestAnimationFrame(() => {
      const selector = candidateId === null ? "[data-primary]" : "[data-clear-primary]";
      $("#candidate-inspector").querySelector(selector)?.focus();
    });
  } catch (error) {
    if (state.currentSession?.id === sessionId) showSessionMessage(error.message, true);
  }
}

async function requestExport(sessionId, candidateId) {
  return api(`/api/sessions/${sessionId}/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidateId }),
  });
}

async function exportCandidate(candidateId) {
  const sessionId = state.currentSession.id;
  showSessionMessage("Exporting candidate…");
  state.exporting = true;
  renderInspector(state.currentSession);
  try {
    const result = await requestExport(sessionId, candidateId);
    if (state.currentSession?.id !== sessionId) return;
    renderSession(result.manifest);
    const path = exportDisplayPath(result.manifest, result.export);
    const element = $("#session-message");
    element.classList.remove("error");
    element.innerHTML = `Exported to <code class="path-chip">${escapeHtml(path)}</code><span class="notice-sub">Primary and export checklist unchanged.</span>`;
  } catch (error) {
    if (state.currentSession?.id === sessionId) showSessionMessage(error.message, true);
  } finally {
    state.exporting = false;
    if (state.currentSession) renderInspector(state.currentSession);
    renderExportTray();
  }
}

async function exportSelected() {
  const sessionId = state.currentSession.id;
  const candidateIds = [...state.exportSelectedIds];
  if (!candidateIds.length || state.exporting) return;
  state.exporting = true;
  renderInspector(state.currentSession);
  renderExportTray();
  showSessionMessage(`Exporting 0 of ${candidateIds.length} selected candidates…`);
  let succeeded = 0;
  const failures = [];
  let latestSession = state.currentSession;
  for (const candidateId of candidateIds) {
    try {
      const result = await requestExport(sessionId, candidateId);
      latestSession = result.manifest;
      succeeded++;
      if (state.currentSession?.id === sessionId) {
        showSessionMessage(`Exporting ${succeeded} of ${candidateIds.length} selected candidates…`);
      }
    } catch (error) {
      const found = findCandidate(latestSession, candidateId);
      const identity = found
        ? candidateIdentity(latestSession, found.arm, found.candidate)
        : "Unknown candidate";
      failures.push(`${identity}: ${error.message}`);
    }
  }
  state.exporting = false;
  if (state.currentSession?.id !== sessionId) {
    renderExportTray();
    return;
  }
  renderSession(latestSession);
  if (failures.length) {
    showSessionMessage(
      `Exported ${succeeded} of ${candidateIds.length}. ${failures.length} failed: ${failures.join("; ")}`,
      true,
    );
  } else {
    showSessionMessage(`Exported all ${succeeded} selected candidates. Primary is unchanged.`);
  }
}

function setFocusedCandidate(candidateId) {
  if (!findCandidate(state.currentSession, candidateId)) return;
  state.focusedCandidateId = candidateId;
  updateFocusedCandidateClasses();
  $("#candidate-inspector").dataset.signature = "";
  renderInspector(state.currentSession);
}

function focusInspectorAction() {
  $("#candidate-inspector")
    .querySelector(
      "[data-primary]:not(:disabled), [data-clear-primary], [data-export]:not(:disabled)",
    )
    ?.focus();
}

function loadSessionIntoForm(session) {
  state.derivedFromSessionId = session.id;
  state.inheritReferences = session.references.length > 0;
  $("#derived-label").textContent = `Based on current session`;
  $("#subject").value = session.subject;
  updateSubjectCount();
  for (const input of document.querySelectorAll('input[name="recipe"]')) {
    input.checked = session.arms.some((arm) => arm.recipe.id === input.value);
  }
  $("#model").value = session.settings.modelId;
  updateModelSettings();
  $("#size").value = session.settings.size;
  $("#aspect").value = session.settings.aspectRatio || "1:1";
  $("#variants").value = session.settings.variantsPerRecipe;
  $("#google-search").checked = session.settings.googleSearch;
  clearReferences();
  renderReferences();
  if (state.inheritReferences) {
    $("#reference-list").innerHTML =
      `<li class="hint">${session.references.length} reference image${session.references.length === 1 ? "" : "s"} will be copied. Uploading new references replaces them.</li>`;
  }
  updateEstimate();
  setEditorCollapsed(false);
  $("#subject").focus();
  $("#generation-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function submitGeneration(event) {
  event.preventDefault();
  $("#form-error").textContent = "";
  const recipeIds = selectedRecipeIds();
  if (!recipeIds.length) return;
  const payload = {
    subject: $("#subject").value,
    recipeIds,
    modelId: $("#model").value,
    size: $("#size").value,
    aspectRatio: $("#aspect").value,
    googleSearch: $("#google-search").checked,
    variantsPerRecipe: Number($("#variants").value),
    derivedFromSessionId: state.derivedFromSessionId,
    inheritReferences: state.inheritReferences,
    confirmationAcknowledged: $("#confirmation").checked,
  };
  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  for (const file of state.references) form.append("references", file, file.name);
  const generateButton = $("#generate-button");
  generateButton.disabled = true;
  generateButton.textContent = "Generating…";
  renderLoadingSession(payload.subject);
  transitionToResults();
  try {
    const result = await api("/api/sessions", { method: "POST", body: form });
    renderSession(result.session);
    transitionToResults();
    await loadHistory();
  } catch (error) {
    $("#session-view").classList.add("hidden");
    $("#form-error").textContent = error.message;
    if (error.code === "confirmation_required") $("#confirmation-row").classList.remove("hidden");
  } finally {
    generateButton.textContent = "Generate";
    generateButton.disabled = !state.bootstrap.keyConfigured;
  }
}

function updateSubjectCount() {
  const max = state.bootstrap?.limits.maxSubjectLength ?? Number($("#subject").maxLength);
  $("#subject-count").textContent =
    `${$("#subject").value.length.toLocaleString()} / ${max.toLocaleString()}`;
}

function setHistoryOpen(open) {
  $("#history-toggle").setAttribute("aria-expanded", String(open));
  $("#history-drawer").hidden = !open;
  $("#history-panel").classList.toggle("open", open);
  $("#history-toggle .history-toggle-label").textContent = open ? "Hide history" : "Show history";
  updateHistoryCurrent();
}

function setTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === "dark";
  const toggle = $("#theme-toggle");
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  toggle.setAttribute("aria-pressed", String(dark));
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
  if (persist) localStorage.setItem("nano-banana-theme", theme);
}

function modelLabel(modelId) {
  return state.bootstrap?.models.find((model) => model.id === modelId)?.label ?? modelId;
}

function modelShortLabel(modelId) {
  return modelLabel(modelId).split(" · ").pop() ?? modelId;
}

function formatSize(size) {
  return /^\d+$/.test(size) ? `${size}px` : size;
}

function setSpendOpen(open) {
  $("#spend-toggle").setAttribute("aria-expanded", String(open));
  $("#spend-breakdown").hidden = !open;
}

function emptySpendSummary() {
  return {
    calculatedUsd: 0,
    upperBoundUsd: 0,
    calculatedCount: 0,
    upperBoundCount: 0,
    unavailableCount: 0,
    unknownMayBeChargedCount: 0,
    hasCalculatedUsd: false,
    hasUpperBoundUsd: false,
    partial: false,
    unavailable: false,
  };
}

function addSpend(summary, spend) {
  if (!spend) {
    summary.unavailable = true;
    return;
  }
  if (typeof spend.calculatedUsd === "number") {
    summary.calculatedUsd += spend.calculatedUsd;
    summary.hasCalculatedUsd = true;
  }
  if (typeof spend.upperBoundUsd === "number") {
    summary.upperBoundUsd += spend.upperBoundUsd;
    summary.hasUpperBoundUsd = true;
  }
  summary.calculatedCount += spend.calculatedCount;
  summary.upperBoundCount += spend.upperBoundCount;
  summary.unavailableCount += spend.unavailableCount;
  summary.unknownMayBeChargedCount += spend.unknownMayBeChargedCount;
  if (spend.status === "partial") summary.partial = true;
  if (spend.status === "unavailable") summary.unavailable = true;
}

function formatSpend(summary) {
  const hasUnknown =
    summary.partial ||
    summary.unavailable ||
    summary.unavailableCount > 0 ||
    summary.unknownMayBeChargedCount > 0;
  const parts = [];
  if (summary.hasCalculatedUsd) parts.push(`$${summary.calculatedUsd.toFixed(2)}`);
  if (summary.hasUpperBoundUsd) parts.push(`≤$${summary.upperBoundUsd.toFixed(2)}`);
  if (hasUnknown) return parts.length ? `${parts.join(" + ")} + unknown` : "Unavailable";
  return parts.length ? parts.join(" + ") : "$0.00";
}

function renderSpend(sessions) {
  const toggle = $("#spend-toggle");
  if (!sessions.length) {
    toggle.hidden = true;
    setSpendOpen(false);
    return;
  }
  const byModel = new Map();
  const total = emptySpendSummary();
  for (const session of sessions) {
    addSpend(total, session.spend);
    const entry = byModel.get(session.settings.modelId) ?? {
      images: 0,
      imageCountKnown: true,
      spend: emptySpendSummary(),
    };
    if (Number.isInteger(session.generatedImageCount)) entry.images += session.generatedImageCount;
    else entry.imageCountKnown = false;
    addSpend(entry.spend, session.spend);
    byModel.set(session.settings.modelId, entry);
  }
  toggle.hidden = false;
  const totalLabel = formatSpend(total);
  $("#spend-total").textContent = totalLabel;
  toggle.setAttribute("aria-label", `All stored runs spend: ${totalLabel}`);
  const rows = [...byModel.entries()]
    .sort(
      (a, b) =>
        b[1].spend.calculatedUsd +
        b[1].spend.upperBoundUsd -
        (a[1].spend.calculatedUsd + a[1].spend.upperBoundUsd),
    )
    .map(
      ([modelId, entry]) =>
        `<div class="spend-row"><span class="spend-model">${escapeHtml(modelLabel(modelId))}</span><span class="spend-meta"><span class="muted">${entry.imageCountKnown ? `${entry.images} generated image${entry.images === 1 ? "" : "s"}` : "Generated image count unavailable"}</span><strong>${escapeHtml(formatSpend(entry.spend))}</strong></span></div>`,
    )
    .join("");
  $("#spend-breakdown").innerHTML =
    `<p class="spend-head">Across all ${sessions.length} stored run${sessions.length === 1 ? "" : "s"}</p>${rows}`;
}

async function initialize() {
  const savedTheme = localStorage.getItem("nano-banana-theme");
  setTheme(savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  state.bootstrap = await api("/api/bootstrap");
  $("#key-status").textContent = state.bootstrap.keyConfigured
    ? state.bootstrap.mock
      ? "Mock generation"
      : "API key configured"
    : "API key not configured";
  if (!state.bootstrap.keyConfigured) {
    $("#generate-button").disabled = true;
    $("#key-guidance").classList.remove("hidden");
    $("#key-guidance").textContent =
      "Generation disabled. Add GEMINI_API_KEY=your_key to ~/.nano-banana/.env, then restart the workbench.";
  }
  $("#subject").maxLength = state.bootstrap.limits.maxSubjectLength;
  renderRecipes();
  $("#model").innerHTML = state.bootstrap.models
    .map((model) => `<option value="${model.id}">${model.label}</option>`)
    .join("");
  $("#model").value = state.bootstrap.defaults.modelId;
  updateModelSettings();
  $("#size").value = state.bootstrap.defaults.size;
  $("#aspect").value = state.bootstrap.defaults.aspectRatio;
  $("#variants").value = state.bootstrap.defaults.variantsPerRecipe;
  updateSubjectCount();
  updateEstimate();
  await loadHistory();
}

$("#generation-form").addEventListener("submit", submitGeneration);
$("#model").addEventListener("change", updateModelSettings);
$("#size").addEventListener("change", updateEstimate);
$("#variants").addEventListener("input", updateEstimate);
$("#subject").addEventListener("input", updateSubjectCount);
$("#references").addEventListener("change", (event) => {
  state.inheritReferences = false;
  state.references.push(...event.target.files);
  event.target.value = "";
  renderReferences();
});
$("#history-toggle").addEventListener("click", () => {
  setHistoryOpen($("#history-toggle").getAttribute("aria-expanded") !== "true");
});
$("#history-refresh").addEventListener("click", async () => {
  try {
    await loadHistory();
  } catch (error) {
    $("#history-list").innerHTML = `<p class="error" role="alert">${escapeHtml(error.message)}</p>`;
  }
});
$("#edit-setup").addEventListener("click", () => {
  setEditorCollapsed(false);
  $("#subject").focus();
});
$("#cancel").addEventListener("click", async () => {
  showSessionMessage("Cancelling remaining calls…");
  try {
    const result = await api(`/api/sessions/${state.currentSession.id}/cancel`, { method: "POST" });
    renderSession(result.session);
    showSessionMessage("Cancellation requested. In-flight billing may still occur.");
  } catch (error) {
    showSessionMessage(error.message, true);
  }
});
$("#candidate-groups").addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const focus = event.target.closest("[data-focus-candidate]");
  if (focus) {
    setFocusedCandidate(focus.dataset.focusCandidate);
    if (event.detail === 0) requestAnimationFrame(focusInspectorAction);
  }
});
$("#candidate-groups").addEventListener("change", (event) => {
  if (!(event.target instanceof HTMLInputElement) || !event.target.dataset.exportSelect) return;
  if (event.target.checked) state.exportSelectedIds.add(event.target.dataset.exportSelect);
  else state.exportSelectedIds.delete(event.target.dataset.exportSelect);
  renderExportTray();
});
$("#candidate-inspector").addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const primary = event.target.closest("[data-primary]");
  if (primary) void setPrimary(primary.dataset.primary);
  if (event.target.closest("[data-clear-primary]")) void setPrimary(null);
  const exportButton = event.target.closest("[data-export]");
  if (exportButton) void exportCandidate(exportButton.dataset.export);
});
$("#export-tray").addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("[data-export-selected]")) {
    void exportSelected();
  }
});
$("#regenerate").addEventListener("click", () => loadSessionIntoForm(state.currentSession));
$("#theme-toggle").addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
});

$("#spend-toggle").addEventListener("click", () => {
  setSpendOpen($("#spend-breakdown").hidden);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".spend-wrap")) setSpendOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setSpendOpen(false);
});

window.addEventListener("beforeunload", clearReferences);

initialize().catch((error) => {
  $("#form-error").textContent = error.message;
});
