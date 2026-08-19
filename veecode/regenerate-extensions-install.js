#!/usr/bin/env node
/**
 * Stateless Postgres -> YAML pre-step for the marketplace/extensions
 * installer loop. Ported from devportal-platform's ADR-014
 * (`docker/regenerate-extensions-install.js`) — M3 front 3, decision Q7.
 *
 * The marketplace backend (pluginId "extensions") persists the operator's
 * plugin selections to Postgres (table `marketplace_installations`) and
 * mirrors them to a write-through `extensions-install.yaml`. On a stateless
 * pod that file is empty at boot (or absent), so it must be rebuilt from the
 * DB before the standalone installer reads it — the installer runs before
 * any Node backend, so it cannot read the DB itself.
 *
 * Fork placement (Q7): this file is staged in the image (COPY only) but is
 * NEVER executed by the image itself — there is no ENTRYPOINT/CMD reference
 * to it anywhere in this repo. Orchestration outside this repo (the harness
 * or a future chart) chains it ahead of the installer at the install-step:
 *
 *   node regenerate-extensions-install.js --config <...> && \
 *     sh install-dynamic-plugins.sh <dynamic-plugins-root>
 *
 * Drift from the 2.x original (kept byte-close otherwise; see
 * devportal-planning docs/milestones/M3.md, Front 3):
 *   - Paths: 2.x's entrypoint guarantees /app and /app/data exist before
 *     this script runs. This fork has no such entrypoint, so both are
 *     replaced with CWD-relative equivalents: `rootDir` for
 *     ConfigSources.defaultForTargets is `process.cwd()` (was '/app'), and
 *     the output directory defaults to `${DEVPORTAL_DB_PATH:-./data}`
 *     (was '/app/data'), resolved against `process.cwd()`. Nothing in this
 *     repo or its Containerfile creates that directory, so `main()` now
 *     `mkdirSync`s it (recursive, best-effort) right before the write —
 *     a permission failure there still degrades through the existing soft
 *     warn path instead of throwing. Whoever wires the install-step harness
 *     must set DEVPORTAL_DB_PATH to a real writable/shared location; the
 *     `./data` fallback only makes local/manual invocation not crash.
 *   - Fail-closed removed (D2: this fork does not fail-closed on boot).
 *     2.x's EXTENSIONS_PRESTEP_FAIL_CLOSED opt-in (NFS entrypoint only) and
 *     its exit-78 abort path are dropped entirely. `bail()` is kept as a
 *     named wrapper — for diff-readability against the 2.x source — but it
 *     is now unconditionally soft: warn and return, never exit non-zero.
 *     Every condition that used to be able to abort the boot now always
 *     takes the "leave the existing YAML in place" path.
 *   - Digest-pinning (skopeo) kept unchanged: the fork's runner image
 *     installs skopeo (see build/containerfiles/Containerfile, runner
 *     stage), so this sub-feature ports as-is with no substitution.
 *
 * Config is read with the same --config files the backend gets (passed as
 * args), via @backstage/config-loader, so ${VAR:-default} and the
 * SaaS/preset database config resolve exactly as the backend sees them.
 * `pg`, `yaml` and `@backstage/config-loader` are not declared as direct
 * dependencies anywhere in this repo, but are all present at runtime as
 * transitive production dependencies of packages/backend (via
 * `@backstage/backend-defaults`, which depends on both `pg` and
 * `@backstage/config-loader`, which in turn depends on `yaml`) — confirmed
 * against yarn.lock; this repo uses `nodeLinker: node-modules` and stages
 * production node_modules via `yarn workspaces focus --all --production`
 * (Containerfile cleanup stage), so they land hoisted at the WORKDIR root
 * where this file is COPY'd. No new dependency was added to the image.
 *
 * Schema contract (pinned, see ADR-014): table `marketplace_installations`,
 * columns `package_name`, `disabled`, `config_yaml`.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const YAML = require('yaml');
const { ConfigSources } = require('@backstage/config-loader');
const { Client } = require('pg');

const PLUGIN_ID = 'extensions';
const DEFAULT_PREFIX = 'backstage_plugin_';
const TABLE = 'marketplace_installations';

// OD1 phase A: the baked VeeCode product-face file, wired into the chart's
// global.dynamic.includes ahead of this script's output file. Both land at
// includes level 0, so a package this regen re-emits that the face already
// declares is a FATAL same-level collision for the installer
// (install-dynamic-plugins.py:333-334) — see loadFacePackageKeys().
const DEFAULT_FACE_FILE = '/opt/app-root/src/dynamic-plugins.veecode.yaml';

// Bounded timeouts so an unreachable/slow DB DEGRADES (empty/unchanged file)
// instead of hanging the boot. Without connectionTimeoutMillis, pg.connect()
// waits on the OS TCP timeout — the "DB unreachable → degrade" fail-safe relies
// on this bound.
const CONNECT_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 10000;

// Same reasoning as the pg timeouts: a registry that does not answer must not
// hang the boot. Resolution happens once per package, and only for rows whose
// digest is still unknown, so this bound is paid at most once per plugin.
const SKOPEO_TIMEOUT_MS = 20000;

const log = msg => process.stdout.write(`VEECODE prestep: ${msg}\n`);
const warn = msg => process.stderr.write(`VEECODE prestep: WARNING — ${msg}\n`);

// SQLSTATE invalid_catalog_name — "database <x> does not exist".
//
// With pluginDivisionMode: database (the default) each plugin owns its own
// database, and the marketplace backend creates `${prefix}extensions` the first
// time it runs. Until then the pre-step's connection fails with this code. That
// is the SAME legitimate state as "table not found": a tenant that has not
// migrated yet, NOT an unreachable Postgres. Measured on the bench — a naive
// fail-closed rejects it and breaks every first boot.
//
// Everything else (connection refused, timeout, auth failure, permission denied)
// stays hard: those mean Postgres is declared the source of truth and cannot be
// consulted.
const PG_DATABASE_MISSING = '3D000';

/**
 * Soft-warn wrapper for every condition where the plugin set could not be
 * reconstructed from Postgres (unreachable database, unusable connection
 * config, failed write). Kept as a named function — rather than inlining
 * `warn()` at each call site — purely so this file's diff against the 2.x
 * original stays readable; there is no fail-closed variant on this fork
 * (D2), so it always warns and returns, leaving the existing YAML in place.
 */
