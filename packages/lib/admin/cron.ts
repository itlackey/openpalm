/**
 * Basic validation for 5-field cron expressions.
 * Returns null if valid, or an error message string.
 */
export function validateCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "cron expression must have exactly 5 fields";
  const fieldPattern = /^[\d*\/\-,]+$/;
  const labels = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  for (let i = 0; i < 5; i++) {
    if (!fieldPattern.test(parts[i])) {
      return `invalid characters in ${labels[i]} field: "${parts[i]}"`;
    }
  }
  return null;
}
