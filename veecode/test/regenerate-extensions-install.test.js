// Needs a Postgres reachable through the PG* variables, and pg, yaml and
// @backstage/config-loader installed; veecode-prestep-test.yaml provides both.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { Client } = require('pg');

const SCRIPT = path.join(__dirname, '..', 'regenerate-extensions-install.js');
const { normalizePluginKey, samePlugin } = require(SCRIPT);

const PG = {
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
};

const FAKE_SKOPEO = String.raw`#!/bin/sh
echo "$*" >> "$FAKE_SKOPEO_LOG"
digest=$(awk -v ref="$2" '$1 == ref { print $2 }' "$FAKE_SKOPEO_DIGESTS")
if [ -z "$digest" ]; then
  echo "manifest unknown: $2" >&2
  exit 1
fi
printf '{"Digest":"%s"}\n' "$digest"
`;

const digest = n => `sha256:${String(n).repeat(64)}`;

function installation(ref, { disabled = false, ...columns } = {}) {
  return {
    package_name: ref,
    disabled,
    config_yaml: YAML.stringify({ package: ref, disabled }),
    ...columns,
  };
}

async function withClient(database, fn) {
  const client = new Client({ ...PG, database });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function seed(database, { digestColumns, rows }) {
  await withClient('postgres', async client => {
    await client.query(`DROP DATABASE IF EXISTS "${database}"`);
    await client.query(`CREATE DATABASE "${database}"`);
  });
  await withClient(database, async client => {
    // The marketplace backend's table in devportal-plugins; digestColumns adds
    // the nullable columns the script reads when they exist.
    await client.query(`CREATE TABLE marketplace_installations (
      package_name varchar(500) PRIMARY KEY,
      disabled boolean NOT NULL DEFAULT false,
      config_yaml text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    if (digestColumns) {
      await client.query(
        'ALTER TABLE marketplace_installations ADD COLUMN requested_ref text, ADD COLUMN resolved_digest text',
      );
    }
    for (const row of rows) {
      const columns = Object.keys(row);
      await client.query(
        `INSERT INTO marketplace_installations (${columns.join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    }
  });
}

async function preparePrestep(
  t,
  {
    prefix,
    digestColumns = true,
    rows,
    registry = {},
    faceRefs = [],
    faceFilePath,
  },
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prestep-test-'));
  const database = `${prefix}extensions`;
  t.after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await withClient('postgres', client =>
      client.query(`DROP DATABASE IF EXISTS "${database}"`),
    );
  });
  await seed(database, { digestColumns, rows });

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'skopeo'), FAKE_SKOPEO, { mode: 0o755 });
  const digests = path.join(dir, 'digests');
  fs.writeFileSync(
    digests,
    Object.entries(registry)
      .map(([image, sha]) => `${image} ${sha}\n`)
      .join(''),
  );
  const config = path.join(dir, 'app-config.yaml');
  fs.writeFileSync(
    config,
    YAML.stringify({
      backend: { database: { client: 'pg', connection: PG, prefix } },
    }),
  );
  const face = faceFilePath || path.join(dir, 'dynamic-plugins.veecode.yaml');
  if (!faceFilePath) {
    fs.writeFileSync(
      face,
      YAML.stringify({ plugins: faceRefs.map(ref => ({ package: ref })) }),
    );
  }
  const calls = path.join(dir, 'skopeo-calls');
  const data = path.join(dir, 'data');
  const out = path.join(data, 'extensions-install.yaml');

  return async () => {
    fs.rmSync(calls, { force: true });
    fs.rmSync(out, { force: true });
    const result = spawnSync(process.execPath, [SCRIPT, '--config', config], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        DEVPORTAL_DB_PATH: data,
        DEVPORTAL_FACE_FILE: face,
        FAKE_SKOPEO_DIGESTS: digests,
        FAKE_SKOPEO_LOG: calls,
      },
    });
    const storedDigests = digestColumns
      ? await withClient(database, async client => {
          const stored = await client.query(
            'SELECT package_name, resolved_digest FROM marketplace_installations',
          );
          return Object.fromEntries(
            stored.rows.map(row => [row.package_name, row.resolved_digest]),
          );
        })
      : undefined;
    const run = {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      yaml: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : undefined,
      skopeoCalls: fs.existsSync(calls)
        ? fs.readFileSync(calls, 'utf8').trim().split('\n')
        : [],
      storedDigests,
    };
    t.diagnostic(`exit status: ${run.status}`);
    t.diagnostic(
      `skopeo calls (${run.skopeoCalls.length}): ${run.skopeoCalls.join(' | ') || 'none'}`,
    );
    t.diagnostic(`stored digests: ${JSON.stringify(run.storedDigests)}`);
    t.diagnostic(`stdout:\n${run.stdout}`);
    t.diagnostic(`stderr:\n${run.stderr}`);
    return run;
  };
}

async function runPrestep(t, options) {
  return (await preparePrestep(t, options))();
}

function assertWritten(run) {
  assert.equal(run.status, 0);
  assert.ok(
    run.yaml !== undefined,
    'the pre-step did not write extensions-install.yaml',
  );
}

function assertLine(output, line) {
  assert.ok(
    output.split('\n').includes(line),
    `expected the line\n  ${line}\nin\n${output}`,
  );
}

