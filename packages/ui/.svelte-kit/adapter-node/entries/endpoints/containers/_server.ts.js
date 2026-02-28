import { u as unauthorizedJson, j as json } from "../../../chunks/json.js";
import { k as knownServices } from "../../../chunks/init.js";
import { composeList, composePull } from "../../../chunks/compose-runner.js";
function hasNewerImage(pullOutput) {
  if (pullOutput.includes("Downloaded newer image")) return true;
  if (pullOutput.includes("Image is up to date")) return false;
  return false;
}
const GET = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const services = Array.from(await knownServices()).sort();
  const psResult = await composeList();
  const runningByService = /* @__PURE__ */ new Map();
  if (psResult.ok) {
    try {
      const rows = JSON.parse(psResult.stdout);
      for (const row of rows) {
        const service = String(row.Service ?? row.Name ?? "");
        if (!service) continue;
        runningByService.set(service, {
          status: String(row.State ?? row.Status ?? "unknown"),
          image: String(row.Image ?? "unknown")
        });
      }
    } catch {
    }
  }
  const details = [];
  for (const service of services) {
    const pullResult = await composePull(service);
    const pullOutput = `${pullResult.stdout}
${pullResult.stderr}`;
    details.push({
      name: service,
      status: runningByService.get(service)?.status ?? "not_running",
      image: runningByService.get(service)?.image ?? "unknown",
      updateAvailable: pullResult.ok && hasNewerImage(pullOutput)
    });
  }
  return json(200, { services: details });
};
export {
  GET
};
