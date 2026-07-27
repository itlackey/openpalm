/**
 * Docker image/volume retention (S7 — #581 finding #11, complements E1).
 *
 * Fresh installs default to moving `latest` tags and upgrades always
 * `--pull` + `--force-recreate`, but there is no image-retention cleanup, so
 * superseded OpenPalm images accumulate; project renames tear down
 * containers without `-v`, leaving orphan project-scoped volumes (which
 * hold the hidden tool/cache copies from S2 — especially expensive).
 *
 * This module only ever REPORTS + removes artifacts it can positively
 * attribute to OpenPalm:
 *  - images: filtered server-side by `reference=<namespace>/*` (never an
 *    unattributable dangling `<none>:<none>` image — those carry no repo
 *    info and can't be verified as ours);
 *  - volumes: matched against the exact top-level volume names OpenPalm's
 *    compose files declare (optionally prefixed by a compose project name),
 *    and flagged "orphan" only when that project prefix isn't the CURRENT
 *    project name.
 */
import type { DockerClient } from "./docker.js";
import { realDockerClient, resolveComposeProjectName } from "./docker.js";

export interface DockerImageInfo {
  repository: string;
  tag: string;
  id: string;
  createdAt: string;
  /** Raw docker-formatted size string (e.g. "512MB") — display only, not parsed to bytes. */
  size: string;
}

export interface DockerVolumeInfo {
  name: string;
  driver: string;
}

export interface ImageVolumeReport {
  /** False when either docker query failed — images/volumes below are then empty, not "confirmed empty". */
  reliable: boolean;
  error?: string;
  images: DockerImageInfo[];
  supersededImages: DockerImageInfo[];
  volumes: DockerVolumeInfo[];
  orphanVolumes: DockerVolumeInfo[];
}

const IMAGE_FORMAT = "{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}\t{{.Size}}";
const VOLUME_FORMAT = "{{.Name}}\t{{.Driver}}";

export function parseDockerImagesOutput(stdout: string): DockerImageInfo[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [repository, tag, id, createdAt, size] = line.split("\t");
      return {
        repository: repository ?? "",
        tag: tag ?? "",
        id: id ?? "",
        createdAt: createdAt ?? "",
        size: size ?? "",
      };
    });
}

export function parseDockerVolumeLsOutput(stdout: string): DockerVolumeInfo[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, driver] = line.split("\t");
      return { name: name ?? "", driver: driver ?? "" };
    });
}

/**
 * Group images by repository; within a repository with more than one tagged
 * image, every entry EXCEPT the most-recently-created one is "superseded".
 * A lone image per repository supersedes nothing. `<none>` repositories
 * (dangling, untagged images) are never included — they carry no repo info
 * to attribute to OpenPalm at all.
 */
export function findSupersededImages(images: DockerImageInfo[]): DockerImageInfo[] {
  const byRepo = new Map<string, DockerImageInfo[]>();
  for (const img of images) {
    if (!img.repository || img.repository === "<none>") continue;
    const list = byRepo.get(img.repository) ?? [];
    list.push(img);
    byRepo.set(img.repository, list);
  }
  const superseded: DockerImageInfo[] = [];
  for (const list of byRepo.values()) {
    if (list.length < 2) continue;
    // docker's CreatedAt ("2024-05-01 12:00:00 +0000 UTC") is zero-padded and
    // year-first, so lexicographic order matches chronological order.
    const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    superseded.push(...sorted.slice(1));
  }
  return superseded;
}

/**
 * Top-level named volumes declared by OpenPalm's shipped compose files
 * (`system/stack/core.compose.yml`). Docker Compose names a project volume
 * `<projectName>_<volumeName>`; a bare (unscoped) name is also matched for
 * the `external: true` / no-project case.
 */
export const OPENPALM_VOLUME_SUFFIXES = ["assistant-persistent", "assistant-artifacts"] as const;

export interface VolumeOwnership {
  matches: boolean;
  suffix?: string;
  /** The compose project name this volume is scoped to, if any (absent for a bare/unscoped match). */
  projectPrefix?: string;
}

