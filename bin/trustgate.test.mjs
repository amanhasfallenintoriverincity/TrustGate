import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('./trustgate.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const scratchRoot = process.env.TMPDIR ?? tmpdir();

function run(args, script = cli) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolveResult({ code, stdout, stderr }));
  });
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function scratch(fn) {
  const dir = await mkdtemp(join(scratchRoot, 'trustgate-cli-'));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('scan --fixture POSTs the fixture task and prints the actual JSON report', async () => {
  const seen = [];
  const report = { runId: 'run-123', source: 'fixture', regressionVerdict: 'FIXED', hypotheses: [] };
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify(report));
  }, async (server) => {
    const result = await run(['scan', '--fixture', '--server', server]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), report);
  });
  assert.deepEqual(seen, [{ method: 'POST', url: '/api/runs', body: { source: 'fixture' } }]);
});

test('scan --repo POSTs a workspace task with the exact relative path', async () => {
  const seen = [];
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ runId: 'run-234', source: 'workspace', regressionVerdict: 'NOT_REPRODUCED' }));
  }, async (server) => {
    const result = await run(['scan', '--repo', 'apps/demo-target', '--server', server]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).runId, 'run-234');
  });
  assert.deepEqual(seen, [{ method: 'POST', url: '/api/runs', body: { source: 'workspace', repoPath: 'apps/demo-target' } }]);
});

test('scan --root POSTs a workspace task without repoPath and prints the report', async () => {
  const seen = [];
  const report = { runId: 'run-root', source: 'workspace', regressionVerdict: 'NOT_REPRODUCED' };
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify(report));
  }, async (server) => {
    const result = await run(['scan', '--root', '--server', server]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), report);
  });
  assert.deepEqual(seen, [{ method: 'POST', url: '/api/runs', body: { source: 'workspace' } }]);
});

test('health GETs local /health and prints its JSON', async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (server) => {
    const result = await run(['health', '--server', server]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  });
  assert.deepEqual(seen, [{ method: 'GET', url: '/health' }]);
});

test('help is local and describes scan, health and skill installation', async () => {
  const result = await run(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /scan --fixture/);
  assert.match(result.stdout, /scan --root/);
  assert.match(result.stdout, /scan --repo/);
  assert.match(result.stdout, /TRUSTGATE_WORKSPACE_ROOT/);
  assert.match(result.stdout, /operator/i);
  assert.match(result.stdout, /server.*running/i);
  assert.match(result.stdout, /not.*authoriz/i);
  assert.match(result.stdout, /health/);
  assert.match(result.stdout, /default timeout: 180000 ms/i);
  assert.match(result.stdout, /skill install/);
  assert.match(result.stdout, /hermes skills trust/);
});

test('rejects non-loopback servers before sending any request', async () => {
  const invalid = [
    'https://127.0.0.1:8787', 'http://example.com', 'http://127.0.0.2:8787',
    'http://localhost.evil.invalid:8787', 'http://127.0.0.1:8787@evil.invalid',
    'http://user:pass@127.0.0.1:8787', 'http://127.0.0.1:8787/other',
    'http://127.0.0.1:8787?x=secret', 'http://127.0.0.1:8787#secret',
    'http://2130706433:8787', 'http://127.0.0.1:0',
  ];
  for (const server of invalid) {
    const result = await run(['scan', '--fixture', '--server', server]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'trustgate: invalid server URL\n');
  }
});

test('rejects malformed and escaping repo paths before making requests', async () => {
  let requests = 0;
  await withServer((_req, res) => { requests++; res.end('{}'); }, async (server) => {
    const invalid = [
      '', '/', '/etc', '../outside', 'apps/../../outside', './apps',
      'apps//demo', 'apps/./demo', 'apps/../demo', 'apps\\demo',
      'C:\\Users\\x', 'apps\nsecret', 'a'.repeat(513),
    ];
    for (const value of invalid) {
      const result = await run(['scan', '--repo', value, '--server', server]);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'trustgate: invalid repository path\n');
    }
    assert.equal(requests, 0);
  });
});

test('rejects extra, duplicate and conflicting flags without network traffic', async () => {
  let requests = 0;
  await withServer((_req, res) => { requests++; res.end('{}'); }, async (server) => {
    for (const args of [
      ['scan', '--server', server],
      ['scan', '--root', '--fixture', '--server', server],
      ['scan', '--root', '--repo', 'somewhere', '--server', server],
      ['scan', '--root', '--root', '--server', server],
      ['scan', '--root', 'unexpected', '--server', server],
      ['scan', '--fixture', '--repo', 'somewhere'],
      ['scan', '--fixture', '--fixture'],
      ['scan', '--fixture', '--server', server, '--server', server],
      ['scan', '--repo'], ['scan'], ['health', '--fixture'],
      ['scan', '--fixture', '--api-key', 'do-not-leak'], ['unknown'],
    ]) {
      const result = await run(args);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'trustgate: invalid arguments\n');
    }
    assert.equal(requests, 0);
  });
});

