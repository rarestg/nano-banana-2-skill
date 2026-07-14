const state = {
  bootstrap: null,
  references: [],
  currentSession: null,
  derivedFromSessionId: undefined,
  inheritReferences: false,
  poll: undefined,
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

function renderRecipes() {
  $("#recipe-options").innerHTML = state.bootstrap.recipes
    .map(
      (recipe) => `<label class="recipe-option">
        <input type="checkbox" name="recipe" value="${recipe.id}">
        <span class="recipe-card"><strong>${escapeHtml(recipe.name)}</strong><small>${escapeHtml(recipe.description)}</small><span class="recipe-state" aria-hidden="true"><span class="checked">✓ Selected</span><span class="unchecked">Select</span></span></span>
      </label>`,
    )
    .join("");
  for (const id of state.bootstrap.defaults.recipeIds) {
    const input = document.querySelector(`input[name="recipe"][value="${id}"]`);
    if (input) input.checked = true;
  }
  for (const input of document.querySelectorAll('input[name="recipe"]')) {
    input.addEventListener("change", () => {
      const ids = selectedRecipeIds();
      if (input.value === "custom" && input.checked) {
        for (const other of document.querySelectorAll('input[name="recipe"]')) {
          if (other !== input) other.checked = false;
        }
      } else if (input.checked) {
        const custom = document.querySelector('input[name="recipe"][value="custom"]');
        if (custom) custom.checked = false;
        if (ids.filter((id) => id !== "custom").length > 3) input.checked = false;
      }
      if (!selectedRecipeIds().length) input.checked = true;
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
        <img src="${URL.createObjectURL(file)}" alt="">
        <span>${index + 1}. ${escapeHtml(file.name)}</span>
        <span class="reference-controls">
          <button type="button" data-ref-up="${index}" ${index === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-ref-down="${index}" ${index === state.references.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-ref-remove="${index}">×</button>
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
      state.references.splice(Number(button.dataset.refRemove), 1);
      renderReferences();
    };
  }
}

function moveReference(index, offset) {
  const [file] = state.references.splice(index, 1);
  state.references.splice(index + offset, 0, file);
  renderReferences();
}

function candidateImageUrl(sessionId, candidateId) {
  return `/api/sessions/${sessionId}/candidates/${candidateId}/images/0`;
}

function renderCandidate(session, arm, candidate) {
  const ready = candidate.status === "succeeded" && candidate.images.length;
  const imageUrl = ready ? candidateImageUrl(session.id, candidate.id) : "";
  const selected = session.selectedCandidateId === candidate.id;
  const projectIcon = arm.recipe.export.type === "folio-icon";
  const square = candidate.images[0]?.width === candidate.images[0]?.height;
  const exportReady = ready && (!projectIcon || square);
  const exportTitle =
    ready && projectIcon && !square ? 'title="Project-icon export requires a square image."' : "";
  const rawPreview = ready
    ? `<img class="raw-preview" src="${imageUrl}" alt="Generated candidate">`
    : "";
  const previews =
    ready && arm.recipe.preview.type === "folio-icon"
      ? `${rawPreview}<div class="native-preview">${arm.recipe.preview.sizes
          .map(
            (size) => `<div class="native-row"><span>${size}px</span>
              <div class="native-cell light"><img src="${imageUrl}" width="${size}" height="${size}" alt=""></div>
              <div class="native-cell dark"><img src="${imageUrl}" width="${size}" height="${size}" alt=""></div>
            </div>`,
          )
          .join("")}</div>`
      : rawPreview;
  const cost = candidate.cost?.usd;
  const messages = [];
  if (candidate.cancellation?.billing === "unknown-may-be-charged") {
    messages.push("Cancellation requested; billing may still occur.");
  }
  if (candidate.error) messages.push(candidate.error);
  if (cost !== undefined) {
    messages.push(
      candidate.cost.status === "upper-bound"
        ? `$${cost.toFixed(4)} conservative upper estimate from reported usage`
        : `$${cost.toFixed(4)} calculated from reported usage`,
    );
  }
  if (ready && projectIcon && !square) {
    messages.push("Export unavailable: project icons require a square generated image.");
  }
  const message = messages.join(" ");
  return `<article class="candidate ${selected ? "selected" : ""}" data-candidate="${candidate.id}">
    <div class="candidate-head"><strong>Variant ${candidate.variant}</strong>${selected ? '<span class="selection-badge">✓ Selected</span>' : ""}<span class="candidate-state">${candidate.status}</span></div>
    ${previews}
    ${message ? `<p class="candidate-message">${escapeHtml(message)}</p>` : ""}
    <div class="candidate-actions">
      <button type="button" data-select="${candidate.id}" aria-pressed="${selected}" ${ready && !selected ? "" : "disabled"}>${selected ? "✓ Selected" : "Select winner"}</button>
      <button type="button" data-export="${candidate.id}" ${exportReady ? "" : "disabled"} ${exportTitle}>Export bundle</button>
    </div>
  </article>`;
}

function candidateSignature(candidate, selected) {
  return JSON.stringify({ candidate, selected });
}

function candidateElement(session, arm, candidate) {
  const template = document.createElement("template");
  template.innerHTML = renderCandidate(session, arm, candidate).trim();
  const element = template.content.firstElementChild;
  element.dataset.signature = candidateSignature(
    candidate,
    session.selectedCandidateId === candidate.id,
  );
  return element;
}

function renderCandidateGroups(session, sameSession) {
  const container = $("#candidate-groups");
  if (!sameSession) {
    container.innerHTML = session.arms
      .map(
        (arm) => `<section class="candidate-group" data-arm="${arm.id}">
          <h3>${escapeHtml(arm.recipe.name)}</h3>
          <p class="hint">${escapeHtml(arm.recipe.description)}</p>
          <details class="prompt arm-prompt"><summary>Exact prompt</summary><pre>${escapeHtml(arm.renderedPrompt)}</pre></details>
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
      const signature = candidateSignature(candidate, session.selectedCandidateId === candidate.id);
      const existing = grid.querySelector(`[data-candidate="${candidate.id}"]`);
      if (existing?.dataset.signature === signature) continue;
      const replacement = candidateElement(session, arm, candidate);
      if (existing) existing.replaceWith(replacement);
      else grid.append(replacement);
    }
  }
}

function exportDisplayPath(session, exported) {
  return `${state.bootstrap.storageDisplayRoot}/sessions/${session.createdAt.slice(0, 10)}/${session.id}/${exported.directory}`;
}

function renderExports(session) {
  const container = $("#export-history");
  const signature = JSON.stringify({ sessionId: session.id, exports: session.exports });
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.innerHTML = session.exports.length
    ? `<h3>Exported bundles</h3>${session.exports
        .map((exported) => {
          const rawName = exported.raw.path.split("/").at(-1);
          const contents = [
            rawName,
            ...(exported.production ? ["production.png"] : []),
            "manifest.json",
            ...(session.references.length
              ? [
                  `references/ (${session.references.length} file${session.references.length === 1 ? "" : "s"})`,
                ]
              : []),
          ];
          return `<section class="export-record" data-export-record="${exported.id}">
            <h3>Bundle from ${escapeHtml(exported.candidateId)}</h3>
            <code>${escapeHtml(exportDisplayPath(session, exported))}</code>
            <ul>${contents.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          </section>`;
        })
        .join("")}`
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

function renderSession(session) {
  const sameSession = state.currentSession?.id === session.id;
  if (!sameSession) stopPolling();
  state.currentSession = session;
  $("#session-view").classList.remove("hidden");
  $("#session-meta").textContent =
    `${session.id} · ${session.settings.modelId} · ${session.settings.size}`;
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
  renderExports(session);
  const active = candidates.some((candidate) => ["queued", "running"].includes(candidate.status));
  $("#cancel").disabled = !active;
  if (active) schedulePoll(session.id);
  else stopPolling();
}

async function refreshSession(sessionId, fromPoll = false) {
  try {
    const result = await api(`/api/sessions/${sessionId}`);
    if (fromPoll && state.currentSession?.id !== sessionId) return;
    renderSession(result.session);
    if (fromPoll && !["queued", "running"].includes(result.session.status)) await loadHistory();
  } catch (error) {
    showSessionMessage(error.message, true);
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
            `<button class="history-item" type="button" data-session="${session.id}"><strong>${escapeHtml(session.subject)}</strong><span>${escapeHtml(session.status)} · ${new Date(session.createdAt).toLocaleString()}</span></button>`,
        )
        .join("")
    : '<p class="hint">No workbench sessions yet.</p>';
  for (const button of document.querySelectorAll("[data-session]")) {
    button.onclick = () => refreshSession(button.dataset.session);
  }
}

async function selectCandidate(candidateId) {
  showSessionMessage("Selecting winner…");
  try {
    const result = await api(`/api/sessions/${state.currentSession.id}/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateId }),
    });
    renderSession(result.session);
    showSessionMessage(`Winner selected: ${candidateId}. Export the bundle when ready.`);
  } catch (error) {
    showSessionMessage(error.message, true);
  }
}

async function exportCandidate(candidateId) {
  showSessionMessage("Exporting bundle…");
  try {
    const result = await api(`/api/sessions/${state.currentSession.id}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateId }),
    });
    renderSession(result.manifest);
    const path = exportDisplayPath(result.manifest, result.export);
    const production = result.export.production ? ", production.png" : "";
    const references = result.manifest.references.length ? ", references/" : "";
    showSessionMessage(`Bundle ready at ${path} (raw${production}, manifest.json${references}).`);
  } catch (error) {
    showSessionMessage(error.message, true);
  }
}

function loadSessionIntoForm(session) {
  state.derivedFromSessionId = session.id;
  state.inheritReferences = session.references.length > 0;
  $("#derived-label").textContent = `Derived from ${session.id}`;
  $("#subject").value = session.subject;
  $("#subject-count").textContent = session.subject.length;
  for (const input of document.querySelectorAll('input[name="recipe"]')) {
    input.checked = session.arms.some((arm) => arm.recipe.id === input.value);
  }
  $("#model").value = session.settings.modelId;
  updateModelSettings();
  $("#size").value = session.settings.size;
  $("#aspect").value = session.settings.aspectRatio || "1:1";
  $("#variants").value = session.settings.variantsPerRecipe;
  $("#google-search").checked = session.settings.googleSearch;
  state.references = [];
  renderReferences();
  if (state.inheritReferences) {
    $("#reference-list").innerHTML =
      `<li class="hint">${session.references.length} reference image${session.references.length === 1 ? "" : "s"} will be copied from the parent session. Uploading new references replaces them.</li>`;
  }
  updateEstimate();
  scrollTo({ top: 0, behavior: "smooth" });
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
  $("#generate-button").disabled = true;
  try {
    const result = await api("/api/sessions", { method: "POST", body: form });
    renderSession(result.session);
    await loadHistory();
  } catch (error) {
    $("#form-error").textContent = error.message;
    if (error.code === "confirmation_required") $("#confirmation-row").classList.remove("hidden");
  } finally {
    $("#generate-button").disabled = !state.bootstrap.keyConfigured;
  }
}

async function initialize() {
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
  renderRecipes();
  $("#model").innerHTML = state.bootstrap.models
    .map((model) => `<option value="${model.id}">${model.label}</option>`)
    .join("");
  $("#model").value = state.bootstrap.defaults.modelId;
  updateModelSettings();
  $("#size").value = state.bootstrap.defaults.size;
  $("#aspect").value = state.bootstrap.defaults.aspectRatio;
  $("#variants").value = state.bootstrap.defaults.variantsPerRecipe;
  updateEstimate();
  await loadHistory();
}

$("#generation-form").addEventListener("submit", submitGeneration);
$("#model").addEventListener("change", updateModelSettings);
$("#size").addEventListener("change", updateEstimate);
$("#variants").addEventListener("input", updateEstimate);
$("#subject").addEventListener("input", () => {
  $("#subject-count").textContent = $("#subject").value.length;
});
$("#references").addEventListener("change", (event) => {
  state.inheritReferences = false;
  state.references.push(...event.target.files);
  event.target.value = "";
  renderReferences();
});
$("#history-refresh").addEventListener("click", async () => {
  try {
    await loadHistory();
  } catch (error) {
    $("#history-list").innerHTML = `<p class="error" role="alert">${escapeHtml(error.message)}</p>`;
  }
});
$("#cancel").addEventListener("click", async () => {
  showSessionMessage("Cancelling remaining calls…");
  try {
    const result = await api(`/api/sessions/${state.currentSession.id}/cancel`, {
      method: "POST",
    });
    renderSession(result.session);
    showSessionMessage("Cancellation requested. In-flight billing may still occur.");
  } catch (error) {
    showSessionMessage(error.message, true);
  }
});
$("#candidate-groups").addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const select = event.target.closest("[data-select]");
  if (select) void selectCandidate(select.dataset.select);
  const exportButton = event.target.closest("[data-export]");
  if (exportButton) void exportCandidate(exportButton.dataset.export);
});
$("#regenerate").addEventListener("click", () => loadSessionIntoForm(state.currentSession));
$("#theme-toggle").addEventListener("click", () => {
  document.documentElement.dataset.theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
});

initialize().catch((error) => {
  $("#form-error").textContent = error.message;
});
