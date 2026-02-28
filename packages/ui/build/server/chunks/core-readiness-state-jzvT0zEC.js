let _snapshot = null;
function getCoreReadinessSnapshot() {
  return _snapshot;
}
function setCoreReadinessPhase(phase, checks = [], diagnostics = { failedServices: [] }) {
  _snapshot = {
    phase,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    checks,
    diagnostics
  };
  return _snapshot;
}
function applyReadinessResult(result) {
  const phase = result.ok ? "ready" : "failed";
  return setCoreReadinessPhase(phase, result.checks, result.diagnostics);
}
function resetCoreReadinessSnapshot() {
  _snapshot = null;
}

export { applyReadinessResult, getCoreReadinessSnapshot, resetCoreReadinessSnapshot, setCoreReadinessPhase };
//# sourceMappingURL=core-readiness-state-jzvT0zEC.js.map
