const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 }
];
function validateCronField(field, min, max, label) {
  for (const segment of field.split(",")) {
    const [range, step] = segment.split("/");
    if (step !== void 0) {
      if (!/^\d+$/.test(step) || Number(step) < 1 || Number(step) > max - min + 1) {
        return `invalid step value in ${label} field: "${field}"`;
      }
    }
    if (range === "*") continue;
    const dashIdx = range.indexOf("-");
    if (dashIdx !== -1) {
      const lo = range.slice(0, dashIdx);
      const hi = range.slice(dashIdx + 1);
      if (!/^\d+$/.test(lo) || !/^\d+$/.test(hi)) {
        return `invalid range in ${label} field: "${field}"`;
      }
      const loNum = Number(lo);
      const hiNum = Number(hi);
      if (loNum < min || hiNum > max || loNum > hiNum) {
        return `range out of bounds [${min}-${max}] in ${label} field: "${field}"`;
      }
    } else {
      if (!/^\d+$/.test(range)) return `invalid value in ${label} field: "${field}"`;
      const val = Number(range);
      if (val < min || val > max) {
        return `value ${val} out of range [${min}-${max}] in ${label} field`;
      }
    }
  }
  return null;
}
function validateCron(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "cron expression must have exactly 5 fields";
  for (let i = 0; i < 5; i++) {
    const { name, min, max } = CRON_FIELDS[i];
    const error = validateCronField(parts[i], min, max, name);
    if (error) return error;
  }
  return null;
}
export {
  validateCron as v
};
