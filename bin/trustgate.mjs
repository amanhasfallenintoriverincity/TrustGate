#!/usr/bin/env node

import { open, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(import.meta.url);
const template = fileURLToPath(new URL('../skills/trustgate/SKILL.md', import.meta.url));
const agentDir = { codex: '.agents', claude: '.claude', cursor: '.cursor', hermes: '.hermes' };

class CliError extends Error {}

const invalid = (message) => { throw new CliError(message); };

async function installSkill(flags) {
  if (flags.size !== 2 || !flags.has('--agent') || !flags.has('--project') ||
      !Object.hasOwn(agentDir, flags.get('--agent'))) invalid('invalid arguments');
  const project = flags.get('--project');
  if (!isAbsolute(project) || /[\u0000-\u001f\u007f]/.test(project)) invalid('invalid project directory');
  const root = resolve(project);
  // Examine each supplied path segment before normalization; resolving first would hide
  // a symlink followed by /.. and silently permit a different project.
  try {
    const parts = project.slice(parse(project).root.length).split(sep);
    let current = parse(project).root;
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') invalid('invalid project directory');
      current = join(current, part);
      if (!(await lstat(current)).isDirectory()) invalid('invalid project directory');
    }
    if ((await realpath(root)) !== root) invalid('invalid project directory');
  } catch (error) {
    if (error instanceof CliError) throw error;
    invalid('invalid project directory');
  }
  if (/[\u0000-\u001f\u007f]/.test(executable)) invalid('invalid installation path');
  const command = `'${executable.replaceAll("'", "'\\''")}'`;
  const source = await readFile(template, 'utf8');
  if (!source.includes('{{TRUSTGATE_CLI}}')) throw new Error('missing skill marker');
  const content = source.replaceAll('{{TRUSTGATE_CLI}}', command);

  let parent = root;
  for (const part of [agentDir[flags.get('--agent')], 'skills', 'trustgate']) {
    parent = join(parent, part);
    try {
      await mkdir(parent);
    } catch (error) {
      if (error?.code !== 'EEXIST') invalid('installation blocked');
    }
    try {
      if (!(await lstat(parent)).isDirectory() || (await realpath(parent)) !== parent) {
        invalid('installation blocked');
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      invalid('installation blocked');
    }
  }
  if ((await realpath(root)) !== root) invalid('installation blocked');
  // wx + O_NOFOLLOW prevents replacing a user's file or following a target symlink.
  let file;
  try {
    file = await open(join(parent, 'SKILL.md'), constants.O_CREAT | constants.O_EXCL |
      constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
  } catch {
    invalid('installation blocked');
  }
  try {
    await file.writeFile(content, 'utf8');
  } finally {
    await file.close();
  }
  process.stdout.write('trustgate: skill installed\n');
}

function validateServer(input) {
  const match = typeof input === 'string'
    ? /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(input)
    : null;
  if (!match || Number(match[1]) > 65_535) invalid('invalid server URL');
  return input;
}

function validateRepoPath(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512 ||
      /[\\\u0000-\u001f\u007f]/.test(input) || input.startsWith('/') || /^[A-Za-z]:/.test(input) ||
      input.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    invalid('invalid repository path');
  }
  return input;
}

const HELP = `TrustGate CLI (local server only)
Usage:
  trustgate scan --fixture [--server http://127.0.0.1:8787] [--timeout-ms 180000]
  trustgate scan --root [--server http://127.0.0.1:8787] [--timeout-ms 180000]
  trustgate scan --repo RELATIVE_PATH [--server http://127.0.0.1:8787] [--timeout-ms 180000]
  trustgate health [--server http://127.0.0.1:8787] [--timeout-ms 180000]
  trustgate skill install --agent codex|claude|cursor|hermes --project ABS_DIR
  trustgate --help
The operator must set TRUSTGATE_WORKSPACE_ROOT and have the server running before workspace scans.
--root scans that pinned project; --repo scans an authorized subdirectory. These flags do not authorize access.
Default timeout: 180000 ms; use --timeout-ms up to 300000 for slower authorized scans.
Hermes project skills also require: hermes skills trust ABS_DIR
`;

function parseFlags(args) {
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag.startsWith('--') || flags.has(flag)) invalid('invalid arguments');
    if (flag === '--fixture' || flag === '--root') {
      flags.set(flag, true);
    } else {
      if (i + 1 === args.length || args[i + 1].startsWith('--')) invalid('invalid arguments');
      flags.set(flag, args[++i]);
    }
  }
  return flags;
}

async function main(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (args[0] === 'skill' && args[1] === 'install') {
    return installSkill(parseFlags(args.slice(2)));
  }
  const command = args[0];
  if (command !== 'scan' && command !== 'health') invalid('invalid arguments');
  const flags = parseFlags(args.slice(1));
  if (command === 'scan') {
    if (['--fixture', '--root', '--repo'].filter((flag) => flags.has(flag)).length !== 1 ||
      [...flags.keys()].some((flag) => !['--fixture', '--root', '--repo', '--server', '--timeout-ms'].includes(flag))) {
      invalid('invalid arguments');
    }
  } else if ([...flags.keys()].some((flag) => !['--server', '--timeout-ms'].includes(flag))) {
    invalid('invalid arguments');
  }
  const server = validateServer(flags.get('--server') ?? 'http://127.0.0.1:8787');
  if (command === 'scan' && flags.has('--repo')) validateRepoPath(flags.get('--repo'));
  const timeoutInput = flags.get('--timeout-ms') ?? '180000';
  if (!/^[1-9][0-9]*$/.test(timeoutInput) || Number(timeoutInput) > 300_000) {
    invalid('invalid arguments');
  }
  const response = await fetch(`${server}${command === 'health' ? '/health' : '/api/runs'}`, {
    signal: AbortSignal.timeout(Number(timeoutInput)),
    redirect: 'manual',
    ...(command === 'health' ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(flags.has('--fixture')
        ? { source: 'fixture' }
        : { source: 'workspace', ...(flags.has('--repo') ? { repoPath: flags.get('--repo') } : {}) }),
    }),
  });
  if (response.status !== (command === 'health' ? 200 : 201)) throw new Error('server error');
  const maxBytes = 1_048_576;
  const chunks = [];
  let bytes = 0;
  if (!response.body) throw new Error('empty response');
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      throw new Error('response too large');
    }
    chunks.push(chunk);
  }
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (command === 'health' ?
    !(data && typeof data === 'object' && !Array.isArray(data) && data.ok === true) :
    !(data && typeof data === 'object' && !Array.isArray(data) &&
      typeof data.runId === 'string' && data.runId.length > 0 &&
      data.source === (flags.has('--fixture') ? 'fixture' : 'workspace') &&
      typeof data.regressionVerdict === 'string')) throw new Error('invalid response');
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`trustgate: ${error instanceof CliError ? error.message : 'request failed'}\n`);
  process.exitCode = 1;
}
