// A /clear (or cancel) that lands while a turn is dispatching ask_question ends the session `failed`.
// Usage: node repro.mjs [--cancel] [--start] [--runs N]
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { Client } from "eve/client";

const args = process.argv.slice(2);
const action = args.includes("--cancel") ? "cancel" : "clear";
const mode = args.includes("--start") ? "start" : "dev";
const runs = args.includes("--runs") ? Number(args[args.indexOf("--runs") + 1]) : 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eve = new URL("./node_modules/eve/bin/eve.js", import.meta.url).pathname;
const env = { ...process.env, EVE_TELEMETRY_DISABLED: "1", NO_COLOR: "1" };

if (mode === "start") execFileSync(process.execPath, [eve, "build"], { env, stdio: "ignore" });
const port = await new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const server = spawn(process.execPath, [eve, mode, "--host", "127.0.0.1", "--port", String(port), ...(mode === "dev" ? ["--no-ui"] : [])], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-server.pid, "SIGKILL"); } catch {} };
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));

const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  if (i > 240 || server.exitCode !== null) throw new Error(`server did not start:\n${log}`);
  try { if ((await fetch(`${base}/eve/v1/health`)).ok) break; } catch {}
  await sleep(500);
}
const client = new Client({ baseUrl: base, host: base });

async function attempt() {
  const { session } = await client.sessions.create({ message: "start" });
  const events = [];
  const abort = new AbortController();
  const pump = (async () => {
    try { for await (const ev of session.stream({ startIndex: 0, signal: abort.signal })) events.push(ev); } catch {}
  })();
  const waitFor = async (pred, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) { const ev = events.find(pred); if (ev) return ev; }
    return null;
  };
  // 1. The model requests ask_question. 100 ms later, while eve is still dispatching it (the app's
  //    call.started hook takes 500 ms), the user sends /clear (or cancel).
  await waitFor((e) => e.type === "call.requested" && e.data?.capability?.name === "ask_question", 30_000);
  await sleep(100);
  await (action === "cancel" ? session.cancel() : session.clear());
  // 2. The turn settles cancelled. Give the ask tool-run a moment, then send the next message.
  const settled = await waitFor((e) => (e.type === "turn.settled" || e.type === "turn.paused") && e.data?.turnId === "turn_0", 30_000);
  await sleep(2000);
  const late = events.slice(events.indexOf(settled)).some((e) => e.type === "interaction.opened");
  await session.send("next");
  // 3. The next message should start a new turn. Instead the session ends failed.
  const end = await waitFor((e) => e.type === "session.ended" || (e.type === "turn.settled" && e.data?.turnId !== "turn_0"), 20_000);
  abort.abort();
  await Promise.race([pump, sleep(500)]);
  return { settled, late, end };
}

let failed = 0;
for (let i = 1; i <= runs; i++) {
  const { settled, late, end } = await attempt();
  const bad = end?.type === "session.ended" && end.data?.outcome === "failed";
  failed += bad;
  const first = `${settled?.type} ${settled?.data?.outcome ?? ""}`.trim();
  console.log(`run ${i}: turn_0 ${first}; interaction.opened after it: ${late}; next message -> ${end ? `${end.type} ${end.data?.outcome}` : "nothing within 20 s"}`);
  if (bad) console.log(`  ${JSON.stringify({ type: end.type, data: end.data })}`);
}
console.log(`\neve ${mode}, ${action}: ${failed}/${runs} sessions ended failed`);
const errors = [...new Set(log.split("\n").filter((l) => /HookNotFound|introduce-before-reference|workflow loop threw/.test(l)))];
if (errors.length) console.log(`server log:\n  ${errors.slice(0, 5).join("\n  ")}`);
process.exit(0);
