#!/usr/bin/env node
/**
 * Level-1 config merge for the marketplace/extensions installer loop.
 * Sibling of regenerate-extensions-install.js (same M3 front 3 / OD1 lineage)
 * — runs in the init container AFTER that regen and BEFORE the npm installer
 * (@red-hat-developer-hub/cli-module-install-dynamic-plugins@0.4.0).
 *
 * Rationale: the marketplace write-through file (extensions-install.yaml)
 * used to be wired as an `includes:` entry — level 0, same level as the
 * catalog-index DPDY and the baked product face. Two level-0 sources that
 * both declare the same plugin key collide FATALLY in the installer
 * regardless of `disabled` state (install-dynamic-plugins.py:333-334; key =
 * registry:!path for OCI, package name for npm — the version is never part
 * of the key). The catalog-index DPDY is itself a level-0 include, so any
 * marketplace-installed override of a DPDY-provided plugin was one operator
 * click away from bricking the boot.
 *
 * The fix: this script materialises the level-1 config — the main
 * `plugins:` list of the fixed file the installer reads from its CWD
 * (/opt/app-root/src/dynamic-plugins.yaml; the installer hardcodes this
 * filename, see veecode/dynamic-plugins.yaml's own header comment) — as
 * operator.plugins ++ extensions.plugins, with the operator entry winning on
 * any key collision. A level-1 entry is documented upstream as a *user
 * install*: enable/version overrides of a lower-level (level-0) DPDY entry
 * are legal there, which is exactly the marketplace's use case (a user
 * enabling or re-versioning a catalog-index-provided plugin). This script is
 * therefore what turns "same plugin, two levels" into the sanctioned
 * override path instead of the fatal same-level collision.
 *
 * Two inputs:
 *   - DEVPORTAL_OPERATOR_CONFIG (env, no default): path to the operator's
 *     dynamic-plugins.yaml — the deploy's source of truth (chart-rendered
 *     ConfigMap, or an operator-mounted file). Missing, unreadable, or not
 *     valid YAML is FATAL (exit 1) — this file is what the operator asked
 *     for, so silently degrading it would boot a config nobody chose.
 *   - `${DEVPORTAL_DB_PATH}/extensions-install.yaml` (same derivation
 *     regenerate-extensions-install.js uses: DEVPORTAL_DB_PATH, else
 *     `<cwd>/data`) — the marketplace write-through, produced by that
 *     script. Missing, empty, or `plugins: []` is a normal state (fresh
 *     tenant / no marketplace installs yet) and is NOT fatal: proceed with
 *     the operator config alone.
 *
 * Output: /opt/app-root/src/dynamic-plugins.yaml (hardcoded — the installer
 * reads this exact path from its CWD, same fixed-filename contract as the
 * baked default it replaces). The operator document is written back
 * VERBATIM (its `includes:` and every other top-level key are preserved)
 * except `plugins:`, which becomes operator.plugins followed by every
 * extensions.plugins entry whose normalized key is NOT already present in
 * operator.plugins. A dropped entry logs a loud warning naming the key —
 * "operator config wins for <key>" — so a silently-ignored marketplace
 * install is always visible in the boot logs.
 *
 * Key normalization mirrors the installer's parse_plugin_key exactly the
 * way regenerate-extensions-install.js's normalizePluginKey already does
 * (npm packages compare by name — the trailing `@<version>` is stripped;
 * OCI packages compare by `registry` + `!<path>`, with both the tag and the
 * digest stripped; local `./` paths compare as-is). That function is
 * require()'d from the sibling script below rather than re-implemented,
 * since the two must never drift out of sync with each other.
 */

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { normalizePluginKey } = require('./regenerate-extensions-install.js');

const OUT_FILE = '/opt/app-root/src/dynamic-plugins.yaml';

const log = msg => process.stdout.write(`VEECODE merge: ${msg}\n`);
const warn = msg => process.stderr.write(`VEECODE merge: WARNING — ${msg}\n`);

