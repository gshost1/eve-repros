// Repro for bug B at the World level: @workflow/world-local 5.1.2, no eve,
// no workflow runtime. It does what core's suspension handler does when a
// workflow suspends on several new hooks: concurrent `hook_created` writes
// for different tokens (runtime/suspension-handler.ts, "token groups are
// processed in parallel"). The process is SIGKILLed after one hook's token
// claim is written and before that hook's event is published. A fresh
// process then retries that hook's `hook_created`, as replay does.
//
//   node world-repro.mjs                 # injected kill point (deterministic)
//   node world-repro.mjs --random 20     # timer SIGKILL at a random moment
//
// The result is printed as one line per trial plus a summary.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = ['A', 'B', 'C', 'D'];
const tokenOf = (h) => `repro-b:token:${h}`;
const hookIdOf = (h) => `hook_REPRO${h}`;

const args = process.argv.slice(2);

if (args[0] === '--child') {
  await child(args[1], args[2], Number(args[3] ?? 0));
} else {
  await main();
}

// ---------- child: create run, then 4 concurrent hook_created ----------
async function child(dataDir, mode, delayMs) {
  const { createWorld } = await import('@workflow/world-local');
  const world = createWorld({ dataDir, recoverActiveRuns: false });

  if (mode === 'inject') {
    // Kill point: right after hook B's token claim lands, before B's
    // `hook_created` is published. To make B's drawn slot collide, hold B's
    // claim link until hook A's event has been published (both drew the same
    // slot because a draw that has not published does not move the
    // watermark: world-local events-storage `drawEventSlot`).
    const { createHash } = await import('node:crypto');
    const fsp = fs.promises;
    const realLink = fsp.link.bind(fsp);
    const claimB = createHash('sha256').update(tokenOf('B')).digest('hex');
    fsp.link = async (src, dst) => {
      if (String(dst).includes(`${path.sep}tokens${path.sep}`) &&
          String(dst).includes(claimB.slice(0, 16))) {
        await waitFor(() => findHookCreated(dataDir, hookIdOf('A')));
        const r = await realLink(src, dst);
        process.kill(process.pid, 'SIGKILL');
        return r;
      }
      return realLink(src, dst);
    };
  }

  const run = await world.events.create(null, {
    eventType: 'run_created',
    specVersion: 3,
    eventData: {
      deploymentId: 'repro',
      workflowName: 'repro-b',
      input: new Uint8Array(),
    },
  });
  const runId = run.run?.runId ?? run.event.runId;
  fs.writeFileSync(path.join(dataDir, 'RUN_ID'), runId);
  await world.events.create(runId, { eventType: 'run_started', specVersion: 3 });

  if (mode === 'random') setTimeout(() => process.kill(process.pid, 'SIGKILL'), delayMs);

  await Promise.allSettled(HOOKS.map((h) => createHook(world, runId, h)));
  fs.writeFileSync(path.join(dataDir, 'CHILD_DONE'), '1');
  process.exit(0);
}

function createHook(world, runId, h) {
  return world.events.create(runId, {
    eventType: 'hook_created',
    correlationId: hookIdOf(h),
    specVersion: 3,
    eventData: { token: tokenOf(h) },
  });
}