function assertSummary(run, total, { pinned, nonOci, skipped, disabled }) {
  const match =
    /^VEECODE prestep: digest-pinned (\d+) of (\d+) selection\(s\) \((\d+) non-OCI, (\d+) skipped, (\d+) disabled\)$/m.exec(
      run.stdout,
    );
  assert.ok(match, `no digest-pinned summary in\n${run.stdout}`);
  const [n, m, k, sk, d] = match.slice(1).map(Number);
  assert.deepEqual(
    { n, m, k, s: sk, d },
    { n: pinned, m: total, k: nonOci, s: skipped, d: disabled },
  );
  assert.equal(n + k + sk + d, m);
}

const oci = name => `oci://registry.test/veecode/${name}:1.0.0!${name}`;
const versioned = (name, version) =>
  `oci://registry.test/veecode/${name}:${version}!${name}`;
const at = minute => new Date(Date.UTC(2026, 8, 29, 12, minute));
const dropping = (dropped, kept) =>
  `VEECODE prestep: WARNING — dropping "${dropped}": "${kept}" names the same plugin and is preferred`;
const pinned = (name, sha) =>
  `oci://registry.test/veecode/${name}@${sha}!${name}`;
const image = name => `docker://registry.test/veecode/${name}:1.0.0`;
const PROTECTED_MARKETPLACE_PLUGINS = [
  'devportal-marketplace-backend',
  'devportal-marketplace-frontend-dynamic',
  'devportal-pending-changes-dynamic',
  'red-hat-developer-hub-backstage-plugin-catalog-backend-module-extensions',
].join(', ');

const SAME_PLUGIN_VECTORS = [
  [
    'matches references with different digests for one repository',
    'oci://quay.io/veecode/x@sha256:A',
    'oci://quay.io/veecode/x@sha256:B',
    true,
  ],
  [
    'matches a selector-less tag with a selector-bearing digest',
    'oci://quay.io/veecode/x:bs_1.52.0__1.0.0',
    'oci://quay.io/veecode/x@sha256:A!x',
    true,
  ],
  [
    'matches the same selector across different digests',
    'oci://quay.io/veecode/x@sha256:A!x',
    'oci://quay.io/veecode/x@sha256:B!x',
    true,
  ],
  [
    'keeps different selectors on one repository separate',
    'oci://quay.io/veecode/x@sha256:A!x',
    'oci://quay.io/veecode/x@sha256:B!y',
    false,
  ],
  [
    'keeps different repositories with the same selector separate',
    'oci://quay.io/veecode/x!a',
    'oci://quay.io/veecode/y!a',
    false,
  ],
  [
    'keeps a registry port while ignoring tag changes',
    'oci://localhost:5000/x:1',
    'oci://localhost:5000/x:2',
    true,
  ],
  [
    'treats different registry ports as different repositories',
    'oci://localhost:5000/x:1',
    'oci://localhost:5001/x:1',
    false,
  ],
  [
    'matches identical local paths',
    './dynamic-plugins/dist/a',
    './dynamic-plugins/dist/a',
    true,
  ],
  [
    'keeps different local paths separate',
    './dynamic-plugins/dist/a',
    './dynamic-plugins/dist/a-dynamic',
    false,
  ],
  [
    'keeps a local path separate from an OCI reference',
    './dynamic-plugins/dist/a',
    'oci://quay.io/veecode/a@sha256:A',
    false,
  ],
  [
    'matches scoped npm packages across versions',
    '@scope/pkg@1.0.0',
    '@scope/pkg@2.0.0',
    true,
  ],
];

async function assertProtectedDisabledFaceRow(t, { prefix, faceRef, rowRef }) {
  const run = await runPrestep(t, {
    prefix,
    rows: [installation(rowRef, { disabled: true })],
    faceRefs: [faceRef],
  });

  assertWritten(run);
  assert.deepEqual(YAML.parse(run.yaml), { plugins: [] });
  assert.deepEqual(run.skopeoCalls, []);
  assert.equal(run.storedDigests[rowRef], null);
  assertLine(
    run.stderr,
    `VEECODE prestep: WARNING — ignoring disabled marketplace row "${rowRef}" for protected marketplace face plugin "${faceRef}"; protected plugins: ${PROTECTED_MARKETPLACE_PLUGINS}`,
  );
  assertSummary(run, 0, { pinned: 0, nonOci: 0, skipped: 0, disabled: 0 });
}

const ALL_GOOD_YAML = `plugins:
  - package: ./dynamic-plugins/dist/local-plugin-dynamic
    disabled: false
  - package: oci://registry.test/veecode/pinned@${digest(2)}!pinned
    disabled: false
  - package: oci://registry.test/veecode/tagged@${digest(3)}!tagged
    disabled: false
    pluginConfig:
      dynamicPlugins:
        frontend:
          veecode.tagged:
            mountPoints:
              - mountPoint: entity.page.overview/cards
                importName: TaggedCard
`;

