// src/preload.ts
import { contextBridge } from "electron";
contextBridge.exposeInMainWorld("openpalm", {
  updateStatus() {
    const latest = process.env.OP_ELECTRON_LATEST_VERSION ?? null;
    const url = process.env.OP_ELECTRON_LATEST_URL ?? null;
    const current = process.env.OP_ELECTRON_VERSION ?? null;
    return {
      inElectron: process.env.OP_INSIDE_ELECTRON === "1",
      currentVersion: current,
      latestVersion: latest,
      latestUrl: url,
      updateAvailable: !!latest
    };
  },
  notify(title, body) {
    new Notification(title, { body });
  }
});