// ---------- parent ----------
async function main() {
  const randomIdx = args.indexOf('--random');
  const trials = randomIdx >= 0 ? Number(args[randomIdx + 1] ?? 20) : Number(args[args.indexOf('--n') + 1] || 1);
  const mode = randomIdx >= 0 ? 'random' : 'inject';
  let wedged = 0;
  let completed = 0;
  for (let i = 0; i < trials; i++) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-b-'));
    const delay = mode === 'random' ? 2 + Math.floor(Math.random() * 40) : 0;
    const code = await runChild(dataDir, mode, delay);
    const r = await resume(dataDir);
    if (fs.existsSync(path.join(dataDir, 'CHILD_DONE'))) completed++;
    if (r.wedged.length) wedged++;
    console.log(
      `trial ${i + 1}/${trials} mode=${mode}${mode === 'random' ? ` delay=${delay}ms` : ''} child=${code}` +
        ` log=[${r.log.join(' ')}]` +
        (r.wedged.length ? ` WEDGED ${r.wedged.map((w) => `${w.hook}(claim->${w.claimEventId}, occupant=${w.occupant}, ${w.attempts}x "${w.error}")`).join('; ')}` : ' ok')
    );
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`\nRESULT: ${wedged}/${trials} trials left a hook that can never be created (mode=${mode}; ${completed} children finished before the kill)`);
}

function runChild(dataDir, mode, delay) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', dataDir, mode, String(delay)], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    p.on('exit', (code, sig) => resolve(sig ?? code));
  });
}

// Fresh process state (new World instance) on the same data dir: retry the
// `hook_created` of every hook whose event is missing, the way replay does on
// each delivery. 49 tries = core's delivery cap (48) + 1.
async function resume(dataDir) {
  const { createWorld } = await import(`@workflow/world-local?${Math.random()}`).catch(() => import('@workflow/world-local'));
  const world = createWorld({ dataDir, recoverActiveRuns: false });
  const runIdFile = path.join(dataDir, 'RUN_ID');
  if (!fs.existsSync(runIdFile)) return { log: ['no-run'], wedged: [] };
  const runId = fs.readFileSync(runIdFile, 'utf8');
  const wedged = [];
  for (const h of HOOKS) {
    if (findHookCreated(dataDir, hookIdOf(h))) continue;
    const claim = readClaim(dataDir, h);
    if (!claim) continue; // never claimed: a retry is a clean first create
    let attempts = 0;
    let error = '';
    for (let i = 0; i < 49; i++) {
      try {
        await createHook(world, runId, h);
        break;
      } catch (e) {
        attempts++;
        error = String(e.message);
      }
    }
    if (attempts === 49 && !findHookCreated(dataDir, hookIdOf(h))) {
      const occ = readEvent(dataDir, runId, claim.eventId);
      wedged.push({
        hook: h,
        claimEventId: claim.eventId,
        occupant: occ ? `${occ.eventType}:${occ.correlationId ?? ''}` : 'none',
        attempts,
        error,
      });
    }
  }
  return { log: listLog(dataDir, runId), wedged };
}

// ---------- on-disk helpers (read-only) ----------
function eventsDir(dataDir) {
  return path.join(dataDir, 'events');
}
function allEventFiles(dataDir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json') && !e.name.includes('.tmp')) out.push(p);
    }
  };
  walk(eventsDir(dataDir));
  return out;
}
function parse(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
function findHookCreated(dataDir, hookId) {
  return allEventFiles(dataDir).some((p) => {
    const e = parse(p);
    return e?.eventType === 'hook_created' && e.correlationId === hookId;
  });
}
function readEvent(dataDir, runId, eventId) {
  const p = allEventFiles(dataDir).find((f) => path.basename(f).startsWith(`${runId}-${eventId}`));
  return p ? parse(p) : null;
}
function listLog(dataDir, runId) {
  return allEventFiles(dataDir)
    .map(parse)
    .filter((e) => e && e.runId === runId)
    .sort((a, b) => (a.eventId < b.eventId ? -1 : 1))
    .map((e) => `${e.eventId.replace(/^evnt_0+/, '')}:${e.eventType.replace('_created', '+').replace('_started', '>')}${e.correlationId ? '/' + e.correlationId.replace('hook_REPRO', '') : ''}`);
}
function readClaim(dataDir, h) {
  const dir = path.join(dataDir, 'hooks', 'tokens');
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const c = parse(path.join(dir, f));
    if (c?.token === tokenOf(h)) return c;
  }
  return null;
}
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 1));
  }
}
