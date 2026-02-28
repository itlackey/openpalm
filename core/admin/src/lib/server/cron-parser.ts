// Minimal 5-field cron expression parser.
//
// Fields: minute (0-59), hour (0-23), day-of-month (1-31), month (1-12), day-of-week (0-7)
// Supports: wildcards, specific values, ranges (1-5), steps, lists (1,3,5)
//
// No external dependencies.

export type CronFields = {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
};

/** Allowed ranges for each cron field */
const FIELD_RANGES: [number, number][] = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 7],   // day of week (0 and 7 both = Sunday)
];

const FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"];

// Parse a single cron field into a set of matching values.
// Supports: wildcards, N, N-M, N/step, N-M/step, wildcard/step, comma-separated lists.
function parseField(field: string, min: number, max: number, fieldName: string): Set<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`Empty value in ${fieldName} field`);

    // Handle step notation: */N or N-M/N or N/N
    const slashIdx = trimmed.indexOf("/");
    let range: string;
    let step = 1;

    if (slashIdx !== -1) {
      range = trimmed.slice(0, slashIdx);
      const stepStr = trimmed.slice(slashIdx + 1);
      step = parseInt(stepStr, 10);
      if (isNaN(step) || step < 1) {
        throw new Error(`Invalid step "${stepStr}" in ${fieldName} field`);
      }
    } else {
      range = trimmed;
    }

    let rangeMin: number;
    let rangeMax: number;

    if (range === "*") {
      rangeMin = min;
      rangeMax = max;
    } else if (range.includes("-")) {
      const [lo, hi] = range.split("-");
      rangeMin = parseInt(lo, 10);
      rangeMax = parseInt(hi, 10);
      if (isNaN(rangeMin) || isNaN(rangeMax)) {
        throw new Error(`Invalid range "${range}" in ${fieldName} field`);
      }
      if (rangeMin < min || rangeMax > max || rangeMin > rangeMax) {
        throw new Error(`Range ${rangeMin}-${rangeMax} out of bounds (${min}-${max}) in ${fieldName} field`);
      }
    } else {
      const val = parseInt(range, 10);
      if (isNaN(val) || val < min || val > max) {
        throw new Error(`Value "${range}" out of bounds (${min}-${max}) in ${fieldName} field`);
      }
      if (slashIdx !== -1) {
        rangeMin = val;
        rangeMax = max;
      } else {
        values.add(val);
        continue;
      }
    }

    for (let i = rangeMin; i <= rangeMax; i += step) {
      values.add(i);
    }
  }

  return values;
}

/** Normalize day-of-week: treat 7 as 0 (both mean Sunday) */
function normalizeDow(dow: Set<number>): Set<number> {
  if (dow.has(7)) {
    dow.add(0);
    dow.delete(7);
  }
  return dow;
}

/** Parse a 5-field cron expression. Throws on invalid input. */
export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Expected 5 fields, got ${parts.length}: "${expression}"`);
  }

  return {
    minutes: parseField(parts[0], FIELD_RANGES[0][0], FIELD_RANGES[0][1], FIELD_NAMES[0]),
    hours: parseField(parts[1], FIELD_RANGES[1][0], FIELD_RANGES[1][1], FIELD_NAMES[1]),
    daysOfMonth: parseField(parts[2], FIELD_RANGES[2][0], FIELD_RANGES[2][1], FIELD_NAMES[2]),
    months: parseField(parts[3], FIELD_RANGES[3][0], FIELD_RANGES[3][1], FIELD_NAMES[3]),
    daysOfWeek: normalizeDow(parseField(parts[4], FIELD_RANGES[4][0], FIELD_RANGES[4][1], FIELD_NAMES[4])),
  };
}

/** Check if a Date matches a parsed cron expression. */
export function cronMatches(fields: CronFields, date: Date): boolean {
  return (
    fields.minutes.has(date.getMinutes()) &&
    fields.hours.has(date.getHours()) &&
    fields.daysOfMonth.has(date.getDate()) &&
    fields.months.has(date.getMonth() + 1) &&
    fields.daysOfWeek.has(date.getDay())
  );
}

/** Validate a cron expression string. Returns null if valid, error message otherwise. */
export function validateCronExpression(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Get the next matching Date after `after`. Returns null if none found within 2 years.
 * Iterates minute-by-minute from the given date.
 */
export function nextCronMatch(fields: CronFields, after: Date): Date | null {
  const limit = new Date(after);
  limit.setFullYear(limit.getFullYear() + 2);

  const candidate = new Date(after);
  // Start from the next minute
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  while (candidate <= limit) {
    if (cronMatches(fields, candidate)) {
      return candidate;
    }

    // Skip ahead efficiently: if month doesn't match, jump to next month
    if (!fields.months.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // If day doesn't match (either dom or dow), jump to next day
    if (!fields.daysOfMonth.has(candidate.getDate()) || !fields.daysOfWeek.has(candidate.getDay())) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // If hour doesn't match, jump to next hour
    if (!fields.hours.has(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    // Otherwise advance by one minute
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}
