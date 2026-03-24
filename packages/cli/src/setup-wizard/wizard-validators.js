/**
 * Wizard Validators — Input validation for each wizard step.
 *
 * This file is concatenated into the wizard IIFE by server.ts.
 * Depends on: wizard-state.js (DOM helpers, state variables, constants).
 */

/* =========================================================================
   Step 0: Welcome & Identity Validation
   ========================================================================= */

function validateStep0() {
  var errEl = $("step0-error");
  hideError(errEl);
  var token = ($("admin-token").value || "").trim();
  if (token.length < 8) {
    showError(errEl, "Admin token must be at least 8 characters.");
    return false;
  }
  var name = ($("owner-name").value || "").trim();
  if (!name) {
    showError(errEl, "Your name is required.");
    return false;
  }
  var email = ($("owner-email").value || "").trim();
  if (!email) {
    showError(errEl, "Email is required.");
    return false;
  }
  return true;
}

/* =========================================================================
   Step 2: Model Selection Validation
   ========================================================================= */

function validateStep2() {
  var errEl = $("step2-error");
  hideError(errEl);

  var llm = modelSelection.llm;
  var emb = modelSelection.embedding;

  if (!llm || !llm.model) {
    showError(errEl, "Select a chat model.");
    return false;
  }
  if (!emb || !emb.model) {
    showError(errEl, "Select an embedding model.");
    return false;
  }
  return true;
}

/* =========================================================================
   Step 4: Options (Channels + Services) Validation
   ========================================================================= */

function validateStep4() {
  var errEl = $("step4-error");
  hideError(errEl);

  var errors = [];
  CHANNELS.forEach(function (ch) {
    if (!ch.credentials) return;
    if (!isChannelEnabled(ch)) return;
    var sel = channelSelection[ch.id];
    if (typeof sel !== "object" || sel === null) return;
    ch.credentials.forEach(function (cred) {
      if (cred.required && !(sel[cred.key] || "").trim()) {
        errors.push(ch.name + ": " + cred.label + " is required.");
      }
    });
  });

  if (errors.length > 0) {
    showError(errEl, errors.join(" "));
    return false;
  }
  return true;
}
