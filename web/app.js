const state = {
  bootstrap: null,
  recipeFamily: "icon",
  recipeSelections: { image: [], icon: [] },
  imageAspectRatio: "16:9",
  references: [],
  referencePreviewUrls: new Map(),
  currentSession: null,
  derivedFromSessionId: undefined,
  inheritReferences: false,
  poll: undefined,
  focusedCandidateId: undefined,
  exportSelectedIds: new Set(),
  exporting: false,
  creating: false,
  historyCount: 0,
  historyUnavailable: false,
  epoch: 0,
  sessionLoadIntent: 0,
  historyLoadIntent: 0,
  pollError: undefined,
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

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

const focusAttributes = [
  "data-focus-candidate",
  "data-export-select",
  "data-primary",
  "data-clear-primary",
  "data-download",
  "data-export",
  "data-export-selected",
  "data-download-selected",
  "data-terminal-recovery",
];

function captureFocus(root) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return undefined;
  if (active.id) return `#${CSS.escape(active.id)}`;
  for (const attribute of focusAttributes) {
    if (!active.hasAttribute(attribute)) continue;
    const value = active.getAttribute(attribute);
    return value === "" ? `[${attribute}]` : `[${attribute}="${CSS.escape(value)}"]`;
  }
}

function restoreFocus(root, selector) {
  if (!selector) return;
  root.querySelector(selector)?.focus({ preventScroll: true });
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

function familyForRecipe(recipe) {
  return recipe.export.type === "folio-icon" ? "icon" : "image";
}

function selectedRecipes() {
  const selected = new Set(selectedRecipeIds());
  return state.bootstrap.recipes.filter((recipe) => selected.has(recipe.id));
}

function customRecipeOnly() {
  const recipes = selectedRecipes();
  return recipes.length === 1 && recipes[0].kind === "custom";
}

function selectedPaletteId() {
  return (
    document.querySelector('input[name="palette"]:checked')?.value ??
    state.bootstrap?.defaults.paletteId
  );
}

function showRecipeFeedback(message) {
  $("#recipe-feedback").textContent = message;
}

function renderOutputOptions() {
  const input = document.querySelector(
    `input[name="output-family"][value="${state.recipeFamily}"]`,
  );
  if (input) input.checked = true;
}

function renderRecipes() {
  const recipes = state.bootstrap.recipes.filter(
    (recipe) => familyForRecipe(recipe) === state.recipeFamily,
  );
  $("#recipe-options").innerHTML = recipes
    .map(
      (recipe) => `<label class="recipe-option">
        <input type="checkbox" name="recipe" value="${recipe.id}">
        <span class="recipe-card"><strong>${escapeHtml(recipe.name)}</strong><small>${escapeHtml(recipe.description)}</small></span>
      </label>`,
    )
    .join("");
  const defaults = state.recipeSelections[state.recipeFamily].length
    ? state.recipeSelections[state.recipeFamily]
    : state.bootstrap.defaults.recipeIdsByFamily[state.recipeFamily];
  for (const id of defaults) {
    const input = document.querySelector(`input[name="recipe"][value="${id}"]`);
    if (input) input.checked = true;
  }
  state.recipeSelections[state.recipeFamily] = selectedRecipeIds();
  for (const input of document.querySelectorAll('input[name="recipe"]')) {
    input.addEventListener("change", () => {
      showRecipeFeedback("");
      const recipe = state.bootstrap.recipes.find((item) => item.id === input.value);
      if (!recipe) return;
      if (!recipe.comparable && input.checked) {
        const replaced = selectedRecipeIds().filter((id) => id !== recipe.id).length;
        for (const other of document.querySelectorAll('input[name="recipe"]')) {
          if (other !== input) other.checked = false;
        }
        if (replaced) showRecipeFeedback(`${recipe.name} replaces the selected style recipes.`);
      } else if (input.checked) {
        const custom = selectedRecipes().find((item) => !item.comparable);
        if (custom) {
          const customInput = document.querySelector(
            `input[name="recipe"][value="${CSS.escape(custom.id)}"]`,
          );
          if (customInput) customInput.checked = false;
          showRecipeFeedback("Custom was replaced so these styles can be compared.");
        }
        if (selectedRecipeIds().length > 3) {
          input.checked = false;
          showRecipeFeedback("Choose up to three style recipes per run.");
        }
      }
      if (!selectedRecipeIds().length) {
        input.checked = true;
        showRecipeFeedback("At least one style recipe is required.");
      }
      state.recipeSelections[state.recipeFamily] = selectedRecipeIds();
      updatePaletteAvailability();
      updatePaletteDescription();
      updateEstimate();
    });
  }
  updatePaletteAvailability();
}

function setRecipeFamily(family) {
  if (!["image", "icon"].includes(family) || family === state.recipeFamily) return;
  showRecipeFeedback("");
  state.recipeSelections[state.recipeFamily] = selectedRecipeIds();
  state.recipeFamily = family;
  renderOutputOptions();
  renderRecipes();
  applyFamilyConstraints();
  updatePaletteDescription();
  updateEstimate();
}

function renderPalettes() {
  $("#palette-options").innerHTML = state.bootstrap.palettes
    .map(
      (palette) => `<label class="palette-option">
        <input type="radio" name="palette" value="${escapeHtml(palette.id)}">
        <span class="palette-card">
          <svg class="palette-swatch" viewBox="0 0 ${palette.colors.length} 1" preserveAspectRatio="none" focusable="false" aria-hidden="true">${palette.colors.map((color, index) => `<rect x="${index}" y="0" width="1" height="1" fill="${escapeHtml(color)}"></rect>`).join("")}</svg>
          <strong>${escapeHtml(palette.name)}</strong>
          <small>${palette.colors.length} colors</small>
        </span>
      </label>`,
    )
    .join("");
  const defaultPalette = document.querySelector(
    `input[name="palette"][value="${CSS.escape(state.bootstrap.defaults.paletteId)}"]`,
  );
  if (defaultPalette) defaultPalette.checked = true;
  updatePaletteDescription();
}

function updatePaletteDescription() {
  if (!state.bootstrap) return;
  const palette = state.bootstrap.palettes.find((item) => item.id === selectedPaletteId());
  if (!palette) return;
  const unused = customRecipeOnly();
  $("#palette-status").textContent = unused ? "Palette not used." : "";
  $("#palette-description-copy").textContent = unused
    ? " Custom uses the subject as its complete prompt, so no palette is inserted."
    : palette.description;
}

function updatePaletteAvailability() {
  $("#palette-picker").disabled = customRecipeOnly();
}

function applyFamilyConstraints() {
  const aspect = $("#aspect");
  if (!aspect.options.length) return;
  const icon = state.recipeFamily === "icon";
  aspect.disabled = icon;
  if (icon) {
    aspect.value = "1:1";
  } else if ([...aspect.options].some((option) => option.value === state.imageAspectRatio)) {
    aspect.value = state.imageAspectRatio;
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
  applyFamilyConstraints();
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

function providerFailureMessage(raw) {
  const message = String(raw ?? "").toLowerCase();
  if (
    /(?:code|status|http)[^a-z0-9]{0,8}429|too many requests|rate limit exceeded|resource_exhausted/.test(
      message,
    )
  ) {
    return "The provider rate limit was reached. Edit the setup and regenerate in a moment.";
  }
  if (
    /(?:code|status|http)[^a-z0-9]{0,8}(?:401|403)|unauthenticated|invalid api key|api key not valid|permission_denied/.test(
      message,
    )
  ) {
    return "The provider rejected the credentials. Check GEMINI_API_KEY, then edit the setup and regenerate.";
  }
  if (/finish_reason.?safety|blocked_reason|prompt was blocked|safety settings/.test(message)) {
    return "The provider blocked this request. Edit the subject or references and regenerate.";
  }
  if (
    /fetch failed|network error|econn|etimedout|timed out|connection (?:refused|reset)/.test(
      message,
    )
  ) {
    return "The provider could not be reached. Check the connection, then edit the setup and regenerate.";
  }
  if (message.includes("provider returned no image")) {
    return "The provider returned no image. Edit the setup and regenerate the run.";
  }
  return "This candidate could not be generated. Edit the setup and regenerate the run.";
}

function candidateFailureMessage(candidate) {
  const error = String(candidate.error ?? "");
  if (
    candidate.status === "interrupted" &&
    error === "Workbench stopped before this call completed."
  ) {
    return "The workbench stopped before this call completed. Edit the setup and regenerate the run.";
  }
  if (
    candidate.status === "interrupted" &&
    error === "Workbench stopped before this call was submitted."
  ) {
    return "The workbench stopped before this call was submitted. Edit the setup and regenerate the run.";
  }
  if (
    candidate.status === "cancel-requested" &&
    error === "Generation stopped locally after cancellation was requested."
  ) {
    return "Generation stopped on this workbench after cancellation was requested.";
  }
  return providerFailureMessage(error);
}

function candidateMessages(arm, candidate, includeFailureDetail = false) {
  const messages = [];
  if (candidate.cancellation?.billing === "unknown-may-be-charged") {
    messages.push("Cancellation requested; billing may still occur.");
  }
  if (candidate.error && includeFailureDetail) messages.push(candidateFailureMessage(candidate));
  if (
    candidate.status === "succeeded" &&
    arm.recipe.export.type === "folio-icon" &&
    candidate.images[0]?.width !== candidate.images[0]?.height
  ) {
    messages.push("Export unavailable: project icons require a square generated image.");
  }
  return messages.join(" ");
}

function terminalCandidateLabel(status) {
  return {
    failed: "Generation failed",
    interrupted: "Generation interrupted",
    "cancel-requested": "Cancellation requested",
  }[status];
}

function statusLabel(status) {
  return (
    {
      queued: "Queued",
      running: "Running",
      succeeded: "Succeeded",
      failed: "Failed",
      interrupted: "Interrupted",
      "cancel-requested": "Cancellation requested",
      completed: "Completed",
      partial: "Partial",
      cancelled: "Cancelled",
    }[status] ?? status
  );
}

function isTerminalRecoverySession(session) {
  const candidates = session.arms.flatMap((arm) => arm.candidates);
  return (
    !candidates.some((candidate) => candidate.status === "succeeded") &&
    ["failed", "interrupted", "cancelled"].includes(session.status)
  );
}

function renderCandidate(session, arm, candidate) {
  const identity = candidateIdentity(session, arm, candidate);
  const ready = candidate.status === "succeeded" && candidate.images.length;
  const primary = session.selectedCandidateId === candidate.id;
  const focused = state.focusedCandidateId === candidate.id;
  const selectedForExport = state.exportSelectedIds.has(candidate.id);
  const exported = session.exports.some((record) => record.candidateId === candidate.id);
  const message = candidateMessages(arm, candidate);
  const terminalLabel = terminalCandidateLabel(candidate.status);
  return `<article class="candidate${focused ? " focused" : ""}${primary ? " primary-candidate" : ""}" data-candidate="${candidate.id}" aria-label="${escapeHtml(identity)}">
    <div class="candidate-flags">
      <label class="export-check"><input type="checkbox" data-export-select="${candidate.id}" aria-label="Select ${escapeHtml(identity)} for download or export" ${selectedForExport ? "checked" : ""} ${candidateExportReady(arm, candidate) ? "" : "disabled"}><span aria-hidden="true">Select</span></label>
      <span class="candidate-flag-list">${primary ? '<strong class="flag flag-primary">Primary</strong>' : ""}${exported ? '<strong class="flag flag-exported">Exported</strong>' : ""}</span>
    </div>
    <button class="candidate-focus" type="button" data-focus-candidate="${candidate.id}" aria-pressed="${focused}" aria-label="Inspect ${escapeHtml(identity)}">
      ${ready ? `<img src="${candidateImageUrl(session.id, candidate.id)}" alt="Generated ${escapeHtml(identity)}">` : terminalLabel ? `<span class="candidate-placeholder terminal-placeholder${candidate.status === "failed" ? " failed-placeholder" : ""}"><strong>${terminalLabel}</strong></span>` : `<span class="candidate-placeholder" aria-hidden="true"></span>`}
      ${primary ? '<span class="primary-badge" aria-hidden="true">✓</span>' : ""}
    </button>
    <div class="candidate-label"><strong>Variant ${candidate.variant} of ${arm.candidates.length}</strong>${candidate.status === "succeeded" ? "" : `<span>${escapeHtml(statusLabel(candidate.status))}</span>`}</div>
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
      const focusedControl = existing ? captureFocus(existing) : undefined;
      const replacement = candidateElement(session, arm, candidate);
      if (existing) {
        existing.replaceWith(replacement);
        restoreFocus(replacement, focusedControl);
      } else grid.append(replacement);
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
  const focusedControl = captureFocus(container);
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
  const message = candidateMessages(arm, candidate, true);
  const terminalLabel = terminalCandidateLabel(candidate.status);
  const showTerminalRecovery = Boolean(terminalLabel) && isTerminalRecoverySession(session);
  const cost = candidate.cost;
  let costDisplay = "";
  if (typeof cost?.usd === "number") {
    costDisplay = `${cost.status === "upper-bound" ? "Up to " : ""}$${cost.usd.toFixed(4)}${cost.excludesGrounding ? " (grounding not included)" : ""}`;
  } else if (candidate.cancellation?.billing === "unknown-may-be-charged") {
    costDisplay = "Unknown; may have been charged";
  } else if (cost?.status === "unavailable") {
    costDisplay = "Unavailable";
  }
  container.innerHTML = `<div class="inspector-content">
    <ol class="identity-path" aria-label="Candidate identity"><li>${escapeHtml(arm.recipe.name)}</li><li>${escapeHtml(session.subject)}</li><li>Variant ${candidate.variant} of ${arm.candidates.length}</li></ol>
    ${ready ? `<img class="inspector-image" src="${imageUrl}" alt="Generated ${escapeHtml(identity)}">` : terminalLabel ? `<div class="inspector-placeholder terminal-placeholder${candidate.status === "failed" ? " failed-placeholder" : ""}"><strong>${terminalLabel}</strong></div>` : '<div class="inspector-placeholder" aria-hidden="true"></div>'}
    ${nativePreview}
    <div class="inspector-section"><h3>Status and cost</h3><dl class="inspector-facts"><div class="inspector-fact"><dt>Status</dt><dd>${escapeHtml(statusLabel(candidate.status))}</dd></div>${costDisplay ? `<div class="inspector-fact"><dt>Cost</dt><dd>${escapeHtml(costDisplay)}</dd></div>` : ""}</dl>${message ? `<p class="candidate-message">${escapeHtml(message)}</p>` : ""}${showTerminalRecovery ? '<button class="primary inspector-recovery" type="button" data-terminal-recovery>Edit setup and retry</button>' : ""}</div>
    ${
      showTerminalRecovery
        ? ""
        : `<div class="inspector-section"><h3>Primary</h3><p>${primary ? "This is the Primary candidate for the run." : "Primary is optional and does not control exports."}</p>${primary ? '<button type="button" data-clear-primary>Clear Primary</button>' : `<button type="button" data-primary="${candidate.id}" ${ready ? "" : "disabled"}>Set as Primary</button>`}</div>
    <div class="inspector-section"><h3>Download or export</h3><p>Download a ZIP to this browser, or save a durable export on the Workbench server.</p><div class="inspector-actions"><button class="primary" type="button" data-download="${candidate.id}" ${exportReady ? "" : "disabled"}>Download candidate as ZIP</button><button type="button" data-export="${candidate.id}" ${exportReady ? (state.exporting ? 'aria-disabled="true"' : "") : "disabled"}>${state.exporting ? "Exporting…" : "Export candidate to disk"}</button></div>${exportedCount ? `<p>Exported to disk ${exportedCount} time${exportedCount === 1 ? "" : "s"}.</p>` : ""}</div>`
    }
  </div>`;
  restoreFocus(container, focusedControl);
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
  const palette = session.arms.some((arm) => arm.recipe.kind !== "custom")
    ? `<div><dt>Palette</dt><dd>${escapeHtml(session.palette?.name || "Folio teal")}</dd></div>`
    : "";
  $("#summary-settings").innerHTML =
    `${palette}<div><dt>Model</dt><dd>${escapeHtml(modelShortLabel(session.settings.modelId))}</dd></div><div><dt>Resolution</dt><dd>${escapeHtml(formatSize(session.settings.size))}</dd></div><div><dt>Aspect</dt><dd>${escapeHtml(session.settings.aspectRatio || "default")}</dd></div><div><dt>Variants</dt><dd>${session.settings.variantsPerRecipe} per style</dd></div>`;
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

function scrollBehavior() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function renderExportTray() {
  const tray = $("#export-tray");
  const focusedControl = captureFocus(tray);
  const count = state.exportSelectedIds.size;
  tray.hidden = count === 0;
  tray.innerHTML = count
    ? `<button class="primary" type="button" data-download-selected>Download ZIP (${count})</button><button type="button" data-export-selected ${state.exporting ? 'aria-disabled="true"' : ""}>${state.exporting ? "Exporting…" : `Export to disk (${count})`}</button>`
    : "";
  restoreFocus(tray, focusedControl);
}

function downloadCandidates(candidateIds) {
  const sessionId = state.currentSession?.id;
  if (!sessionId || !candidateIds.length) return;
  const parameters = new URLSearchParams();
  for (const candidateId of candidateIds) {
    parameters.append("candidateId", candidateId);
  }
  const link = document.createElement("a");
  link.href = `/api/sessions/${encodeURIComponent(sessionId)}/download?${parameters}`;
  link.download = `nano-banana-${sessionId}.zip`;
  document.body.append(link);
  link.click();
  link.remove();
  showSessionMessage(
    `Browser download started for ${candidateIds.length} candidate${candidateIds.length === 1 ? "" : "s"}.`,
  );
}

function downloadSelected() {
  downloadCandidates([...state.exportSelectedIds]);
}

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

function segmentText(text) {
  return [...graphemeSegmenter.segment(text)];
}

function boundedCut(text, limit) {
  const segments = segmentText(text);
  const boundary = segments[limit]?.index ?? text.length;
  const space = text.slice(0, boundary).lastIndexOf(" ");
  if (space > 40) return space;
  return boundary;
}

function splitSubject(subject) {
  const text = String(subject ?? "").trim();
  if (!text) return { title: "Candidates", subtitle: "" };
  const newline = text.indexOf("\n");
  if (!graphemeSegmenter) {
    if (newline === -1) return { title: text, subtitle: "" };
    const firstLine = text.slice(0, newline);
    return {
      title: firstLine.trim() || text,
      subtitle: text.slice(newline + 1).trim(),
    };
  }
  if (newline === -1 && segmentText(text).length <= 90) return { title: text, subtitle: "" };

  const firstLine = newline === -1 ? text : text.slice(0, newline);
  const rest = newline === -1 ? "" : text.slice(newline + 1);
  let lead = firstLine;
  let overflow = "";
  if (segmentText(lead).length > 90) {
    const sentence = lead.match(/^.+?[.!?](?=\s|$)/);
    const cut =
      sentence && segmentText(sentence[0]).length <= 120
        ? sentence[0].length
        : boundedCut(lead, 90);
    overflow = lead.slice(cut);
    lead = lead.slice(0, cut);
  }
  const title = lead.trim() || firstLine.trim() || text;
  const subtitle = [overflow, rest]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return { title, subtitle };
}

function applySessionSubject(subject) {
  const { title, subtitle } = splitSubject(subject);
  $("#session-title").textContent = title;
  const element = $("#session-subtitle");
  element.textContent = subtitle;
  element.hidden = !subtitle;
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
  $("#edit-setup").disabled = false;
  $("#regenerate").disabled = false;
  $("#session-view").classList.remove("hidden", "loading");
  $("#session-meta").textContent =
    `${session.arms.length} style${session.arms.length === 1 ? "" : "s"} · ${modelShortLabel(session.settings.modelId)} · ${formatSize(session.settings.size)}`;
  applySessionSubject(session.subject);
  const candidates = session.arms.flatMap((arm) => arm.candidates);
  const counts = Object.groupBy(candidates, (candidate) => candidate.status);
  const progress = [`${candidates.length} total`, `${counts.succeeded?.length || 0} succeeded`];
  for (const [status, label] of [
    ["running", "running"],
    ["queued", "queued"],
    ["failed", "failed"],
    ["interrupted", "interrupted"],
    ["cancel-requested", "cancel requested"],
  ]) {
    const count = counts[status]?.length || 0;
    if (count) progress.push(`${count} ${label}`);
  }
  setText($("#progress"), progress.join(" · "));
  renderCandidateGroups(session, sameSession);
  renderInspector(session);
  renderExportTray();
  renderExports(session);
  updateRunSummary(session);
  if (!sameSession) setEditorCollapsed(true);
  updateHistoryCurrent();
  const active = ["queued", "running"].includes(session.status);
  $("#cancel").disabled = !active;
  $("#cancel").hidden = !active;
  if (active) schedulePoll(session.id);
  else stopPolling();
}

function renderLoadingSession(subject) {
  stopPolling();
  state.sessionLoadIntent++;
  state.currentSession = null;
  state.focusedCandidateId = undefined;
  state.exportSelectedIds.clear();
  state.pollError = undefined;
  $("#edit-setup").disabled = true;
  $("#regenerate").disabled = true;
  $("#cancel").disabled = true;
  $("#cancel").hidden = true;
  $("#candidate-inspector").dataset.signature = "";
  renderExportTray();
  updateHistoryCurrent();
  $("#session-view").classList.remove("hidden");
  $("#session-view").classList.add("loading");
  $("#session-meta").textContent = "Starting generation";
  applySessionSubject(subject);
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

function resetGenerateButton() {
  $("#generate-button").textContent = state.creating ? "Generating…" : "Generate";
  $("#generate-button").disabled = state.creating || !state.bootstrap.keyConfigured;
}

function transitionToResults() {
  requestAnimationFrame(() => {
    $("#session-title").focus({ preventScroll: true });
    $("#session-view").scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  });
}

async function refreshSession(sessionId, fromPoll = false) {
  const epoch = state.epoch;
  const intent = fromPoll ? undefined : ++state.sessionLoadIntent;
  if (!fromPoll) resetGenerateButton();
  try {
    const result = await api(`/api/sessions/${sessionId}`);
    if (state.epoch !== epoch) return;
    if (!fromPoll && state.sessionLoadIntent !== intent) return;
    if (fromPoll && state.currentSession?.id !== sessionId) return;
    if (
      fromPoll &&
      state.pollError?.sessionId === sessionId &&
      $("#session-message").textContent === state.pollError.message
    ) {
      showSessionMessage("");
      state.pollError = undefined;
    }
    renderSession(result.session);
    if (!fromPoll) transitionToResults();
    if (fromPoll && !["queued", "running"].includes(result.session.status)) {
      await loadHistory().catch(renderHistoryError);
    }
  } catch (error) {
    if (state.epoch !== epoch) return;
    if (!fromPoll && state.sessionLoadIntent !== intent) return;
    if (fromPoll && state.currentSession?.id !== sessionId) return;
    if (error.code === "session_not_found") {
      if (!fromPoll && state.currentSession && state.currentSession.id !== sessionId) {
        await loadHistory().catch(renderHistoryError);
        return;
      }
      const vanishedSession = state.currentSession;
      if (vanishedSession) loadSessionIntoForm(vanishedSession);
      resetResultsView({ hide: true });
      state.derivedFromSessionId = undefined;
      state.inheritReferences = false;
      $("#derived-label").textContent = "";
      clearReferences();
      renderReferences();
      setEditorCollapsed(false);
      showSessionMessage("");
      $("#form-error").textContent = "This run is no longer available. Start a new run.";
      $("#subject").focus({ preventScroll: true });
      return;
    }
    showSessionMessage(error.message, true);
    if (fromPoll) state.pollError = { sessionId, message: error.message };
    const active = ["queued", "running"].includes(state.currentSession?.status);
    if (fromPoll && state.currentSession?.id === sessionId && active) schedulePoll(sessionId);
  }
}

function resetResultsView({ hide }) {
  // Bump the epoch so any in-flight session/history response that resolves after
  // this reset is discarded instead of repainting a deleted session.
  state.epoch++;
  stopPolling();
  state.currentSession = null;
  state.focusedCandidateId = undefined;
  state.exportSelectedIds.clear();
  state.exporting = false;
  state.pollError = undefined;
  state.sessionLoadIntent++;
  const view = $("#session-view");
  view.classList.remove("loading");
  view.classList.toggle("hidden", hide);
  $("#candidate-groups").innerHTML = "";
  const inspector = $("#candidate-inspector");
  inspector.innerHTML = "";
  inspector.dataset.signature = "";
  const exportHistory = $("#export-history");
  exportHistory.hidden = true;
  exportHistory.innerHTML = "";
  exportHistory.dataset.signature = "";
  const tray = $("#export-tray");
  tray.hidden = true;
  tray.innerHTML = "";
  $("#cancel").disabled = true;
  $("#cancel").hidden = true;
  $("#edit-setup").disabled = true;
  $("#regenerate").disabled = true;
  updateHistoryCurrent();
}

async function clearHistory() {
  const count = state.historyCount ?? 0;
  if (!count && !state.historyUnavailable) return;
  const confirmed = confirm(
    state.historyUnavailable
      ? "Permanently delete all stored runs and all generated and exported images? This can't be undone."
      : `Permanently delete ${count} stored run${count === 1 ? "" : "s"} and all generated and exported images? This can't be undone.`,
  );
  if (!confirmed) return;
  const status = $("#history-clear-status");
  status.classList.remove("error");
  status.textContent = "Clearing history…";
  $("#history-clear").disabled = true;
  try {
    const result = await api("/api/history", { method: "DELETE" });
    resetResultsView({ hide: true });
    state.derivedFromSessionId = undefined;
    state.inheritReferences = false;
    $("#derived-label").textContent = "";
    $("#form-error").textContent = "";
    clearReferences();
    renderReferences();
    showSessionMessage("");
    setEditorCollapsed(false);
    state.historyUnavailable = false;
    state.historyCount = 0;
    $("#history-clear").textContent = "Clear history";
    $("#history-clear").disabled = true;
    $("#history-list").innerHTML = '<p class="hint">No workbench sessions yet.</p>';
    renderSpend([]);
    updateHistoryCurrent();
    status.textContent = `Cleared ${result.cleared} stored run${result.cleared === 1 ? "" : "s"}.`;
    $("#subject").focus();
  } catch (error) {
    await loadHistory().catch(renderHistoryError);
    status.classList.add("error");
    status.textContent = error.message;
    $("#history-clear").focus({ preventScroll: true });
  }
}

function showSessionMessage(message, isError = false) {
  const element = $("#session-message");
  element.textContent = message;
  element.classList.toggle("error", isError);
}

async function loadHistory() {
  const epoch = state.epoch;
  const intent = ++state.historyLoadIntent;
  let result;
  try {
    result = await api("/api/history");
  } catch (error) {
    if (state.epoch !== epoch || state.historyLoadIntent !== intent) return;
    throw error;
  }
  if (state.epoch !== epoch || state.historyLoadIntent !== intent) return;
  state.historyUnavailable = false;
  state.historyCount = result.sessions.length;
  $("#history-clear").textContent = "Clear history";
  $("#history-clear").disabled = result.sessions.length === 0;
  $("#history-list").innerHTML = result.sessions.length
    ? result.sessions
        .map(
          (session) =>
            `<button class="history-item" type="button" data-session="${session.id}" ${session.id === state.currentSession?.id ? 'aria-current="true"' : ""}><div class="history-recipe-line"><strong>${escapeHtml(session.recipes.join(" + "))}</strong><span class="history-style-count" aria-label="${session.recipes.length} style${session.recipes.length === 1 ? "" : "s"} generated">${session.recipes.length}</span></div><span>${escapeHtml(session.subject)}</span><small>${escapeHtml(statusLabel(session.status))} · ${new Date(session.createdAt).toLocaleString()}</small></button>`,
        )
        .join("")
    : '<p class="hint">No workbench sessions yet.</p>';
  for (const button of document.querySelectorAll("[data-session]")) {
    button.onclick = () => refreshSession(button.dataset.session);
  }
  renderSpend(result.sessions);
  updateHistoryCurrent();
}

function renderHistoryError(error) {
  if (error.code === "history_read_failed") {
    state.historyUnavailable = true;
    state.historyCount = null;
    $("#history-list").innerHTML =
      '<p class="error" role="alert">Stored history is unavailable. Clear all history to recover.</p>';
    $("#history-clear").textContent = "Clear all history";
    $("#history-clear").disabled = false;
    $("#spend-toggle").hidden = true;
    setSpendOpen(false);
    return;
  }
  $("#history-list").innerHTML = `<p class="error" role="alert">${escapeHtml(error.message)}</p>`;
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
  const sessionId = state.currentSession?.id;
  if (!sessionId || state.exporting) return;
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
  let completed = 0;
  const failures = [];
  let latestSession = state.currentSession;
  for (const candidateId of candidateIds) {
    try {
      const result = await requestExport(sessionId, candidateId);
      latestSession = result.manifest;
      succeeded++;
    } catch (error) {
      const found = findCandidate(latestSession, candidateId);
      const identity = found
        ? candidateIdentity(latestSession, found.arm, found.candidate)
        : "Unknown candidate";
      failures.push(`${identity}: ${error.message}`);
    } finally {
      completed++;
      if (state.currentSession?.id === sessionId) {
        showSessionMessage(`Exporting ${completed} of ${candidateIds.length} selected candidates…`);
      }
    }
  }
  state.exporting = false;
  if (state.currentSession?.id !== sessionId) {
    if (state.currentSession) renderInspector(state.currentSession);
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
      "[data-terminal-recovery], [data-primary]:not(:disabled), [data-clear-primary], [data-download]:not(:disabled), [data-export]:not(:disabled)",
    )
    ?.focus();
}

function loadSessionIntoForm(session) {
  if (!session) return;
  state.derivedFromSessionId = session.id;
  state.inheritReferences = session.references.length > 0;
  $("#derived-label").textContent = `Based on current session`;
  $("#subject").value = session.subject;
  updateSubjectCount();
  state.recipeFamily = familyForRecipe(session.arms[0].recipe);
  state.recipeSelections[state.recipeFamily] = session.arms.map((arm) => arm.recipe.id);
  if (state.recipeFamily === "image") {
    state.imageAspectRatio = session.settings.aspectRatio || "16:9";
  }
  renderOutputOptions();
  renderRecipes();
  const palette = document.querySelector(
    `input[name="palette"][value="${CSS.escape(session.palette?.id || state.bootstrap.defaults.paletteId)}"]`,
  );
  if (palette) palette.checked = true;
  updatePaletteDescription();
  $("#model").value = session.settings.modelId;
  updateModelSettings();
  $("#size").value = session.settings.size;
  $("#aspect").value = state.recipeFamily === "icon" ? "1:1" : state.imageAspectRatio;
  applyFamilyConstraints();
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
  $("#generation-form").scrollIntoView({ behavior: scrollBehavior(), block: "start" });
}

async function submitGeneration(event) {
  event.preventDefault();
  if (state.creating) return;
  $("#form-error").textContent = "";
  const recipeIds = selectedRecipeIds();
  if (!recipeIds.length) return;
  const payload = {
    subject: $("#subject").value,
    recipeIds,
    paletteId: selectedPaletteId(),
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
  state.creating = true;
  resetGenerateButton();
  renderLoadingSession(payload.subject);
  const intent = state.sessionLoadIntent;
  transitionToResults();
  try {
    const result = await api("/api/sessions", { method: "POST", body: form });
    state.creating = false;
    resetGenerateButton();
    if (state.sessionLoadIntent !== intent) return;
    renderSession(result.session);
    transitionToResults();
    await loadHistory().catch(renderHistoryError);
  } catch (error) {
    if (state.sessionLoadIntent !== intent) return;
    $("#session-view").classList.add("hidden");
    $("#form-error").textContent = error.message;
    if (error.code === "confirmation_required") $("#confirmation-row").classList.remove("hidden");
  } finally {
    if (state.creating) {
      state.creating = false;
      resetGenerateButton();
    }
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
  $("#history-toggle").title = open ? "Hide history" : "Show history";
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

function modelNameParts(modelId) {
  const label = modelLabel(modelId);
  const index = label.indexOf(" · ");
  if (index === -1) return { name: label, detail: "" };
  return { name: label.slice(0, index), detail: label.slice(index + 3) };
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
    unknownGroundingChargeCount: 0,
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
  summary.unknownGroundingChargeCount += spend.unknownGroundingChargeCount ?? 0;
  if (spend.status === "partial") summary.partial = true;
  if (spend.status === "unavailable" && spend.unavailableCount > 0) summary.unavailable = true;
}

function spendCaveats(summary) {
  const caveats = [];
  if (summary.unavailable || summary.unavailableCount > 0) {
    caveats.push("Some image costs are unavailable.");
  }
  if (summary.unknownMayBeChargedCount > 0) {
    caveats.push(
      `${summary.unknownMayBeChargedCount} canceled request${summary.unknownMayBeChargedCount === 1 ? " may" : "s may"} have been charged.`,
    );
  }
  if (summary.unknownGroundingChargeCount > 0) {
    caveats.push(
      `Grounding charges are not included for ${summary.unknownGroundingChargeCount} candidate request${summary.unknownGroundingChargeCount === 1 ? "" : "s"}.`,
    );
  }
  return caveats;
}

function formatSpend(summary, compact = false) {
  const parts = [];
  if (summary.hasCalculatedUsd) parts.push(`$${summary.calculatedUsd.toFixed(2)}`);
  if (summary.hasUpperBoundUsd) parts.push(`up to $${summary.upperBoundUsd.toFixed(2)}`);
  const caveats = spendCaveats(summary);
  if (caveats.length) {
    if (!parts.length && summary.unknownMayBeChargedCount > 0) return "May have charges";
    if (!parts.length) return "Cost unavailable";
    return `${compact ? "Partial · " : "Known: "}${parts.join(" + ")}`;
  }
  return parts.length ? parts.join(" + ") : "$0.00";
}

function renderSpend(sessions) {
  const toggle = $("#spend-toggle");
  if (!sessions.length) {
    toggle.hidden = true;
    setSpendOpen(false);
    $("#spend-total").textContent = "$0.00";
    toggle.setAttribute("aria-label", "All stored runs spend: $0.00");
    $("#spend-breakdown").innerHTML = "";
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
  const totalLabel = formatSpend(total, true);
  $("#spend-total").textContent = totalLabel;
  toggle.setAttribute("aria-label", `All stored runs spend: ${totalLabel}`);
  const rows = [...byModel.entries()]
    .sort(
      (a, b) =>
        b[1].spend.calculatedUsd +
        b[1].spend.upperBoundUsd -
        (a[1].spend.calculatedUsd + a[1].spend.upperBoundUsd),
    )
    .map(([modelId, entry]) => {
      const { name, detail } = modelNameParts(modelId);
      const caveats = spendCaveats(entry.spend);
      return `<div class="spend-row"><span class="spend-model"><span class="spend-model-name">${escapeHtml(name)}</span>${detail ? `<span class="spend-model-detail">${escapeHtml(detail)}</span>` : ""}</span><span class="spend-meta"><span class="muted">${entry.imageCountKnown ? `${entry.images} generated image${entry.images === 1 ? "" : "s"}` : "Generated image count unavailable"}</span><strong>${escapeHtml(formatSpend(entry.spend))}</strong></span>${caveats.length ? `<span class="spend-caveat">${escapeHtml(caveats.join(" "))}</span>` : ""}</div>`;
    })
    .join("");
  $("#spend-breakdown").innerHTML =
    `<p class="spend-head">Across all ${sessions.length} stored run${sessions.length === 1 ? "" : "s"}</p>${rows}`;
}

async function initialize() {
  const savedTheme = localStorage.getItem("nano-banana-theme");
  setTheme(savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  state.bootstrap = await api("/api/bootstrap");
  const keyStatus = $("#key-status");
  const keyLabel = state.bootstrap.keyConfigured
    ? state.bootstrap.mock
      ? "Mock generation"
      : "API key configured"
    : "API key not configured";
  const keyState = state.bootstrap.keyConfigured
    ? state.bootstrap.mock
      ? "is-mock"
      : "is-configured"
    : "is-missing";
  keyStatus.classList.add(keyState);
  keyStatus.querySelector(".key-status-label").textContent = keyLabel;
  if (!state.bootstrap.keyConfigured) {
    $("#generate-button").disabled = true;
    $("#key-guidance").classList.remove("hidden");
    $("#key-guidance").textContent =
      "Generation disabled. Add GEMINI_API_KEY=your_key to ~/.nano-banana/.env, then restart the workbench.";
  }
  $("#subject").maxLength = state.bootstrap.limits.maxSubjectLength;
  state.recipeFamily = state.bootstrap.defaults.recipeFamily;
  state.recipeSelections = {
    image: [...state.bootstrap.defaults.recipeIdsByFamily.image],
    icon: [...state.bootstrap.defaults.recipeIdsByFamily.icon],
  };
  renderOutputOptions();
  renderRecipes();
  renderPalettes();
  $("#model").innerHTML = state.bootstrap.models
    .map((model) => `<option value="${model.id}">${model.label}</option>`)
    .join("");
  $("#model").value = state.bootstrap.defaults.modelId;
  updateModelSettings();
  $("#size").value = state.bootstrap.defaults.size;
  $("#variants").value = state.bootstrap.defaults.variantsPerRecipe;
  updateSubjectCount();
  updateEstimate();
  await loadHistory().catch(renderHistoryError);
}

$("#generation-form").addEventListener("submit", submitGeneration);
$("#output-options").addEventListener("change", (event) => {
  if (event.target.name === "output-family") setRecipeFamily(event.target.value);
});
$("#model").addEventListener("change", updateModelSettings);
$("#size").addEventListener("change", updateEstimate);
$("#aspect").addEventListener("change", () => {
  if (state.recipeFamily === "image") state.imageAspectRatio = $("#aspect").value;
});
$("#variants").addEventListener("input", updateEstimate);
$("#subject").addEventListener("input", updateSubjectCount);
$("#palette-options").addEventListener("change", updatePaletteDescription);
$("#references").addEventListener("change", (event) => {
  state.inheritReferences = false;
  state.references.push(...event.target.files);
  event.target.value = "";
  renderReferences();
});
$("#history-toggle").addEventListener("click", () => {
  setHistoryOpen($("#history-toggle").getAttribute("aria-expanded") !== "true");
});
$("#history-clear").addEventListener("click", clearHistory);
$("#history-refresh").addEventListener("click", async () => {
  try {
    await loadHistory();
  } catch (error) {
    renderHistoryError(error);
  }
});
$("#edit-setup").addEventListener("click", () => {
  if (state.currentSession) loadSessionIntoForm(state.currentSession);
});
$("#cancel").addEventListener("click", async () => {
  const sessionId = state.currentSession?.id;
  if (!sessionId) return;
  $("#cancel").disabled = true;
  showSessionMessage("Cancelling remaining calls…");
  try {
    const result = await api(`/api/sessions/${sessionId}/cancel`, { method: "POST" });
    if (state.currentSession?.id !== sessionId) return;
    renderSession(result.session);
    showSessionMessage("Cancellation requested. In-flight billing may still occur.");
  } catch (error) {
    if (state.currentSession?.id === sessionId) showSessionMessage(error.message, true);
  } finally {
    if (state.currentSession?.id === sessionId) {
      $("#cancel").disabled = !["queued", "running"].includes(state.currentSession.status);
    }
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
  const downloadButton = event.target.closest("[data-download]");
  if (downloadButton) downloadCandidates([downloadButton.dataset.download]);
  const exportButton = event.target.closest("[data-export]");
  if (exportButton) void exportCandidate(exportButton.dataset.export);
  if (event.target.closest("[data-terminal-recovery]") && state.currentSession) {
    loadSessionIntoForm(state.currentSession);
  }
});
$("#export-tray").addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest("[data-download-selected]")) downloadSelected();
  if (event.target.closest("[data-export-selected]")) void exportSelected();
});
$("#regenerate").addEventListener("click", () => {
  if (state.currentSession) loadSessionIntoForm(state.currentSession);
});
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
