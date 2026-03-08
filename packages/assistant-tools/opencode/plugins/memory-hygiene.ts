import {
  type MemoryIdentity,
  type MemoryItem,
  deleteMemories,
  listMemories,
  normalizeMemoryText,
} from './memory-lib.ts';

const STALE_THRESHOLD_DAYS = 45;
const STALE_LOW_CONFIDENCE = 0.25;
const HARD_STALE_THRESHOLD_DAYS = 120;
const MAX_SCAN_SIZE = 200;
const MAX_DELETE_BATCH = 60;

export type HygieneReport = {
  scanned: number;
  duplicatesFound: number;
  staleFound: number;
  deletedDuplicates: number;
  deletedStale: number;
  skippedProtected: number;
  errors: number;
};

export async function runAutomatedHygiene(
  identity?: MemoryIdentity,
): Promise<HygieneReport> {
  const report: HygieneReport = {
    scanned: 0,
    duplicatesFound: 0,
    staleFound: 0,
    deletedDuplicates: 0,
    deletedStale: 0,
    skippedProtected: 0,
    errors: 0,
  };

  const items = await listMemories({
    ...identity,
    page: 1,
    size: MAX_SCAN_SIZE,
    sort_column: 'created_at',
    sort_direction: 'desc',
    timeoutMs: 3_500,
  });
  report.scanned = items.length;
  if (items.length === 0) return report;

  const duplicatesToDelete = collectDuplicateCandidates(items, report);
  const staleToDelete = collectStaleCandidates(items, duplicatesToDelete, report);

  const duplicateBatch = duplicatesToDelete.slice(0, MAX_DELETE_BATCH);
  if (duplicateBatch.length > 0) {
    const deleted = await deleteMemories(duplicateBatch, identity);
    if (deleted) {
      report.deletedDuplicates = duplicateBatch.length;
    } else {
      report.errors++;
    }
  }

  const staleBatch = staleToDelete
    .filter((id) => !duplicateBatch.includes(id))
    .slice(0, MAX_DELETE_BATCH);
  if (staleBatch.length > 0) {
    const deleted = await deleteMemories(staleBatch, identity);
    if (deleted) {
      report.deletedStale = staleBatch.length;
    } else {
      report.errors++;
    }
  }

  return report;
}

export function buildHygieneContextNote(report: HygieneReport): string | null {
  if (
    report.duplicatesFound === 0 &&
    report.staleFound === 0 &&
    report.deletedDuplicates === 0 &&
    report.deletedStale === 0
  ) {
    return null;
  }

  const notes: string[] = ['## Memory Hygiene'];
  notes.push(`Scanned ${report.scanned} recent memories.`);
  notes.push(
    `Detected ${report.duplicatesFound} duplicates and ${report.staleFound} stale low-signal entries.`,
  );
  notes.push(
    `Auto-curated ${report.deletedDuplicates} duplicates and ${report.deletedStale} stale entries.`,
  );
  if (report.skippedProtected > 0) {
    notes.push(`Skipped ${report.skippedProtected} protected memories (pinned/immutable).`);
  }
  if (report.errors > 0) {
    notes.push('Some hygiene actions failed; memory store remains usable.');
  }
  return notes.join('\n');
}

function collectDuplicateCandidates(items: MemoryItem[], report: HygieneReport): string[] {
  const grouped = new Map<string, MemoryItem[]>();
  for (const item of items) {
    const normalized = normalizeMemoryText(item.content);
    if (!normalized) continue;
    const category = typeof item.metadata?.category === 'string'
      ? item.metadata.category
      : 'unknown';
    const key = `${category}::${normalized}`;
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }

  const toDelete: string[] = [];
  for (const group of grouped.values()) {
    if (group.length < 2) continue;
    report.duplicatesFound += group.length - 1;
    const sorted = [...group].sort(compareMemoryPriority);
    const keep = sorted[0];
    for (const candidate of sorted) {
      if (candidate.id === keep.id) continue;
      if (isProtected(candidate)) {
        report.skippedProtected++;
        continue;
      }
      toDelete.push(candidate.id);
    }
  }
  return uniqueIds(toDelete);
}

function collectStaleCandidates(
  items: MemoryItem[],
  alreadySelected: string[],
  report: HygieneReport,
): string[] {
  const now = Date.now();
  const already = new Set(alreadySelected);
  const toDelete: string[] = [];

  for (const item of items) {
    if (already.has(item.id)) continue;
    if (isProtected(item)) {
      report.skippedProtected++;
      continue;
    }

    const metadata = item.metadata;
    const confidence = typeof metadata?.confidence === 'number' ? metadata.confidence : 0.7;
    const feedbackScore = typeof metadata?.feedback_score === 'number' ? metadata.feedback_score : 0;
    const referenceDate = toTimestamp(metadata?.last_accessed) ?? toTimestamp(item.created_at);
    if (!referenceDate) continue;
    const daysSince = (now - referenceDate) / (1000 * 60 * 60 * 24);

    const shouldDelete =
      (daysSince >= STALE_THRESHOLD_DAYS && confidence <= STALE_LOW_CONFIDENCE && feedbackScore <= 0) ||
      daysSince >= HARD_STALE_THRESHOLD_DAYS;
    if (shouldDelete) {
      report.staleFound++;
      toDelete.push(item.id);
    }
  }

  return uniqueIds(toDelete);
}

function compareMemoryPriority(a: MemoryItem, b: MemoryItem): number {
  const aScore = memoryQualityScore(a);
  const bScore = memoryQualityScore(b);
  if (aScore !== bScore) return bScore - aScore;

  const aTime = toTimestamp(a.created_at) ?? 0;
  const bTime = toTimestamp(b.created_at) ?? 0;
  return bTime - aTime;
}

function memoryQualityScore(item: MemoryItem): number {
  let score = 0;
  const metadata = item.metadata;
  if (metadata?.pinned === true) score += 10;
  if (metadata?.immutable === true) score += 10;
  if (typeof metadata?.confidence === 'number') score += metadata.confidence;
  if (typeof metadata?.feedback_score === 'number') score += metadata.feedback_score;
  return score;
}

function isProtected(item: MemoryItem): boolean {
  return item.metadata?.pinned === true || item.metadata?.immutable === true;
}

function toTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;
  return timestamp;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}