test('rejects DNS-based localhost and accepts only literal loopback URLs', async () => {
  const hostname = await run(['health', '--server', 'http://localhost:8787']);
  assert.notEqual(hostname.code, 0);
  assert.equal(hostname.stdout, '');
  assert.equal(hostname.stderr, 'trustgate: invalid server URL\n');
  for (const url of ['http://[::1]:1', 'http://127.0.0.1:80']) {
    const result = await run(['health', '--server', url]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'trustgate: request failed\n');
  }
});

test('redirects are rejected without following offsite locations', async () => {
  let requests = 0;
  await withServer((_req, res) => { requests++; res.writeHead(302, { location: 'http://example.com/' }); res.end(); }, async (server) => {
    const result = await run(['health', '--server', server]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'trustgate: request failed\n');
  });
  assert.equal(requests, 1);
});


test('non-success HTTP status never prints server-provided error or secret', async () => {
  const marker = 'sensitive' + '-marker';
  await withServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: marker }));
  }, async (server) => {
    const result = await run(['scan', '--fixture', '--server', server]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'trustgate: request failed\n');
    assert.ok(!result.stderr.includes(marker));
  });
});

test('rejects malformed success JSON and wrong response shapes without printing them', async () => {
  for (const [status, text, args] of [
    [201, '{invalid', ['scan', '--fixture']],
    [201, '{}', ['scan', '--fixture']],
    [200, '{"ok":false}', ['health']],
  ]) {
    await withServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    }, async (server) => {
      const result = await run([...args, '--server', server]);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'trustgate: request failed\n');
    });
  }
});

test('caps response bytes even when the server streams past the limit', async () => {
  await withServer((_req, res) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    const large = 'x'.repeat(200_000);
    for (let i = 0; i < 12; i++) res.write(large);
    res.end();
  }, async (server) => {
    const result = await run(['scan', '--fixture', '--server', server]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'trustgate: request failed\n');
  });
});

test('times out an unresponsive local server using a bounded timeout option', async () => {
  await withServer(() => {}, async (server) => {
    const result = await run(['health', '--server', server, '--timeout-ms', '100']);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'trustgate: request failed\n');
  });
});

test('rejects invalid timeout values and unavailable server without echoing inputs', async () => {
  for (const timeout of ['0', '-1', 'NaN', '999999999', '1.5']) {
    const result = await run(['health', '--timeout-ms', timeout]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'trustgate: invalid arguments\n');
  }
  const result = await run(['health', '--server', 'http://127.0.0.1:1']);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'trustgate: request failed\n');
});

test('installs each agent skill under its own project directory with absolute runnable CLI', async () => {
  const mapping = {
    codex: '.agents', claude: '.claude', cursor: '.cursor', hermes: '.hermes',
  };
  await scratch(async (parent) => {
    for (const [agent, dotdir] of Object.entries(mapping)) {
      const project = join(parent, agent);
      await mkdir(project);
      const result = await run(['skill', 'install', '--agent', agent, '--project', project]);
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      const installed = await readFile(join(project, dotdir, 'skills', 'trustgate', 'SKILL.md'), 'utf8');
      assert.match(installed, /^---\nname: trustgate\n/);
      assert.match(installed, /node '\/.*\/bin\/trustgate\.mjs' --help/);
      assert.ok(installed.includes(cli));
      assert.match(installed, /hypothes/i);
      assert.match(installed, /sandbox/i);
      assert.match(installed, /scan --root/);
      assert.match(installed, /scan --repo RELATIVE_PATH/);
      assert.match(installed, /TRUSTGATE_WORKSPACE_ROOT/);
      assert.match(installed, /operator.*set/i);
      assert.match(installed, /server.*running/i);
      assert.match(installed, /not.*authoriz/i);
      if (agent === 'hermes') assert.match(installed, /hermes skills trust/);
    }
  });
});

