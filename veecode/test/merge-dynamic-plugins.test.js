const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const SCRIPT = path.join(__dirname, '..', 'merge-dynamic-plugins.js');

const INSTALLER_READ_PATH = '/opt/app-root/src/dynamic-plugins.yaml';
const PRELOAD = `
const fs = require('node:fs');
const realpathSync = fs.realpathSync.bind(fs);
fs.realpathSync = (candidate, options) => {
  if (candidate === '${INSTALLER_READ_PATH}') {
    return realpathSync(process.env.MERGE_TEST_INSTALLER_CONFIG_PATH, options);
  }
  return realpathSync(candidate, options);
};
`;

function runMerge(t, { operatorPlugins, extensionsPlugins }) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'merge-dynamic-plugins-test-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const dataPath = path.join(directory, 'data');
  const operatorPath = path.join(directory, 'operator.yaml');
  const extensionsPath = path.join(dataPath, 'extensions-install.yaml');
  const outputPath = path.join(dataPath, 'dynamic-plugins.yaml');
  const preloadPath = path.join(directory, 'preload.js');
  fs.mkdirSync(dataPath);
  fs.writeFileSync(
    operatorPath,
    YAML.stringify({ includes: ['dynamic-plugins.veecode.yaml'], plugins: operatorPlugins }),
  );
  fs.writeFileSync(
    extensionsPath,
    YAML.stringify({ plugins: extensionsPlugins }),
  );
  fs.writeFileSync(preloadPath, PRELOAD);

  const result = spawnSync(
    process.execPath,
    ['--require', preloadPath, SCRIPT],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEVPORTAL_DB_PATH: dataPath,
        DEVPORTAL_OPERATOR_CONFIG: operatorPath,
        MERGE_TEST_INSTALLER_CONFIG_PATH: outputPath,
      },
    },
  );

  assert.equal(result.status, 0, `merge failed:\n${result.stderr}`);
  return {
    document: YAML.parse(fs.readFileSync(outputPath, 'utf8')),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('merge-dynamic-plugins.js', () => {
  it('drops a selector-less row for the repository selected by the operator', t => {
    const operator = {
      package: 'oci://registry.test/veecode/plugin@sha256:A!plugin',
      disabled: true,
    };
    const row = {
      package: 'oci://registry.test/veecode/plugin:1.0.0',
      disabled: false,
    };

    const result = runMerge(t, {
      operatorPlugins: [operator],
      extensionsPlugins: [row],
    });

    assert.deepEqual(result.document.plugins, [operator]);
    assert.ok(
      result.stderr.includes(
        'VEECODE merge: WARNING — operator config wins for oci://registry.test/veecode/plugin!plugin',
      ),
      result.stderr,
    );
  });

  it('keeps a row with a different selector on the operator repository', t => {
    const operator = {
      package: 'oci://registry.test/veecode/plugin@sha256:A!first',
      disabled: true,
    };
    const row = {
      package: 'oci://registry.test/veecode/plugin@sha256:B!second',
      disabled: false,
    };

    const result = runMerge(t, {
      operatorPlugins: [operator],
      extensionsPlugins: [row],
    });

    assert.deepEqual(result.document.plugins, [operator, row]);
    assert.equal(result.stderr.includes('operator config wins'), false);
  });

  it('passes through a face plugin row when the operator does not override it', t => {
    const row = {
      package:
        'oci://ghcr.io/redhat-developer/rhdh-plugin-export-overlays/backstage-plugin-techdocs@sha256:A!backstage-plugin-techdocs',
      disabled: true,
    };

    const result = runMerge(t, {
      operatorPlugins: [],
      extensionsPlugins: [row],
    });

    assert.deepEqual(result.document.plugins, [row]);
  });
});
