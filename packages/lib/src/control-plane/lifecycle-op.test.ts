/**
 * LifecycleOp discriminated-union mapping contract.
 *
 * reconcileStack used to take a 4-boolean flag bag {activate,deactivate,pull,
 * compose} where illegal combinations (e.g. deactivate:true + compose:true) were
 * structurally representable and only prose kept them apart. The flag bag is now
 * derived from a discriminated LifecycleOp union so impossible states are
 * unrepresentable — each entry point names its `kind` and the single mapping
 * function `planLifecycleOp` turns it into the exact activate/deactivate/pull/
 * compose steps that kind runs TODAY.
 *
 * This pins that mapping (the "decision object") per kind, so the refactor is
 * provably behavior-preserving against the previous per-entry-point flags:
 *   • install   → { activate:true }                              (applyInstall)
 *   • update    → {}                                             (applyUpdate)
 *   • uninstall → { deactivate:true }                            (applyUninstall)
 *   • upgrade   → { activate:true, pull:true, compose:true }     (performUpgrade)
 */
import { describe, it, expect } from "bun:test";
import { planLifecycleOp } from "./lifecycle.js";
import type { LifecycleOp } from "./lifecycle.js";

describe("planLifecycleOp — LifecycleOp kind → reconcile decision object", () => {
  it("install activates services but runs NO pull/compose (route owns compose)", () => {
    expect(planLifecycleOp({ kind: "install" })).toEqual({
      activate: true,
      deactivate: false,
      pull: false,
      compose: false,
    });
  });

  it("update reconciles without activating and runs NO pull/compose", () => {
    // No activate: preserves each service's prior running/stopped state; the
    // route drives the recreate, so the wrapper must not compose.
    expect(planLifecycleOp({ kind: "update" })).toEqual({
      activate: false,
      deactivate: false,
      pull: false,
      compose: false,
    });
  });

  it("uninstall deactivates and never touches containers (pure file/state reconcile)", () => {
    expect(planLifecycleOp({ kind: "uninstall" })).toEqual({
      activate: false, // activate stays OFF for uninstall
      deactivate: true,
      pull: false,
      compose: false,
    });
  });

  it("upgrade is the ONLY kind that pulls images and recreates containers in-wrapper", () => {
    expect(planLifecycleOp({ kind: "upgrade" })).toEqual({
      activate: true,
      deactivate: false,
      pull: true,
      compose: true,
    });
  });

  it("install does NOT run compose while upgrade does (the compose gate)", () => {
    // Only the upgrade kind drives compose inside the wrapper; install/update/
    // uninstall leave the bespoke compose phase to their routes.
    expect(planLifecycleOp({ kind: "install" }).compose).toBe(false);
    expect(planLifecycleOp({ kind: "update" }).compose).toBe(false);
    expect(planLifecycleOp({ kind: "uninstall" }).compose).toBe(false);
    expect(planLifecycleOp({ kind: "upgrade" }).compose).toBe(true);
  });

  it("no plan is ever both deactivate and compose (the impossible state)", () => {
    const kinds: LifecycleOp[] = [
      { kind: "install" },
      { kind: "update" },
      { kind: "uninstall" },
      { kind: "upgrade" },
    ];
    for (const op of kinds) {
      const plan = planLifecycleOp(op);
      expect(plan.deactivate && plan.compose).toBe(false);
    }
  });
});