test('install refuses overwrites and preserves unrelated files', async () => {
  await scratch(async (project) => {
    await mkdir(join(project, '.agents', 'skills', 'trustgate'), { recursive: true });
    await writeFile(join(project, '.agents', 'skills', 'trustgate', 'SKILL.md'), 'original');
    await writeFile(join(project, '.agents', 'skills', 'trustgate', 'notes.txt'), 'keep');
    const result = await run(['skill', 'install', '--agent', 'codex', '--project', project]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'trustgate: installation blocked\n');
    assert.equal(await readFile(join(project, '.agents', 'skills', 'trustgate', 'SKILL.md'), 'utf8'), 'original');
    assert.equal(await readFile(join(project, '.agents', 'skills', 'trustgate', 'notes.txt'), 'utf8'), 'keep');
  });
});

test('install rejects symlinked project and symlinked target path components', async () => {
  await scratch(async (parent) => {
    const realProject = join(parent, 'project');
    const outside = join(parent, 'outside');
    await mkdir(realProject);
    await mkdir(outside);
    await symlink(realProject, join(parent, 'project-link'));
    for (const linked of [join(parent, 'project-link'), `${parent}/project-link/../project`]) {
      const result = await run(['skill', 'install', '--agent', 'codex', '--project', linked]);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^trustgate: (?:invalid project directory|installation blocked)\n$/);
    }
    for (const pathComponents of [['.agents'], ['.agents', 'skills'], ['.agents', 'skills', 'trustgate']]) {
      const project = join(parent, `project-${pathComponents.length}`);
      await mkdir(project);
      const prefix = join(project, ...pathComponents.slice(0, -1));
      await mkdir(prefix, { recursive: true });
      await symlink(outside, join(project, ...pathComponents));
      const result = await run(['skill', 'install', '--agent', 'codex', '--project', project]);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'trustgate: installation blocked\n');
    }
    const project = join(parent, 'file-link');
    await mkdir(join(project, '.agents', 'skills', 'trustgate'), { recursive: true });
    await writeFile(join(outside, 'protected'), 'original');
    await symlink(join(outside, 'protected'), join(project, '.agents', 'skills', 'trustgate', 'SKILL.md'));
    const result = await run(['skill', 'install', '--agent', 'codex', '--project', project]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'trustgate: installation blocked\n');
    assert.equal(await readFile(join(outside, 'protected'), 'utf8'), 'original');
  });
});

test('install requires a real explicit absolute project and a recognized agent', async () => {
  await scratch(async (parent) => {
    for (const args of [
      ['--agent', 'codex', '--project', 'relative'],
      ['--agent', 'codex', '--project', join(parent, 'missing')],
      ['--agent', 'other', '--project', parent],
      ['--agent', 'codex'],
    ]) {
      const result = await run(['skill', 'install', ...args]);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^trustgate: (?:invalid arguments|invalid project directory)\n$/);
    }
  });
});

test('npm trustgate script invokes the same CLI help', async () => {
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.trustgate, 'node bin/trustgate.mjs');
  assert.match(packageJson.scripts.test, /bin\/trustgate\.test\.mjs/);
});

test('installed skill safely quotes an executable path with shell metacharacters', async () => {
  await scratch(async (parent) => {
    const weird = join(parent, "cli with ' quote; $(touch injected) #");
    await mkdir(weird);
    const fakeCli = join(weird, 'trustgate.mjs');
    await copyFile(cli, fakeCli);
    const skillDir = join(parent, 'skills', 'trustgate');
    await mkdir(skillDir, { recursive: true });
    await copyFile(join(repoRoot, 'skills', 'trustgate', 'SKILL.md'), join(skillDir, 'SKILL.md'));
    const project = join(parent, 'project');
    await mkdir(project);
    const result = await run(['skill', 'install', '--agent', 'codex', '--project', project], fakeCli);
    assert.equal(result.code, 0);
    const installed = await readFile(join(project, '.agents', 'skills', 'trustgate', 'SKILL.md'), 'utf8');
    const command = installed.match(/^\s*(node .+ --help)$/m)?.[1];
    assert.ok(command);
    const execution = await new Promise((resolveRun, reject) => {
      const child = spawn('sh', ['-c', command], { cwd: parent });
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (part) => { output += part; });
      child.on('error', reject);
      child.on('close', (code) => resolveRun({ code, output }));
    });
    assert.equal(execution.code, 0);
    assert.match(execution.output, /TrustGate CLI/);
    await assert.rejects(readFile(join(parent, 'injected')));
  });
});

test('CLI must not print response secrets from an HTTP failure', async () => {
  const marker = 'sentinel' + '-private-value';
  await withServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: marker }));
  }, async (server) => {
    const result = await run(['scan', '--fixture', '--server', server]);
    assert.equal(result.stdout.includes(marker), false);
    assert.equal(result.stderr.includes(marker), false);
  });
});