function bail(msg) {
  warn(msg);
}

// Parse repeated `--config <path>` args (the same shape the entrypoint passes).
function parseConfigTargets(argv) {
  const targets = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      targets.push({ type: 'path', target: argv[i + 1] });
      i++;
    }
  }
  return targets;
}

async function loadConfig(targets) {
  const source = ConfigSources.defaultForTargets({
    targets,
    rootDir: process.cwd(),
    watch: false,
    allowMissingDefaultConfig: true,
  });
  return ConfigSources.toConfig(source);
}

// Build a pg client config from backend.database.connection (string or object),
// optionally overriding the database name (pluginDivisionMode: database).
function pgClientConfig(connection, overrideDb) {
  const timeouts = {
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  };
  if (typeof connection === 'string') {
    if (!overrideDb) return { connectionString: connection, ...timeouts };
    const u = new URL(connection);
    u.pathname = `/${overrideDb}`;
    return { connectionString: u.toString(), ...timeouts };
  }
  const c = {
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: overrideDb || connection.database,
    ...timeouts,
  };
  if (connection.ssl !== undefined) c.ssl = connection.ssl; // object-form ssl passthrough (string connections carry ssl in the URL)
  return c;
}

// Discover the schema owning `marketplace_installations` and read it — on a
// SINGLE connection (one TCP+TLS+auth handshake at boot). Prefers a schema whose
// name mentions "extensions" when several match. Returns {schema, rows}; schema
// is undefined when the table exists nowhere reachable (fresh tenant).
//
// T1.3: the read now also picks up `requested_ref` and `resolved_digest` WHEN THE
// COLUMNS EXIST. They are discovered rather than assumed, because a database that
// predates the migration must still be readable — selecting a missing column is a
// hard SQL error, which would turn a rollback-era database into a refused boot.
async function loadInstallations(clientConfig) {
  const client = new Client(clientConfig);
  await client.connect();
  try {
    const schemaRes = await client.query(
      `SELECT table_schema FROM information_schema.tables
        WHERE table_name = $1
        ORDER BY (table_schema LIKE '%extensions%') DESC, table_schema
        LIMIT 1`,
      [TABLE],
    );
    const schema = schemaRes.rows[0]
      ? schemaRes.rows[0].table_schema
      : undefined;
    if (!schema) return { schema: undefined, rows: [], columns: new Set() };

    const colRes = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2`,
      [schema, TABLE],
    );
    const columns = new Set(colRes.rows.map(r => r.column_name));

    const selected = ['config_yaml', 'package_name', 'disabled'];
    for (const optional of ['requested_ref', 'resolved_digest']) {
      if (columns.has(optional)) selected.push(optional);
    }
    const dataRes = await client.query(
      `SELECT ${selected
        .map(c => `"${c}"`)
        .join(', ')} FROM "${schema}"."${TABLE}" ORDER BY package_name`,
    );
    return { schema, rows: dataRes.rows, columns };
  } finally {
    await client.end();
  }
}

// Split an OCI plugin ref into its image part and its `!selector` suffix.
// Mirrors install-dynamic-plugins.py, which does `package.split('!')` and then
// `image.replace('oci://','docker://')`. Returns null for anything that is not an
// OCI ref — local `./dir` paths and bare npm names have no digest to resolve.
function splitOciRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('oci://')) return null;
  const bang = ref.indexOf('!');
  if (bang === -1) return null;
  return { image: ref.slice(0, bang), selector: ref.slice(bang + 1) };
}

// Rewrite an OCI ref so the image is addressed by digest instead of by tag.
// The installer's digest() does `skopeo inspect` on exactly this string and
// compares the result against dynamic-plugin-image.hash, so pinning the digest
// here is what makes a restart reuse the same bytes instead of re-resolving a tag
// that may have moved.
function refWithDigest(ref, digest) {
  const parts = splitOciRef(ref);
  if (!parts) return ref;
  const repo = parts.image.replace(/^oci:\/\//, '').split('@')[0].split(':')[0];
  return `oci://${repo}@${digest}!${parts.selector}`;
}

// Resolve an OCI ref to its manifest digest, once, via the skopeo already present
// in the image (/usr/bin/skopeo). Returns `sha256:...` (canonical OCI form, with
// the prefix) or null when the reference cannot be resolved.
//
// Bounded on purpose: an unreachable registry must not hang the boot, the same
// reasoning behind the pg timeouts above.
function resolveDigest(ref) {
  const parts = splitOciRef(ref);
  if (!parts) return null;
  const imageUrl = parts.image.replace(/^oci:\/\//, 'docker://');
  try {
    const out = execFileSync('skopeo', ['inspect', imageUrl], {
      encoding: 'utf8',
      timeout: SKOPEO_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const digest = JSON.parse(out).Digest;
    return typeof digest === 'string' && digest.includes(':') ? digest : null;
  } catch (e) {
    warn(`skopeo could not resolve ${imageUrl}: ${(e && e.message) || e}`);
    return null;
  }
}

// Persist a digest we just resolved, so no later boot resolves the tag again.
// Best-effort by design: if the write fails the YAML for THIS boot is still
// correct (it was built from the digest in memory), and the next boot simply
// resolves once more. A failed write must not refuse a boot that is otherwise
// fully determined.
async function persistDigest(clientConfig, schema, packageName, digest) {
  const client = new Client(clientConfig);
  try {
    await client.connect();
    await client.query(
      `UPDATE "${schema}"."${TABLE}" SET resolved_digest = $1 WHERE package_name = $2`,
      [digest, packageName],
    );
    log(`persisted resolved_digest for "${packageName}"`);
  } catch (e) {
    warn(
      `could not persist resolved_digest for "${packageName}" (${e.message}); this boot still uses the resolved digest`,
    );
  } finally {
    try {
      await client.end();
    } catch {
      /* already closed */
    }
  }
}

// Mirror the marketplace backend's syncToYamlFile: use the stored plugin entry
// (config_yaml) when present, otherwise synthesize {package, disabled}.
//
// T1.3: `effectiveRefs` maps package_name -> the ref to actually write, which for
// OCI rows is the digest-pinned form. It overrides BOTH the synthesized entry and
// a `package` already present inside config_yaml — otherwise a stored entry would
// keep reintroducing the tag we just pinned away. Defaults to empty so the pure
// transform stays callable from the unit tests with one argument.
function rowsToPlugins(rows, effectiveRefs = new Map()) {
  const plugins = [];
  for (const row of rows) {
    const effective = effectiveRefs.get(row.package_name);
    const raw = row.config_yaml != null ? String(row.config_yaml).trim() : '';
    if (raw) {
      // A single corrupt config_yaml must NOT drop every selection — parse
      // per-row and fall through to the synthesized entry on bad YAML.
      let parsed;
      try {
        parsed = YAML.parse(raw);
      } catch (e) {
        warn(
          `config_yaml for "${row.package_name}" is not valid YAML (${e.message}); using {package, disabled} instead`,
        );
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (parsed.disabled === undefined && row.disabled != null) {
          parsed.disabled = !!row.disabled;
        }
        if (effective) parsed.package = effective; // digest-pinned form wins
        if (!parsed.package) parsed.package = row.package_name; // backfill from the PK
        if (!parsed.package) {
          warn(
            `row has no package_name and config_yaml has no package; skipping`,
          );
          continue;
        }
        plugins.push(parsed);
        continue;
      }
    }
    if (!row.package_name) {
      warn(`row has empty package_name and no usable config_yaml; skipping`);
      continue;
    }
    plugins.push({
      package: effective || row.package_name,
      disabled: !!row.disabled,
    });
  }
  return plugins;
}

// Normalizes a package ref to a collision key comparable across sources that pin
// versions differently — the face file carries a tag or digest, this script always
// digest-pins (refWithDigest above), so raw-string comparison would never match a
// face entry against its regenerated counterpart. Mirrors the installer's
// parse_plugin_key version-stripping (install-dynamic-plugins.py:503-565 for OCI,
// :409-460 for npm) closely enough for dedup purposes: OCI compares on the
// registry/image path plus the `!<plugin-path>` selector with the tag/digest
// stripped; npm-style refs compare with any trailing `@<version>` stripped; local
// `./` paths compare as-is (there is nothing to strip).
function normalizePluginKey(ref) {
  if (typeof ref !== 'string') return ref;
  if (ref.startsWith('./')) return ref;
  const oci = splitOciRef(ref);
  if (oci) {
    // Strip the digest (after '@') first, then strip the tag only if the last ':'
    // comes after the last '/' — a port in the registry host (host:5000/...) also
    // contains a ':' before the first '/', and must NOT be mistaken for a tag
    // separator (the installer's own EXPECTED_OCI_PATTERN explicitly allows a
    // port in the registry).
    const noDigest = oci.image.replace(/^oci:\/\//, '').split('@')[0];
    const lastColon = noDigest.lastIndexOf(':');
    const lastSlash = noDigest.lastIndexOf('/');
    const registry = lastColon > lastSlash ? noDigest.slice(0, lastColon) : noDigest;
    return `oci://${registry}!${oci.selector}`;
  }
  const at = ref.lastIndexOf('@');
  return at > 0 ? ref.slice(0, at) : ref;
}

// Reads the baked product face file so the regen can exclude any package it already
// declares. Missing/unreadable/unparseable is NOT fatal here — this script must keep
// working in local/dev contexts that never bake a face file. The hard guarantee
// against a same-level-0 collision lives installer-side (the fail-closed include on
// a missing face file, plus its own fatal-duplicate check); this is best-effort
// dedup, not the safety net.
function loadFacePackageKeys() {
  const faceFile = process.env.DEVPORTAL_FACE_FILE || DEFAULT_FACE_FILE;
  let raw;
  try {
    raw = fs.readFileSync(faceFile, 'utf8');
  } catch (e) {
    warn(
      `could not read face file ${faceFile} (${e.message}); marketplace regen dedup disabled for this boot`,
    );
    return null;
  }
  let parsed;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    warn(
      `face file ${faceFile} is not valid YAML (${e.message}); marketplace regen dedup disabled for this boot`,
    );
    return null;
  }
  const facePlugins =
    parsed && Array.isArray(parsed.plugins) ? parsed.plugins : [];
  const keys = new Set();
  for (const p of facePlugins) {
    if (p && typeof p.package === 'string') keys.add(normalizePluginKey(p.package));
  }
  return keys;
}

function writeAtomic(filePath, contents) {
  const tmp = path.join(
    path.dirname(filePath),
    `.extensions-install.${process.pid}.tmp`,
  );
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

async function main() {
  const targets = parseConfigTargets(process.argv.slice(2));
  const dbPath =
    process.env.DEVPORTAL_DB_PATH || path.join(process.cwd(), 'data');
  const outFile = path.join(dbPath, 'extensions-install.yaml');

  let config;
  try {
    config = await loadConfig(targets);
  } catch (e) {
    bail(`could not load app-config (${e.message}); leaving ${outFile} as-is`);
    return;
  }

  // Read everything we need, then release the config (and any file watchers it
  // opened) exactly once before any early return.
  const client = config.getOptionalString('backend.database.client');
  const connection = config.getOptional('backend.database.connection');
  const mode =
    config.getOptionalString('backend.database.pluginDivisionMode') ||
    'database';
  const prefix =
    config.getOptionalString('backend.database.prefix') || DEFAULT_PREFIX;
  if (config.close) config.close();

  if (client !== 'pg') {
    log(
      `backend.database.client=${
        client || 'unset'
      } (not pg) — no-op, ${outFile} unchanged`,
    );
    return;
  }
  if (!connection) {
    bail(
      `backend.database.client=pg but no backend.database.connection found; leaving ${outFile} as-is`,
    );
    return;
  }

  const overrideDb = mode === 'schema' ? undefined : `${prefix}${PLUGIN_ID}`;
  const where =
    mode === 'schema' ? "the connection's database" : `database ${overrideDb}`;

  // pgClientConfig is pure but can throw (e.g. a malformed connection URL) —
  // build it OUTSIDE the DB try so a config error reads as a config error, not
  // a "could not read marketplace_installations" DB error.
  let clientConfig;
  try {
    clientConfig = pgClientConfig(connection, overrideDb);
  } catch (e) {
    bail(
      `invalid backend.database.connection (${e.message}); leaving ${outFile} as-is`,
    );
    return;
  }

  let schema;
  let rows;
  let columns = new Set();
  try {
    ({ schema, rows, columns } = await loadInstallations(clientConfig));
  } catch (e) {
    if (e && e.code === PG_DATABASE_MISSING) {
      // Fresh tenant: the marketplace backend has not created its database yet.
      warn(
        `${where} does not exist yet (${e.message}); fresh tenant, leaving ${outFile} as-is`,
      );
      return;
    }
    bail(`could not read ${TABLE} (${e.message}); leaving ${outFile} as-is`);
    return;
  }
  if (!schema) {
    warn(
      `pluginDivisionMode=${mode} — ${TABLE} not found in ${where} (fresh tenant / plugin not migrated yet); leaving ${outFile} as-is`,
    );
    return;
  }
  log(
    `pluginDivisionMode=${mode} — read "${schema}".${TABLE} in ${where} (${rows.length} row(s))`,
  );

  // ── T1.3: pin every OCI selection to a digest ─────────────────────────────
  //
  // A restart must reinstall the SAME bytes, so the YAML never carries a bare
  // tag. Two shapes arrive here:
  //
  //   * resolved_digest already stored  -> reuse it, no registry call at all.
  //     This is what makes a restart deterministic: the tag is never consulted
  //     again, even if it moved.
  //   * digest still null (a row written before this change, or one the backend
  //     just created) -> resolve ONCE via skopeo, write it back, and use it from
  //     then on. Never materialise the bare tag as a fallback: that is precisely
  //     the re-resolution this task exists to remove.
  //
  // Non-OCI selections (local ./dir, bare npm names) have no digest and pass
  // through untouched.
  //
  // NOTE (fork-specific, not in 2.x): an unresolvable digest still calls
  // bail() and returns below, which now means "warn and abandon regeneration
  // for this boot" rather than "abort the boot" — the existing (possibly
  // stale) extensions-install.yaml is left in place. Flagged for Gio per Q4;
  // not changed here since it predates the fail-closed trim and is not
  // itself a fail-closed instance.
  const effectiveRefs = new Map();
  const hasDigestColumn = columns.has('resolved_digest');
  for (const row of rows) {
    const requested = row.requested_ref || row.package_name;
    if (!splitOciRef(requested)) continue; // not an OCI ref, nothing to pin

    if (hasDigestColumn && row.resolved_digest) {
      effectiveRefs.set(row.package_name, refWithDigest(requested, row.resolved_digest));
      continue;
    }

    const digest = resolveDigest(requested);
    if (!digest) {
      bail(
        `could not resolve a digest for "${requested}"; refusing to materialise a bare tag`,
      );
      return;
    }
    effectiveRefs.set(row.package_name, refWithDigest(requested, digest));
    if (hasDigestColumn) {
      await persistDigest(clientConfig, schema, row.package_name, digest);
    } else {
      warn(
        `resolved_digest column is absent (pre-migration database) — resolved ${digest} for this boot only, it will be resolved again next time`,
      );
    }
  }
  log(
    `digest-pinned ${effectiveRefs.size} of ${rows.length} selection(s) (${
      rows.length - effectiveRefs.size
    } non-OCI)`,
  );

  let plugins = rowsToPlugins(rows, effectiveRefs);

  // OD1 phase A: never re-declare a package the baked face file already owns — see
  // loadFacePackageKeys() / normalizePluginKey() above.
  const facePackageKeys = loadFacePackageKeys();
  if (facePackageKeys) {
    const beforeCount = plugins.length;
    plugins = plugins.filter(p => {
      const isFacePackage =
        p && typeof p.package === 'string' &&
        facePackageKeys.has(normalizePluginKey(p.package));
      if (isFacePackage) {
        log(
          `excluding "${p.package}" from ${outFile}: declared in product face file`,
        );
      }
      return !isFacePackage;
    });
    if (plugins.length !== beforeCount) {
      log(
        `dedup against the product face file removed ${
          beforeCount - plugins.length
        } selection(s)`,
      );
    }
  }

  try {
    // 2.x's entrypoint guarantees DEVPORTAL_DB_PATH exists before this script
    // runs; this fork has no such entrypoint, so create it here. Best-effort
    // and inside this try on purpose: a permission failure still degrades
    // through the same soft warn path as a write failure would.
    fs.mkdirSync(dbPath, { recursive: true });
    writeAtomic(outFile, YAML.stringify({ plugins }));
    log(
      `regenerated ${outFile} with ${plugins.length} plugin selection(s) from the database`,
    );
  } catch (e) {
    bail(
      `could not write ${outFile} (${e.message}); boot continues with the existing file`,
    );
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    e => {
      bail(
        `unexpected error (${
          e && e.message
        }); leaving extensions-install.yaml as-is, boot continues`,
      );
      process.exit(0);
    },
  );
}

// Exported for unit tests (the pure transforms have no I/O).
module.exports = {
  parseConfigTargets,
  pgClientConfig,
  rowsToPlugins,
  normalizePluginKey,
  loadFacePackageKeys,
};