// Fatal: the operator config is the deploy's source of truth. A missing,
// unreadable, or invalid file must stop the boot loudly rather than let the
// installer run against whatever was baked into the image.
function fatal(msg) {
  process.stderr.write(`VEECODE merge: FATAL — ${msg}\n`);
  process.exit(1);
}

function loadOperatorConfig() {
  const configPath = process.env.DEVPORTAL_OPERATOR_CONFIG;
  if (!configPath) {
    fatal('DEVPORTAL_OPERATOR_CONFIG is not set; refusing to guess the operator config path');
  }
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    fatal(`could not read DEVPORTAL_OPERATOR_CONFIG (${configPath}): ${e.message}`);
  }
  let parsed;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    fatal(`DEVPORTAL_OPERATOR_CONFIG (${configPath}) is not valid YAML: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fatal(`DEVPORTAL_OPERATOR_CONFIG (${configPath}) does not contain a YAML mapping`);
  }
  if (parsed.plugins !== undefined && !Array.isArray(parsed.plugins)) {
    fatal(`DEVPORTAL_OPERATOR_CONFIG (${configPath}): "plugins" is present but not a list`);
  }
  return { path: configPath, doc: parsed };
}

// Non-fatal by design: this is the marketplace write-through, produced by
// regenerate-extensions-install.js. A fresh tenant with no marketplace
// installs yet is a normal boot, not a degraded one.
function loadExtensionsPlugins() {
  const dbPath = process.env.DEVPORTAL_DB_PATH || path.join(process.cwd(), 'data');
  const extensionsFile = path.join(dbPath, 'extensions-install.yaml');

  let raw;
  try {
    raw = fs.readFileSync(extensionsFile, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      log(`${extensionsFile} does not exist yet; proceeding with the operator config alone`);
    } else {
      warn(`could not read ${extensionsFile} (${e.message}); proceeding with the operator config alone`);
    }
    return [];
  }
  if (!raw.trim()) {
    log(`${extensionsFile} is empty; proceeding with the operator config alone`);
    return [];
  }

  let parsed;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    warn(`${extensionsFile} is not valid YAML (${e.message}); proceeding with the operator config alone`);
    return [];
  }
  const plugins = parsed && Array.isArray(parsed.plugins) ? parsed.plugins : [];
  if (plugins.length === 0) {
    log(`${extensionsFile} has no plugin selections; proceeding with the operator config alone`);
  }
  return plugins;
}

function main() {
  const operator = loadOperatorConfig();
  const operatorPlugins = Array.isArray(operator.doc.plugins) ? operator.doc.plugins : [];
  const extensionsPlugins = loadExtensionsPlugins();

  const operatorKeys = new Set();
  for (const p of operatorPlugins) {
    if (p && typeof p.package === 'string') operatorKeys.add(normalizePluginKey(p.package));
  }

  const mergedExtras = [];
  for (const p of extensionsPlugins) {
    if (!p || typeof p.package !== 'string') {
      warn('extensions entry has no usable "package" key; skipping it');
      continue;
    }
    const key = normalizePluginKey(p.package);
    if (operatorKeys.has(key)) {
      warn(`operator config wins for ${key}`);
      continue;
    }
    mergedExtras.push(p);
  }

  const mergedDoc = { ...operator.doc, plugins: [...operatorPlugins, ...mergedExtras] };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, YAML.stringify(mergedDoc));
  log(
    `wrote ${OUT_FILE}: ${operatorPlugins.length} operator plugin(s) + ${mergedExtras.length} marketplace plugin(s)` +
      (mergedExtras.length !== extensionsPlugins.length
        ? ` (${extensionsPlugins.length - mergedExtras.length} dropped as operator-owned)`
        : ''),
  );
}

if (require.main === module) {
  main();
}

// Exported for unit tests (require()'ing this file must not run main()).
module.exports = { loadOperatorConfig, loadExtensionsPlugins };
