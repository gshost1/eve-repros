// Bug B repro: Workflow SDK 5.2.3 + world-local 5.1.2 (Nitro, `nitro build`).
//
//   npm install
//   node repro.mjs [--n 10] [--random] [--keep]
//
// (The first run builds the app with `npx nitro build`.)
//
// Each trial, in a fresh data dir:
//   1. start the server; POST /api/start runs `reproWorkflow` (4 createHook
//      + await getConflict()).
//   2. the server dies by SIGKILL while those 4 hook_created writes are in
//      flight. Default: at the kill point in kill-point.mjs (deterministic).
//      --random: a plain SIGKILL at a random 0-30 ms (RANDOM_MAX_MS) after
//      the run_created event appears on disk; no preload.
//   3. restart the server (no preload). world-local recovers the run.
//   4. wait for the run to reach a terminal status and print it.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const n = Number(args[args.indexOf('--n') + 1]) || (args.includes('--n') ? 10 : 1);
const random = args.includes('--random');
const keep = args.includes('--keep');
const RANDOM_MAX_MS = Number(process.env.RANDOM_MAX_MS ?? 30);
const PORT = 39100 + Math.floor(Math.random() * 800);
const DEBUG_ENV = { DEBUG: 'workflow:*', WORKFLOW_LOG_LEVEL: 'debug' };

if (!fs.existsSync(path.join(here, '.output/server/index.mjs'))) {
  execSync('npx nitro build', { cwd: here, stdio: 'inherit' });
}

// Build workaround (separate issue): in a `nitro build` output, world-local's
// getPackageInfo() looks for ../package.json next to the bundled chunk, finds
// none, falls back to version "bundled", and world.start() then throws
// `Invalid version string: "bundled"` (so active runs are never recovered).
// Give it the package.json it looks for.
const shim = path.join(here, '.output/server/_libs/package.json');
if (!fs.existsSync(shim)) {
  fs.writeFileSync(shim, JSON.stringify({ name: '@workflow/world-local', version: '5.1.2' }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tally = { maxDeliveries: 0, completed: 0, other: 0, noKill: 0 };

for (let i = 1; i <= n; i++) {
  const dir = fs.mkdtempSync(path.join(here, '.trial-'));
  const res = await trial(dir, i);
  console.log(
    `trial ${i}/${n}: kill=${res.kill}${res.delay !== undefined ? ` delay=${res.delay.toFixed(1)}ms` : ''} run=${res.runId ?? '-'} status=${res.status ?? '-'}` +
      `${res.errorCode ? ` errorCode=${res.errorCode}` : ''}` +
      ` attempts="${res.attempts ?? ''}" hookAlreadyExists=${res.already} awaitedReinvokes=${res.awaited} ${res.ms}ms`
  );
  if (res.kill !== 'yes' || !res.runId) tally.noKill++;
  else if (res.errorCode === 'MAX_DELIVERIES_EXCEEDED') tally.maxDeliveries++;
  else if (res.status === 'completed') tally.completed++;
  else tally.other++;
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
}
console.log(
  `\nRESULT: ${tally.maxDeliveries}/${n} MAX_DELIVERIES_EXCEEDED, ${tally.completed} completed, ` +
    `${tally.other} other, ${tally.noKill} where the kill did not land (mode=${random ? 'random' : 'kill-point'})`
);

async function trial(dir, i) {
  const t0 = Date.now();
  const log1 = path.join(dir, 'server-1.log');
  const log2 = path.join(dir, 'server-2.log');
  const port = PORT + i;
  // 1-2: first server, killed mid-suspension
  const s1 = server(dir, port, log1, random ? [] : ['--import', path.join(here, 'kill-point.mjs')]);
  await waitListening(log1);
  const startRes = fetch(`http://localhost:${port}/api/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `t${i}-${Date.now()}` }),
  }).catch(() => null);
  let delay;
  if (random) {
    // Timer kill measured from the run's first event (run_created) on disk,
    // not from the request: the window is the few ms of the first
    // suspension's hook writes, about 15-20 ms after run_created here.
    const tw = Date.now();
    while (!hasFirstEvent(dir) && Date.now() - tw < 10000) {
      await new Promise((r) => setImmediate(r));
    }
    delay = Math.random() * RANDOM_MAX_MS;
    const tk = performance.now();
    while (performance.now() - tk < delay) await new Promise((r) => setImmediate(r));
    s1.proc.kill('SIGKILL');
  }
  const exit1 = await Promise.race([s1.exited, sleep(10000).then(() => 'timeout')]);
  await startRes;
  if (exit1 === 'timeout') s1.proc.kill('SIGKILL');
  await s1.exited;
  const kill = exit1 === 'SIGKILL' ? 'yes' : `no(${exit1})`;
  const runId = readRuns(dir)[0]?.runId;
  if (!runId) return { kill: 'before-run', delay, already: 0, awaited: 0, ms: Date.now() - t0 };

  // 3-4: restart and wait for a terminal status
  const s2 = server(dir, port, log2, []);
  let run;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await sleep(500);
    run = readRuns(dir).find((r) => r.runId === runId);
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) break;
  }
  s2.proc.kill('SIGKILL');
  await s2.exited;
  const l2 = fs.existsSync(log2) ? fs.readFileSync(log2, 'utf8') : '';
  return {
    kill,
    delay,
    runId,
    status: run?.status,
    errorCode: run?.errorCode ?? run?.error?.code,
    attempts: (l2.match(/exceeded max deliveries \(\d+\/\d+\)/) ?? [''])[0],
    already: (l2.match(/Hook already exists, continuing/g) ?? []).length,
    awaited: (l2.match(/hasAwaitedHookCreation: true/g) ?? []).length,
    ms: Date.now() - t0,
  };
}

function server(dir, port, logFile, nodeArgs) {
  const out = fs.openSync(logFile, 'w');
  const proc = spawn(process.execPath, [...nodeArgs, path.join(here, '.output/server/index.mjs')], {
    cwd: dir,
    env: { ...process.env, ...DEBUG_ENV, PORT: String(port) },
    stdio: ['ignore', out, out],
  });
  const exited = new Promise((r) => proc.on('exit', (code, sig) => r(sig ?? code)));
  return { proc, exited };
}

async function waitListening(logFile) {
  for (let k = 0; k < 200; k++) {
    if (fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('Listening on')) return;
    await sleep(50);
  }
  throw new Error(`server did not start: ${logFile}`);
}

function hasFirstEvent(dir) {
  const eventsDir = path.join(dir, '.workflow-data', 'events');
  if (!fs.existsSync(eventsDir)) return false;
  return fs.readdirSync(eventsDir).some((r) => {
    try {
      return fs.readdirSync(path.join(eventsDir, r)).some((f) => f.endsWith('1.json'));
    } catch {
      return false;
    }
  });
}

function readRuns(dir) {
  const runsDir = path.join(dir, '.workflow-data', 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
