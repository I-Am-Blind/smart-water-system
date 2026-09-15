// Metro config: lets the app import the shared protocol types (../packages/protocol)
// and ../branding.json from the repo root, while ignoring the other packages.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");
const config = getDefaultConfig(projectRoot);

config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

// Do not crawl sibling packages (web/node_modules, .next, firmware, ...).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
config.resolver.blockList = [
  new RegExp(`^${esc(repoRoot)}/(web|firmware|docs|scripts|\\.git)/.*`),
];

module.exports = config;
