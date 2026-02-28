const DEFAULT_SNIPPET_SOURCES = [
  {
    id: "openpalm-community",
    name: "OpenPalm Community",
    type: "index-url",
    target: "https://raw.githubusercontent.com/itlackey/openpalm/main/community/index.json",
    trust: "curated",
    enabled: true
  },
  {
    id: "github-channels",
    name: "GitHub Community Channels",
    type: "github-topic",
    target: "openpalm-channel",
    trust: "community",
    enabled: true
  },
  {
    id: "github-services",
    name: "GitHub Community Services",
    type: "github-topic",
    target: "openpalm-service",
    trust: "community",
    enabled: true
  },
  {
    id: "github-automations",
    name: "GitHub Community Automations",
    type: "github-topic",
    target: "openpalm-automation",
    trust: "community",
    enabled: true
  },
  {
    id: "github-openpalm",
    name: "GitHub OpenPalm Repos",
    type: "github-topic",
    target: "openpalm",
    trust: "community",
    enabled: true
  }
];
function inferInputType(envName) {
  const upper = envName.toUpperCase();
  if (upper.includes("SECRET") || upper.includes("TOKEN") || upper.includes("KEY") || upper.includes("PASSWORD")) {
    return "password";
  }
  return "text";
}
export {
  DEFAULT_SNIPPET_SOURCES as D,
  inferInputType as i
};