export function classifyOpenPalmVolume(name: string): VolumeOwnership {
  for (const suffix of OPENPALM_VOLUME_SUFFIXES) {
    if (name === suffix) return { matches: true, suffix };
    const marker = `_${suffix}`;
    if (name.endsWith(marker) && name.length > marker.length) {
      return { matches: true, suffix, projectPrefix: name.slice(0, name.length - marker.length) };
    }
  }
  return { matches: false };
}

/**
 * OpenPalm-owned, project-scoped volumes whose project prefix is NOT the
 * current compose project — i.e. survivors of a project rename (#540) that
 * tore down containers without `-v` (S7). A volume with no project prefix
 * (bare/unscoped match) is never flagged: there is nothing to compare it to.
 */
export function findOrphanVolumes(volumes: DockerVolumeInfo[], currentProjectName: string): DockerVolumeInfo[] {
  return volumes.filter((v) => {
    const info = classifyOpenPalmVolume(v.name);
    return info.matches && info.projectPrefix !== undefined && info.projectPrefix !== currentProjectName;
  });
}

export interface ReportImagesAndVolumesOptions {
  client?: DockerClient;
  namespace?: string;
  projectName?: string;
}

/** Report dangling/superseded OpenPalm images and orphan project-scoped volumes (S7). Never mutates. */
export async function reportImagesAndVolumes(opts: ReportImagesAndVolumesOptions = {}): Promise<ImageVolumeReport> {
  const client = opts.client ?? realDockerClient;
  const namespace = opts.namespace ?? process.env.OP_IMAGE_NAMESPACE?.trim() ?? "openpalm";
  const projectName = opts.projectName ?? resolveComposeProjectName();

  const [imagesResult, volumesResult] = await Promise.all([
    client.run(["images", "--filter", `reference=${namespace}/*`, "--format", IMAGE_FORMAT]),
    client.run(["volume", "ls", "--format", VOLUME_FORMAT]),
  ]);

  if (!imagesResult.ok || !volumesResult.ok) {
    return {
      reliable: false,
      error: !imagesResult.ok ? imagesResult.stderr || "docker images failed" : volumesResult.stderr || "docker volume ls failed",
      images: [],
      supersededImages: [],
      volumes: [],
      orphanVolumes: [],
    };
  }

  const images = parseDockerImagesOutput(imagesResult.stdout);
  const volumes = parseDockerVolumeLsOutput(volumesResult.stdout);
  return {
    reliable: true,
    images,
    supersededImages: findSupersededImages(images),
    volumes,
    orphanVolumes: findOrphanVolumes(volumes, projectName),
  };
}

export interface CleanupImagesAndVolumesResult {
  removedImages: string[];
  removedVolumes: string[];
  errors: string[];
}

export interface CleanupImagesAndVolumesOptions {
  /** Required — refuses to remove anything unless explicitly true (confirm-gated, S7). */
  confirm: boolean;
  client?: DockerClient;
}

/**
 * Remove ONLY the artifacts {@link reportImagesAndVolumes} already verified
 * as OpenPalm-owned superseded images / orphan project-scoped volumes.
 * Requires `confirm: true` — this never re-derives what to remove, so a
 * caller must have shown the report to the operator (or an explicit
 * `--yes`) before calling it.
 */
export async function cleanupImagesAndVolumes(
  report: ImageVolumeReport,
  opts: CleanupImagesAndVolumesOptions,
): Promise<CleanupImagesAndVolumesResult> {
  if (!opts.confirm) {
    throw new Error("cleanupImagesAndVolumes refuses to run without confirm: true.");
  }
  const client = opts.client ?? realDockerClient;
  const removedImages: string[] = [];
  const removedVolumes: string[] = [];
  const errors: string[] = [];

  for (const img of report.supersededImages) {
    const res = await client.run(["rmi", img.id]);
    if (res.ok) removedImages.push(img.id);
    else errors.push(`image ${img.repository}:${img.tag} (${img.id}): ${res.stderr || "removal failed"}`);
  }
  for (const vol of report.orphanVolumes) {
    const res = await client.run(["volume", "rm", vol.name]);
    if (res.ok) removedVolumes.push(vol.name);
    else errors.push(`volume ${vol.name}: ${res.stderr || "removal failed"}`);
  }

  return { removedImages, removedVolumes, errors };
}