describe('regenerate-extensions-install.js', () => {
  it('skips an enabled row whose digest cannot be resolved and regenerates the rest', async t => {
    const run = await runPrestep(t, {
      prefix: 'prestep_skip_',
      rows: [installation(oci('available')), installation(oci('missing'))],
      registry: { [image('available')]: digest(1) },
    });

    assertWritten(run);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [{ package: pinned('available', digest(1)), disabled: false }],
    });
    assertLine(
      run.stderr,
      `VEECODE prestep: WARNING — skipping "${oci('missing')}": could not resolve a digest for "${oci('missing')}"`,
    );
    assertLine(
      run.stdout,
      'VEECODE prestep: digest-pinned 1 of 2 selection(s) (0 non-OCI, 1 skipped, 0 disabled)',
    );
  });

  it('never resolves a disabled row and writes it as disabled', async t => {
    const run = await runPrestep(t, {
      prefix: 'prestep_disabled_',
      rows: [
        installation('./dynamic-plugins/dist/retired-plugin-dynamic', {
          disabled: true,
        }),
        installation(oci('parked'), {
          disabled: true,
          resolved_digest: digest(5),
        }),
        installation(oci('paused'), { disabled: true }),
      ],
    });

    assert.deepEqual(run.skopeoCalls, []);
    assertWritten(run);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        {
          package: './dynamic-plugins/dist/retired-plugin-dynamic',
          disabled: true,
        },
        { package: pinned('parked', digest(5)), disabled: true },
        { package: oci('paused'), disabled: true },
      ],
    });
    assertLine(
      run.stdout,
      'VEECODE prestep: digest-pinned 0 of 3 selection(s) (1 non-OCI, 0 skipped, 2 disabled)',
    );
  });

  it('pins for this boot only on a database without the digest columns', async t => {
    const run = await runPrestep(t, {
      prefix: 'prestep_premigration_',
      digestColumns: false,
      rows: [installation(oci('legacy'))],
      registry: { [image('legacy')]: digest(6) },
    });

    assertWritten(run);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [{ package: pinned('legacy', digest(6)), disabled: false }],
    });
    assertLine(
      run.stderr,
      `VEECODE prestep: WARNING — resolved_digest column is absent (pre-migration database) — resolved ${digest(6)} for this boot only, it will be resolved again next time`,
    );
  });

  it('writes the same YAML as before when every row resolves', async t => {
    const run = await runPrestep(t, {
      prefix: 'prestep_all_good_',
      rows: [
        {
          package_name: './dynamic-plugins/dist/local-plugin-dynamic',
          disabled: false,
        },
        installation(oci('pinned'), { resolved_digest: digest(2) }),
        installation(oci('tagged'), {
          config_yaml: YAML.stringify({
            package: oci('tagged'),
            disabled: false,
            pluginConfig: {
              dynamicPlugins: {
                frontend: {
                  'veecode.tagged': {
                    mountPoints: [
                      {
                        mountPoint: 'entity.page.overview/cards',
                        importName: 'TaggedCard',
                      },
                    ],
                  },
                },
              },
            },
          }),
        }),
      ],
      registry: { [image('tagged')]: digest(3) },
    });

    assertWritten(run);
    assert.equal(run.yaml, ALL_GOOD_YAML);
  });

  it('resolves an enabled row once, stores the digest and makes no call on the next boot', async t => {
    const bare = `oci://registry.test/veecode/digested@${digest(7)}`;
    const selected = `oci://registry.test/veecode/selected@${digest(4)}!selected`;
    const gone = `oci://registry.test/veecode/gone@${digest(9)}!gone`;
    const execute = await preparePrestep(t, {
      prefix: 'prestep_resolve_once_',
      rows: [
        installation(bare),
        installation(selected),
        installation(oci('tagged')),
        installation(gone),
      ],
      registry: {
        [`docker://registry.test/veecode/digested@${digest(7)}`]: digest(7),
        [`docker://registry.test/veecode/selected@${digest(4)}`]: digest(4),
        [image('tagged')]: digest(3),
      },
    });

    const first = await execute();
    assertWritten(first);
    assert.deepEqual([...first.skopeoCalls].sort(), [
      `inspect docker://registry.test/veecode/digested@${digest(7)}`,
      `inspect docker://registry.test/veecode/gone@${digest(9)}`,
      `inspect docker://registry.test/veecode/selected@${digest(4)}`,
      `inspect ${image('tagged')}`,
    ]);
    assert.deepEqual(first.storedDigests, {
      [bare]: digest(7),
      [selected]: digest(4),
      [oci('tagged')]: digest(3),
      [gone]: null,
    });
    assert.deepEqual(YAML.parse(first.yaml), {
      plugins: [
        { package: bare, disabled: false },
        { package: selected, disabled: false },
        { package: pinned('tagged', digest(3)), disabled: false },
      ],
    });
    assertLine(
      first.stderr,
      `VEECODE prestep: WARNING — skipping "${gone}": could not resolve a digest for "${gone}"`,
    );
    assertSummary(first, 4, {
      pinned: 3,
      nonOci: 0,
      skipped: 1,
      disabled: 0,
    });

    const second = await execute();
    assertWritten(second);
    assert.deepEqual(second.skopeoCalls, [
      `inspect docker://registry.test/veecode/gone@${digest(9)}`,
    ]);
    assert.equal(second.yaml, first.yaml);
  });

  it('counts rows without a selector as skipped and as disabled', async t => {
    const shelved = `oci://registry.test/veecode/shelved@${digest(5)}`;
    const run = await runPrestep(t, {
      prefix: 'prestep_bare_counts_',
      rows: [
        installation('./dynamic-plugins/dist/local-plugin-dynamic'),
        installation('oci://registry.test/veecode/kept:1.0.0'),
        installation('oci://registry.test/veecode/lost:1.0.0'),
        installation('oci://registry.test/veecode/parked:1.0.0', {
          disabled: true,
        }),
        installation(shelved, { disabled: true }),
      ],
      registry: {
        'docker://registry.test/veecode/kept:1.0.0': digest(1),
      },
    });

    assertWritten(run);
    assert.deepEqual(run.skopeoCalls, [
      'inspect docker://registry.test/veecode/kept:1.0.0',
      'inspect docker://registry.test/veecode/lost:1.0.0',
    ]);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        {
          package: './dynamic-plugins/dist/local-plugin-dynamic',
          disabled: false,
        },
        {
          package: `oci://registry.test/veecode/kept@${digest(1)}`,
          disabled: false,
        },
        { package: 'oci://registry.test/veecode/parked:1.0.0', disabled: true },
        { package: shelved, disabled: true },
      ],
    });
    assert.equal(run.storedDigests[shelved], null);
    assertLine(
      run.stderr,
      'VEECODE prestep: WARNING — skipping "oci://registry.test/veecode/lost:1.0.0": could not resolve a digest for "oci://registry.test/veecode/lost:1.0.0"',
    );
    assertSummary(run, 5, { pinned: 1, nonOci: 1, skipped: 1, disabled: 2 });
  });

  it('maps a selector-less disabled face row to the face package without resolving it', async t => {
    const rowRef = 'oci://registry.test/veecode/faced:1.0.0';
    const faceRef = pinned('faced', digest(4));
    const run = await runPrestep(t, {
      prefix: 'prestep_face_disabled_',
      rows: [installation(rowRef, { disabled: true })],
      faceRefs: [faceRef],
    });

    assertWritten(run);
    assert.deepEqual(run.skopeoCalls, []);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [{ package: faceRef, disabled: true }],
    });
    assertLine(
      run.stdout,
      `VEECODE prestep: face default "${faceRef}": marketplace row "${rowRef}" sets disabled=true`,
    );
    assert.equal(run.storedDigests[rowRef], null);
    assertSummary(run, 0, { pinned: 0, nonOci: 0, skipped: 0, disabled: 0 });
  });

  it('removes pluginConfig from an enabled face row and prints the contract warning', async t => {
    const rowRef = 'oci://registry.test/veecode/faced:1.0.0';
    const faceRef = pinned('faced', digest(4));
    const config = {
      package: rowRef,
      disabled: false,
      pluginConfig: { dynamicPlugins: { frontend: { 'example.plugin': {} } } },
    };
    const run = await runPrestep(t, {
      prefix: 'prestep_face_config_',
      rows: [installation(rowRef, { config_yaml: YAML.stringify(config) })],
      faceRefs: [faceRef],
    });

    assertWritten(run);
    assert.deepEqual(run.skopeoCalls, []);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [{ package: faceRef, disabled: false }],
    });
    assertLine(
      run.stderr,
      `VEECODE prestep: WARNING — ignoring the pluginConfig of "${rowRef}": the product face owns the configuration of "${faceRef}"`,
    );
    assertSummary(run, 0, { pinned: 0, nonOci: 0, skipped: 0, disabled: 0 });
  });

  it('keeps a row for a different selector on the face repository as a separate plugin', async t => {
    const faceRef = pinned('faced', digest(4));
    const rowRef = 'oci://registry.test/veecode/faced:1.0.0!other';
    const run = await runPrestep(t, {
      prefix: 'prestep_face_other_selector_',
      rows: [installation(rowRef)],
      registry: { [image('faced')]: digest(5) },
      faceRefs: [faceRef],
    });

    assertWritten(run);
    assert.deepEqual(run.skopeoCalls, [`inspect ${image('faced')}`]);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        {
          package: `oci://registry.test/veecode/faced@${digest(5)}!other`,
          disabled: false,
        },
      ],
    });
    assert.ok(!run.stdout.includes('face default'), run.stdout);
    assertSummary(run, 1, { pinned: 1, nonOci: 0, skipped: 0, disabled: 0 });
  });

  it('keeps one face row by preferring enabled state and then the newest update', async t => {
    const faceRef = pinned('faced', digest(4));
    const olderEnabled = versioned('faced', '1.0.0');
    const newerEnabled = versioned('faced', '2.0.0');
    const newestDisabled = versioned('faced', '3.0.0');
    const run = await runPrestep(t, {
      prefix: 'prestep_face_preferred_',
      rows: [
        installation(olderEnabled, { updated_at: at(10) }),
        installation(newerEnabled, { updated_at: at(20) }),
        installation(newestDisabled, { disabled: true, updated_at: at(30) }),
      ],
      faceRefs: [faceRef],
    });

    assertWritten(run);
    assert.deepEqual(run.skopeoCalls, []);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [{ package: faceRef, disabled: false }],
    });
    assertLine(
      run.stdout,
      `VEECODE prestep: face default "${faceRef}": marketplace row "${newerEnabled}" sets disabled=false`,
    );
    assertSummary(run, 0, { pinned: 0, nonOci: 0, skipped: 0, disabled: 0 });
  });

  it('leaves a row unchanged when the face does not declare its plugin', async t => {
    const faceRef = pinned('faced', digest(4));
    const rowRef = oci('marketplace-only');
    const config = {
      package: rowRef,
      disabled: false,
      pluginConfig: { dynamicPlugins: { frontend: { 'marketplace.only': {} } } },
    };
    const run = await runPrestep(t, {
      prefix: 'prestep_non_face_row_',
      rows: [installation(rowRef, { config_yaml: YAML.stringify(config) })],
      registry: { [image('marketplace-only')]: digest(6) },
      faceRefs: [faceRef],
    });

    assertWritten(run);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        {
          package: pinned('marketplace-only', digest(6)),
          disabled: false,
          pluginConfig: { dynamicPlugins: { frontend: { 'marketplace.only': {} } } },
        },
      ],
    });
    assert.deepEqual(run.skopeoCalls, [`inspect ${image('marketplace-only')}`]);
    assertSummary(run, 1, { pinned: 1, nonOci: 0, skipped: 0, disabled: 0 });
  });

  it('keeps only the most recently written of the enabled rows that name one plugin', async t => {
    const reinstalled = versioned('reinstalled', '1.0.0');
    const superseded = versioned('reinstalled', '2.0.0');
    const older = `oci://registry.test/veecode/updated@${digest(1)}!updated`;
    const newer = `oci://registry.test/veecode/updated@${digest(2)}!updated`;
    const run = await runPrestep(t, {
      prefix: 'prestep_same_plugin_',
      rows: [
        installation(reinstalled, { updated_at: at(30) }),
        installation(superseded, { updated_at: at(10) }),
        installation(older, { updated_at: at(10) }),
        installation(newer, { updated_at: at(20) }),
        installation(oci('other'), { updated_at: at(5) }),
        installation('./dynamic-plugins/dist/local-plugin-dynamic'),
      ],
      registry: {
        [image('reinstalled')]: digest(3),
        [`docker://registry.test/veecode/updated@${digest(2)}`]: digest(2),
        [image('other')]: digest(4),
      },
    });

    assertWritten(run);
    assert.deepEqual([...run.skopeoCalls].sort(), [
      `inspect ${image('other')}`,
      `inspect ${image('reinstalled')}`,
      `inspect docker://registry.test/veecode/updated@${digest(2)}`,
    ]);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        {
          package: './dynamic-plugins/dist/local-plugin-dynamic',
          disabled: false,
        },
        { package: pinned('other', digest(4)), disabled: false },
        { package: pinned('reinstalled', digest(3)), disabled: false },
        { package: newer, disabled: false },
      ],
    });
    assertLine(run.stderr, dropping(superseded, reinstalled));
    assertLine(run.stderr, dropping(older, newer));
    assert.equal(run.storedDigests[superseded], null);
    assert.equal(run.storedDigests[older], null);
    assertSummary(run, 4, { pinned: 3, nonOci: 1, skipped: 0, disabled: 0 });
  });

  it('keeps an enabled row over a newer disabled row of the same plugin', async t => {
    const retained = versioned('retained', '1.0.0');
    const retiredNewer = versioned('retained', '2.0.0');
    const restoredOlder = versioned('restored', '1.0.0');
    const restored = versioned('restored', '2.0.0');
    const run = await runPrestep(t, {
      prefix: 'prestep_enabled_wins_',
      rows: [
        installation(retained, { updated_at: at(10) }),
        installation(retiredNewer, { disabled: true, updated_at: at(20) }),
        installation(restoredOlder, { disabled: true, updated_at: at(20) }),
        installation(restored, { updated_at: at(10) }),
      ],
      registry: {
        [image('retained')]: digest(1),
        'docker://registry.test/veecode/restored:2.0.0': digest(2),
      },
    });

    assertWritten(run);
    assert.deepEqual([...run.skopeoCalls].sort(), [
      'inspect docker://registry.test/veecode/restored:2.0.0',
      `inspect ${image('retained')}`,
    ]);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        { package: pinned('restored', digest(2)), disabled: false },
        { package: pinned('retained', digest(1)), disabled: false },
      ],
    });
    assertLine(run.stderr, dropping(retiredNewer, retained));
    assertLine(run.stderr, dropping(restoredOlder, restored));
    assertSummary(run, 2, { pinned: 2, nonOci: 0, skipped: 0, disabled: 0 });
  });

  it('keeps the newer of two disabled rows that name one plugin', async t => {
    const parked = versioned('parked', '1.0.0');
    const shelved = versioned('parked', '2.0.0');
    const run = await runPrestep(t, {
      prefix: 'prestep_disabled_pair_',
      rows: [
        installation(parked, { disabled: true, updated_at: at(20) }),
        installation(shelved, { disabled: true, updated_at: at(10) }),
      ],
    });

    assert.deepEqual(run.skopeoCalls, []);
    assertWritten(run);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [{ package: parked, disabled: true }],
    });
    assertLine(run.stderr, dropping(shelved, parked));
    assertSummary(run, 1, { pinned: 0, nonOci: 0, skipped: 0, disabled: 1 });
  });

  it('keeps the row later in package_name order when updated_at is equal', async t => {
    const first = versioned('tied', '1.0.0');
    const second = versioned('tied', '2.0.0');
    const run = await runPrestep(t, {
      prefix: 'prestep_tied_',
      rows: [
        installation(first, { updated_at: at(10) }),
        installation(second, { updated_at: at(10) }),
      ],
      registry: { 'docker://registry.test/veecode/tied:2.0.0': digest(1) },
    });

    assertWritten(run);
    assert.deepEqual(run.skopeoCalls, [
      'inspect docker://registry.test/veecode/tied:2.0.0',
    ]);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [{ package: pinned('tied', digest(1)), disabled: false }],
    });
    assertLine(run.stderr, dropping(first, second));
    assertSummary(run, 1, { pinned: 1, nonOci: 0, skipped: 0, disabled: 0 });
  });

  it('leaves tarball rows of different plugins alone even when both URLs contain an @scope', async t => {
    const alpha = 'https://example.test/@acme/plugin-a-1.0.0.tgz';
    const beta = 'https://example.test/@acme/plugin-b-1.0.0.tgz';
    const run = await runPrestep(t, {
      prefix: 'prestep_tarballs_',
      rows: [installation(alpha), installation(beta)],
    });

    assertWritten(run);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        { package: alpha, disabled: false },
        { package: beta, disabled: false },
      ],
    });
    assert.ok(!run.stderr.includes('dropping'), run.stderr);
    assertSummary(run, 2, { pinned: 0, nonOci: 2, skipped: 0, disabled: 0 });
  });

  it('leaves two npm rows of one package to the installer', async t => {
    const older = '@acme/plugin-x@1.0.0';
    const newer = '@acme/plugin-x@1.1.0';
    const run = await runPrestep(t, {
      prefix: 'prestep_npm_versions_',
      rows: [
        installation(older, { updated_at: at(10) }),
        installation(newer, { updated_at: at(20) }),
      ],
    });

    assertWritten(run);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        { package: older, disabled: false },
        { package: newer, disabled: false },
      ],
    });
    assert.ok(!run.stderr.includes('dropping'), run.stderr);
    assertSummary(run, 2, { pinned: 0, nonOci: 2, skipped: 0, disabled: 0 });
  });

  it('leaves two Git rows of one repository to the installer', async t => {
    const first = 'github:acme/plugin-x#v1';
    const second = 'github:acme/plugin-x#v2';
    const run = await runPrestep(t, {
      prefix: 'prestep_git_refs_',
      rows: [
        installation(first, { updated_at: at(10) }),
        installation(second, { updated_at: at(20) }),
      ],
    });

    assert.deepEqual(run.skopeoCalls, []);
    assertWritten(run);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        { package: first, disabled: false },
        { package: second, disabled: false },
      ],
    });
    assert.ok(!run.stderr.includes('dropping'), run.stderr);
    assertSummary(run, 2, { pinned: 0, nonOci: 2, skipped: 0, disabled: 0 });
  });

  it('keeps every row of an image whose rows select different plugins', async t => {
    const alpha = 'oci://registry.test/veecode/bundle:1.0.0!alpha';
    const beta = 'oci://registry.test/veecode/bundle:1.0.0!beta';
    const run = await runPrestep(t, {
      prefix: 'prestep_selectors_',
      rows: [installation(alpha), installation(beta)],
      registry: { 'docker://registry.test/veecode/bundle:1.0.0': digest(1) },
    });

    assertWritten(run);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        {
          package: `oci://registry.test/veecode/bundle@${digest(1)}!alpha`,
          disabled: false,
        },
        {
          package: `oci://registry.test/veecode/bundle@${digest(1)}!beta`,
          disabled: false,
        },
      ],
    });
    assert.ok(!run.stderr.includes('dropping'), run.stderr);
    assertSummary(run, 2, { pinned: 2, nonOci: 0, skipped: 0, disabled: 0 });
  });

  it('preserves an ambiguous selector-less row without dropping distinct selectors', async t => {
    const repository = 'oci://registry.test/veecode/bundle';
    const scenarios = [
      {
        name: 'selector-less row first, newest',
        rootVersion: '1.0.0',
        selectorVersion: '2.0.0',
        rootUpdated: 30,
        alphaUpdated: 10,
        betaUpdated: 20,
      },
      {
        name: 'selector-less row first, oldest',
        rootVersion: '1.0.0',
        selectorVersion: '2.0.0',
        rootUpdated: 10,
        alphaUpdated: 20,
        betaUpdated: 30,
      },
      {
        name: 'selector-less row last, newest',
        rootVersion: '2.0.0',
        selectorVersion: '1.0.0',
        rootUpdated: 30,
        alphaUpdated: 10,
        betaUpdated: 20,
      },
      {
        name: 'selector-less row last, oldest',
        rootVersion: '2.0.0',
        selectorVersion: '1.0.0',
        rootUpdated: 10,
        alphaUpdated: 20,
        betaUpdated: 30,
      },
    ];
    const failures = [];

    for (const [index, scenario] of scenarios.entries()) {
      const rootRef = `${repository}:${scenario.rootVersion}`;
      const alphaRef = `${repository}:${scenario.selectorVersion}!alpha`;
      const betaRef = `${repository}:${scenario.selectorVersion}!beta`;
      const refs = [rootRef, alphaRef, betaRef];
      const registry = Object.fromEntries(
        refs.map(ref => [
          `docker://${ref.slice('oci://'.length).split('!')[0]}`,
          digest(1),
        ]),
      );
      const run = await runPrestep(t, {
        prefix: `prestep_bridge_${index}_`,
        rows: [
          installation(rootRef, { updated_at: at(scenario.rootUpdated) }),
          installation(alphaRef, { updated_at: at(scenario.alphaUpdated) }),
          installation(betaRef, { updated_at: at(scenario.betaUpdated) }),
        ],
        registry,
      });
      assertWritten(run);

      const packages = YAML.parse(run.yaml).plugins.map(plugin => plugin.package);
      const expectedPackages = [
        `${repository}@${digest(1)}`,
        `${repository}@${digest(1)}!alpha`,
        `${repository}@${digest(1)}!beta`,
      ].sort();
      const namesAmbiguity =
        run.stderr.toLowerCase().includes('ambiguous') &&
        refs.every(ref => run.stderr.includes(`"${ref}"`));
      if (
        JSON.stringify(packages.sort()) !== JSON.stringify(expectedPackages) ||
        !namesAmbiguity
      ) {
        failures.push({
          scenario: scenario.name,
          packages,
          expectedPackages,
          namesAmbiguity,
          stderr: run.stderr,
        });
      }
    }

    assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
  });

  it('keeps the preferred row when a selector-less ref has only one selector', async t => {
    const repository = 'oci://registry.test/veecode/bundle';
    const rootRef = `${repository}:1.0.0`;
    const alphaRef = `${repository}:2.0.0!alpha`;
    const run = await runPrestep(t, {
      prefix: 'prestep_bridge_single_selector_',
      rows: [
        installation(rootRef, { updated_at: at(30) }),
        installation(alphaRef, { updated_at: at(20) }),
      ],
      registry: {
        'docker://registry.test/veecode/bundle:1.0.0': digest(1),
        'docker://registry.test/veecode/bundle:2.0.0': digest(2),
      },
    });

    assertWritten(run);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [{ package: `${repository}@${digest(1)}`, disabled: false }],
    });
  });

  it('treats a row matching multiple face selectors as a non-face row', async t => {
    const repository = 'oci://registry.test/veecode/bundle';
    const rowRef = `${repository}:1.0.0`;
    const alphaFace = `${repository}@${digest(4)}!alpha`;
    const betaFace = `${repository}@${digest(5)}!beta`;
    const run = await runPrestep(t, {
      prefix: 'prestep_face_ambiguous_selectors_',
      rows: [installation(rowRef)],
      registry: {
        'docker://registry.test/veecode/bundle:1.0.0': digest(6),
      },
      faceRefs: [alphaFace, betaFace],
    });

    assertWritten(run);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [{ package: `${repository}@${digest(6)}`, disabled: false }],
    });
    assert.ok(run.stderr.toLowerCase().includes('ambiguous'), run.stderr);
    for (const ref of [rowRef, alphaFace, betaFace]) {
      assert.ok(run.stderr.includes(`"${ref}"`), run.stderr);
    }
  });

  it('ignores a disabled Marketplace backend OCI face row', async t => {
    const faceRef =
      `oci://quay.io/veecode/devportal-marketplace-backend@${digest(4)}` +
      '!devportal-marketplace-backend';
    const rowRef = 'oci://quay.io/veecode/devportal-marketplace-backend:bs_1.52.0';

    await assertProtectedDisabledFaceRow(t, {
      prefix: 'prestep_protected_backend_',
      faceRef,
      rowRef,
    });
  });

  it('ignores a disabled catalog provider local-path face row', async t => {
    const faceRef =
      './dynamic-plugins/dist/red-hat-developer-hub-backstage-plugin-catalog-backend-module-extensions-dynamic';

    await assertProtectedDisabledFaceRow(t, {
      prefix: 'prestep_protected_catalog_local_',
      faceRef,
      rowRef: faceRef,
    });
  });

  it('ignores a disabled catalog provider OCI face row', async t => {
    const faceRef =
      `oci://quay.io/veecode/red-hat-developer-hub-backstage-plugin-catalog-backend-module-extensions@${digest(4)}` +
      '!red-hat-developer-hub-backstage-plugin-catalog-backend-module-extensions-dynamic';
    const rowRef =
      'oci://quay.io/veecode/red-hat-developer-hub-backstage-plugin-catalog-backend-module-extensions:0.18.0';

    await assertProtectedDisabledFaceRow(t, {
      prefix: 'prestep_protected_catalog_oci_',
      faceRef,
      rowRef,
    });
  });

  it('protects exactly the four named entries in the real product face', async t => {
    const faceFile = path.join(__dirname, '..', 'dynamic-plugins.veecode.yaml');
    const faceEntries = YAML.parse(fs.readFileSync(faceFile, 'utf8')).plugins;
    const protectedNames = [
      'devportal-marketplace-backend',
      'devportal-marketplace-frontend-dynamic',
      'devportal-pending-changes-dynamic',
      'red-hat-developer-hub-backstage-plugin-catalog-backend-module-extensions',
    ];
    const namesForRef = packageRef => {
      let candidates;
      if (packageRef.startsWith('oci://')) {
        const [image, selector] = packageRef.slice('oci://'.length).split('!');
        const noDigest = image.split('@')[0];
        const lastColon = noDigest.lastIndexOf(':');
        const lastSlash = noDigest.lastIndexOf('/');
        const repository =
          lastColon > lastSlash ? noDigest.slice(0, lastColon) : noDigest;
        candidates = [repository.split('/').pop(), selector];
      } else {
        candidates = [packageRef.replace(/\/+$/, '').split('/').pop()];
      }
      return new Set(
        candidates
          .filter(Boolean)
          .flatMap(name => [name, name.replace(/-dynamic$/, '')]),
      );
    };
    const countByProtectedName = Object.fromEntries(
      protectedNames.map(name => [
        name,
        faceEntries.filter(entry => namesForRef(entry.package).has(name)).length,
      ]),
    );
    const protectedEntries = faceEntries.filter(entry =>
      protectedNames.some(name => namesForRef(entry.package).has(name)),
    );
    assert.deepEqual(
      countByProtectedName,
      Object.fromEntries(protectedNames.map(name => [name, 1])),
    );
    assert.equal(protectedEntries.length, protectedNames.length);

    const run = await runPrestep(t, {
      prefix: 'prestep_real_face_protected_',
      rows: faceEntries.map((entry, index) =>
        installation(entry.package, {
          disabled: true,
          updated_at: at(index + 1),
        }),
      ),
      faceFilePath: faceFile,
    });

    assertWritten(run);
    assert.deepEqual(run.skopeoCalls, []);
    const expected = faceEntries
      .filter(entry => !protectedEntries.includes(entry))
      .map(entry => ({ package: entry.package, disabled: true }))
      .sort((a, b) => a.package.localeCompare(b.package));
    const actual = YAML.parse(run.yaml).plugins
      .map(({ package: packageRef, disabled }) => ({
        package: packageRef,
        disabled,
      }))
      .sort((a, b) => a.package.localeCompare(b.package));
    assert.deepEqual(actual, expected);
    for (const entry of protectedEntries) {
      assert.ok(run.stderr.includes(`"${entry.package}"`), run.stderr);
    }
  });

  it('keeps the registry port when it pins a ref that has a selector', async t => {
    const run = await runPrestep(t, {
      prefix: 'prestep_port_selector_',
      rows: [
        installation('oci://registry.test:5000/veecode/ported:1.0.0!ported'),
        installation(
          `oci://registry.test:5000/veecode/fixed@${digest(6)}!fixed`,
        ),
      ],
      registry: {
        'docker://registry.test:5000/veecode/ported:1.0.0': digest(2),
        [`docker://registry.test:5000/veecode/fixed@${digest(6)}`]: digest(6),
      },
    });

    assertWritten(run);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        {
          package: `oci://registry.test:5000/veecode/fixed@${digest(6)}!fixed`,
          disabled: false,
        },
        {
          package: `oci://registry.test:5000/veecode/ported@${digest(2)}!ported`,
          disabled: false,
        },
      ],
    });
    assertSummary(run, 2, { pinned: 2, nonOci: 0, skipped: 0, disabled: 0 });
  });

  it('resolves a tag ref without a selector and pins it as REPO@DIGEST', async t => {
    const ref = 'oci://registry.test:5000/veecode/untagged:1.0.0';
    const run = await runPrestep(t, {
      prefix: 'prestep_tag_ref_',
      rows: [installation(ref)],
      registry: {
        'docker://registry.test:5000/veecode/untagged:1.0.0': digest(8),
      },
    });

    assertWritten(run);
    assert.deepEqual(run.skopeoCalls, [
      'inspect docker://registry.test:5000/veecode/untagged:1.0.0',
    ]);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        {
          package: `oci://registry.test:5000/veecode/untagged@${digest(8)}`,
          disabled: false,
        },
      ],
    });
    assert.deepEqual(run.storedDigests, { [ref]: digest(8) });
    assertLine(
      run.stdout,
      'VEECODE prestep: digest-pinned 1 of 1 selection(s) (0 non-OCI, 0 skipped, 0 disabled)',
    );
  });

  it('gives a ref without a selector the same dedup key pinned or not', () => {
    const repository = 'oci://registry.test:5000/veecode/untagged';
    assert.equal(normalizePluginKey(`${repository}:1.0.0`), repository);
    assert.equal(normalizePluginKey(`${repository}@${digest(8)}`), repository);
  });

  for (const [name, a, b, expected] of SAME_PLUGIN_VECTORS) {
    it(`samePlugin identity: ${name}`, () => {
      assert.equal(
        typeof samePlugin,
        'function',
        'regenerate-extensions-install.js must export the shared samePlugin rule',
      );
      assert.equal(samePlugin(a, b), expected);
    });
  }
});
