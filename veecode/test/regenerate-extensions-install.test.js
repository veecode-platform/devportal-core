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
const { normalizePluginKey } = require(SCRIPT);

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
  { prefix, digestColumns = true, rows, registry = {}, faceRefs = [] },
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
  const face = path.join(dir, 'dynamic-plugins.veecode.yaml');
  fs.writeFileSync(
    face,
    YAML.stringify({ plugins: faceRefs.map(ref => ({ package: ref })) }),
  );
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
const pinned = (name, sha) =>
  `oci://registry.test/veecode/${name}@${sha}!${name}`;
const image = name => `docker://registry.test/veecode/${name}:1.0.0`;

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

  it('counts only the rows left after the product face dedup', async t => {
    const faced = oci('faced');
    const run = await runPrestep(t, {
      prefix: 'prestep_face_dedup_',
      rows: [
        installation(faced),
        installation(oci('kept')),
        installation('./dynamic-plugins/dist/local-plugin-dynamic'),
      ],
      registry: { [image('kept')]: digest(1) },
      faceRefs: [pinned('faced', digest(4))],
    });

    assertWritten(run);
    assert.deepEqual(run.skopeoCalls, [`inspect ${image('kept')}`]);
    assert.deepEqual(YAML.parse(run.yaml), {
      plugins: [
        {
          package: './dynamic-plugins/dist/local-plugin-dynamic',
          disabled: false,
        },
        { package: pinned('kept', digest(1)), disabled: false },
      ],
    });
    assert.ok(
      run.stdout
        .split('\n')
        .some(
          line =>
            line.startsWith(`VEECODE prestep: excluding "${faced}" from `) &&
            line.endsWith(': declared in product face file'),
        ),
      `no exclusion line for the face-owned row in\n${run.stdout}`,
    );
    assertLine(
      run.stdout,
      'VEECODE prestep: dedup against the product face file removed 1 selection(s)',
    );
    assertSummary(run, 2, { pinned: 1, nonOci: 1, skipped: 0, disabled: 0 });
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
});
