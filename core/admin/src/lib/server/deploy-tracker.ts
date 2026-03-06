/**
 * In-memory tracker for background deployment progress.
 *
 * Tracks per-service image pull and container startup status so the
 * setup wizard can show progress indicators while images download.
 */
import { createLogger } from "./logger.js";

const logger = createLogger("deploy-tracker");

export type ServiceStatus = {
  service: string;
  label: string;
  imageReady: boolean;
  containerRunning: boolean;
  error?: string;
};

export type DeployStatus = {
  phase: "pulling" | "starting" | "ready" | "error";
  message: string;
  services: ServiceStatus[];
  error?: string;
};

let deployStatus: DeployStatus | null = null;

export function getDeployStatus(): DeployStatus | null {
  return deployStatus;
}

export function initDeployStatus(services: { service: string; label: string }[]): void {
  deployStatus = {
    phase: "pulling",
    message: "Pulling container images...",
    services: services.map((s) => ({
      service: s.service,
      label: s.label,
      imageReady: false,
      containerRunning: false,
    })),
  };
  logger.info("deploy tracking initialized", { serviceCount: services.length });
}

export function markImageReady(service: string): void {
  if (!deployStatus) return;
  const entry = deployStatus.services.find((s) => s.service === service);
  if (entry) {
    entry.imageReady = true;
    logger.info("image ready", { service });
  }
}

export function markAllImagesReady(): void {
  if (!deployStatus) return;
  for (const s of deployStatus.services) {
    s.imageReady = true;
  }
  deployStatus.phase = "starting";
  deployStatus.message = "Starting services...";
}

export function markContainerRunning(service: string): void {
  if (!deployStatus) return;
  const entry = deployStatus.services.find((s) => s.service === service);
  if (entry) {
    entry.containerRunning = true;
  }
}

export function markAllRunning(): void {
  if (!deployStatus) return;
  for (const s of deployStatus.services) {
    s.imageReady = true;
    s.containerRunning = true;
  }
  deployStatus.phase = "ready";
  deployStatus.message = "All services are up and running.";
  logger.info("deploy completed successfully");
}

export function markDeployError(error: string): void {
  if (!deployStatus) return;
  deployStatus.phase = "error";
  deployStatus.message = error;
  deployStatus.error = error;
  logger.error("deploy failed", { error });
}

export function clearDeployStatus(): void {
  deployStatus = null;
}
