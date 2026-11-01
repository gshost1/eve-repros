// Preloaded with `node --import ./kill-point.mjs` for the first server only.
// It does not change world-local; it only chooses WHEN the process dies.
//
// Kill point: the moment one hook's `hook_created` is published at slot N
// while another hook of the same run already has its token claim on disk
// recording that same slot N and has not published its own event yet. That
// is the window between world-local's claim write and its event publish
// (events-storage.ts, hook_created path). The process is SIGKILLed right
// after the publishing link() returns.
import fs from 'node:fs';
import path from 'node:path';

const fsp = fs.promises;
const realLink = fsp.link.bind(fsp);

fsp.link = async (src, dst) => {
  const r = await realLink(src, dst);
  const d = path.resolve(String(dst));
  const m = d.match(/^(.*)[\\/]events[\\/](wrun_[^\\/]+)[\\/]\2-(evnt_\d+)\.json$/);
  if (!m) return r;
  const [, dataDir, runId, eventId] = m;
  let ev;
  try {
    ev = JSON.parse(fs.readFileSync(d, 'utf8'));
  } catch {
    return r;
  }
  if (ev.eventType !== 'hook_created') return r;
  const tokensDir = path.join(dataDir, 'hooks', 'tokens');
  let victim;
  for (const f of fs.existsSync(tokensDir) ? fs.readdirSync(tokensDir) : []) {
    if (!f.endsWith('.json')) continue;
    let c;
    try {
      c = JSON.parse(fs.readFileSync(path.join(tokensDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (c.runId === runId && c.eventId === eventId && c.hookId !== ev.correlationId) {
      victim = c.hookId;
      break;
    }
  }
  if (victim) {
    process.stderr.write(
      `[kill-point] ${ev.correlationId} published at ${eventId}; claim of ${victim} also records ${eventId} and is unpublished; SIGKILL\n`
    );
    process.kill(process.pid, 'SIGKILL');
  }
  return r;
};
