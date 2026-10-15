// Isolated transport smoke test against the already-built, unchanged Rust backend.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { loadSource } from './bundle.mjs';
const { AppServerConnection } = await loadSource('../electron/connection.ts');
const { backendEnvironment } = await loadSource('../electron/backend-environment.ts');
const patchWrapper = process.argv[2];
if (patchWrapper) await access(patchWrapper);
const home = await mkdtemp(path.join(tmpdir(), 'stressced-connection-test-'));
await writeFile(path.join(home, 'config.toml'), 'model = "local-test"\nmodel_provider = "llama_cpp"\n[model_providers.llama_cpp]\nname = "llama.cpp"\nbase_url = "http://127.0.0.1:8080/v1"\nwire_api = "chat"\n');
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const binary = path.resolve('dist-backend/codexstressced.exe');
const child = spawn(binary, ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
  windowsHide: true, env: backendEnvironment(binary, {
    ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: path.join(home, '.sqlite'), RUST_LOG: 'warn',
    ...(patchWrapper ? { APPLY_PATCH: path.resolve(patchWrapper) } : {}),
  }), stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', b => { logs += b; });
child.stderr.on('data', b => { logs += b; });
child.on('error', e => { logs += e.message; });
const statuses = [];
let connected;
const ready = new Promise(resolve => { connected = resolve; });
const connection = new AppServerConnection({
  endpoint: async () => `ws://127.0.0.1:${port}/rpc`,
  status: state => { statuses.push(state); if (state === 'connected') connected(); },
  notification() {}, tool: async () => ({}), retryMs: 200, connectTimeoutMs: 3000,
});
let timeout;
try {
  void connection.connect().catch(() => {});
  await Promise.race([ready, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Backend did not connect: ' + logs.slice(-2500))), 30000); })]);
  const result = await connection.request('thread/list', { limit: 10 });
  assert.deepEqual(result.data, []);
  console.log(JSON.stringify({ connected: true, isolatedPort: port, threadList: 'passed', statuses }));
  if (patchWrapper) {
    await writeFile(path.join(home, 'create.patch'), '*** Begin Patch\n*** Add File: scratch file.json\n+{"temporary":true}\n*** End Patch\n');
    await writeFile(path.join(home, 'delete.patch'), '*** Begin Patch\n*** Delete File: scratch file.json\n*** End Patch\n');
    await writeFile(path.join(home, 'check-wrapper.ps1'), `
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $env:CODEXSTRESSCED_EXE -PathType Leaf)) { throw 'Backend executable was not inherited' }
& $env:APPLY_PATCH -File './create.patch'
if ($LASTEXITCODE -ne 0) { throw 'Patch creation failed' }
if ((Get-Content -LiteralPath './scratch file.json' -Raw).Trim() -ne '{"temporary":true}') { throw 'Wrong patch content' }
& $env:APPLY_PATCH -File './delete.patch'
if ($LASTEXITCODE -ne 0) { throw 'Patch deletion failed' }
if (Test-Path -LiteralPath './scratch file.json') { throw 'Scratch file still exists' }
Write-Output $env:CODEXSTRESSCED_EXE
Write-Output 'wrapper-create-delete-passed'
`);
    const command = await connection.request('command/exec', {
      command: ['pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(home, 'check-wrapper.ps1')],
      cwd: home, sandboxPolicy: { type: 'dangerFullAccess' }, timeoutMs: 20000,
    });
    assert.equal(command.exitCode, 0, JSON.stringify(command));
    assert.ok(command.stdout.includes(binary), JSON.stringify(command));
    assert.ok(command.stdout.includes('wrapper-create-delete-passed'), JSON.stringify(command));
    console.log(JSON.stringify({ applyPatch: 'create/delete passed through app-server command/exec', fixture: home }));
  }
} finally {
  clearTimeout(timeout);
  connection.close();
  child.kill();
  await writeFile(path.join(home, 'smoke.log'), logs);
}
