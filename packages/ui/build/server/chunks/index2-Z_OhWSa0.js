import { a as parseYamlDocument } from './index-CyXiysyI.js';

const coreYaml = '- id: openpalm-health-check\n  name: System Health Check\n  description: Monitors core service availability every 5 minutes\n  schedule: "*/5 * * * *"\n  enabled: true\n  core: true\n  script: |\n    #!/usr/bin/env bash\n    set -euo pipefail\n    curl -fs --max-time 5 http://gateway:8080/health || echo "gateway: unreachable"\n    curl -fs --max-time 5 http://assistant:4096/ || echo "assistant: unreachable"\n\n- id: openpalm-drift-check\n  name: Compose Drift Check\n  description: Detects compose drift every 15 minutes\n  schedule: "*/15 * * * *"\n  enabled: true\n  core: true\n  script: |\n    #!/usr/bin/env bash\n    set -euo pipefail\n    curl -fs --max-time 5 http://admin:8100/stack/drift || echo "drift check failed"\n';
const CORE_AUTOMATIONS = parseYamlDocument(coreYaml);

export { CORE_AUTOMATIONS };
//# sourceMappingURL=index2-Z_OhWSa0.js.map
