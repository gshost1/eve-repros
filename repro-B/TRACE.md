# Bug B: trace

**Conclusion.** The root cause is in **world-local's `hook_created` write**, not in core replay. The earlier triage reading in `triage.md` §6 / (b), "core replay never folds the hook's own pre-crash `hook_created`", is **wrong**:

- The event in slot 003 belongs to a **different** hook than the one being retried.
- The retried hook has **no** `hook_created` anywhere in the log. Core's "Hook already exists, continuing" is acting on a false "already exists" from world-local.

Core's 0 s re-invoke loop turns that into `MAX_DELIVERIES_EXCEEDED`.

Reproduced without eve: `repro-B/repro.mjs` uses plain Workflow SDK 5.2.3 with world-local 5.1.2. It fails 10/10 with an injected kill point, which only picks the moment of the SIGKILL, and 6/30 with a plain random SIGKILL and no injection. The InstaBox world states confirm the same on-disk shape in all 4 B hits (`repro-B/instabox-claims.txt`).

Code refs are to tag `@workflow/core@5.2.3` = `@workflow/world-local@5.1.2` = commit `d9bcbf62d39a61eac070ca67111b90c425e04d05` (both tags point to it). The same code is on `main` at `44d7c76` (2026-10-30); I did not run the repro against `main`.

## Mechanism

1. **Concurrent hook writes.** A suspension with several new hooks, each on its own token, writes their `hook_created` events in parallel. See `packages/core/src/runtime/suspension-handler.ts:675-693`: "Different tokens have no claim interaction, so token groups are processed in parallel". eve's subagent session start is such a suspension: two `abrt_…` abort hooks, the session inbox hook and the subagent inbox hook, all awaited with `getConflict()`.
2. **They all draw the same slot.** `events.create()` draws the event id first (`world-local/src/storage/events-storage.ts:1400`, `eventId = await mintEventId(runId)`). `drawEventSlot` (`:765-797`) hands out `published + 1`. A draw that has not published does not move the watermark (`:800-803`: "Only a committed publish moves the watermark"). So four concurrent writes on a fresh run all draw `evnt_…003`.
3. **Each hook's token claim records that slot.** The claim file `hooks/tokens/<sha256(token)>.json` is written before the event is published, with `eventId` set to the drawn slot (`:2571-2579` `claimContent()`, `:2605` `writeExclusive`). One writer wins slot 003. The others lose the exclusive link and bump to 004, 005 and so on (`bumpEventSlot`, `:3306-3330`). **The claim is not rewritten with the bumped id.** The `hook_received` resume claim is corrected after a bump (`:3590-3618`); the hook token claim is not.
4. **The crash.** A SIGKILL between a hook's claim write and its event publish leaves a claim that says `{hookId: H, eventId: evnt_…003}`, with no `hook_created` for H anywhere, and slot 003 held by another hook's `hook_created`.
5. **Every retry is pinned to the taken slot.** After restart, replay re-creates H. The claim lock finds the claim with the same run and the same hook, so the status is `owned` (`:2608-2613`). The owned path adopts the claim's id as canonical and **pins** it (`:2889-2938`: `eventId = canonicalEventId; eventIdPinned = true`). The code comment there states the assumption that breaks: "A collision here means the canonical event is already published". In the publish loop:
   - slot 003 is occupied;
   - the same-hook convergence check fails, because the occupant's `correlationId` is a different hook (`:3537-3553`);
   - `bumpEventSlot` refuses, because the id is pinned (`:3308`);
   - so `eventPublished` stays false, and it throws `EntityConflictError('Event "evnt_…003" already exists for run …')` (`:3585-3587`).

   The same happens on every retry, forever.
6. **Core trusts the conflict and spins.** `suspension-handler.ts:439-449` maps `EntityConflictError` to "Hook already exists, continuing" and returns `hasAwaitedHookCreation: queueItem.hasConflictAwaiter === true`. The hook is awaited via `getConflict()`, so `runtime.ts:4563-4574` does one in-process continue (`continueOverHookWrite`), then `return await reinvoke(0)`. There is no progress check. world-local counts each re-invoke as a delivery, and core fails the run at attempt 49 (`runtime.ts:892-895`, `MAX_QUEUE_DELIVERIES = 48` in `runtime/constants.ts:28`).

Side note: `hook_received` already avoids this. Its resume claim is pinned only for ULID ids (`:1755-1769`: `eventIdPinned = !isSlotEventId(eventId)`, "A slot is a position, not a name"). It identifies its own event by `resumeId` and rewrites the claim after a bump. `hook_created`'s owned path has neither.

## Event log before and after the crash (debug-logged eve replay, seed 4863)

`keep-HIT-A-1/server-2.log` (laptop), child `workflowEntry` `wrun_01M6959H7X8P1VWM4ANKTXWSEV`. That run kept only logs, not its world state, so the slot contents below come from the replay's event processing order. The InstaBox hits further down have the files themselves.

| slot | event | written |
|---|---|---|
| 001 | `run_created` | pre-kill |
| 002 | `run_started` | pre-kill |
| 003 | `hook_created` `hook_…G4` | pre-kill |
| 004 | `hook_created` `hook_…G5` (token `eve:inbox:v1:eve:session:wrun_…SEV:inbox`) | pre-kill |
| 005 | `hook_created` `hook_…G2` | pre-kill |
| — | **no `hook_created` for `hook_…G6`** (token `eve:inbox:v1:subagent:wrun_…KAJB9:0`) | — |
| 006–011 | `step_created`/`started`/`completed` × 2 (`createSessionStep` `…G0`, `resolveInitialTurnCallerStep` `…G7`) | post-restart, pass 1 |

What each pass does:
- **Pass 1** (`loopIteration: 1`, `eventCount: 5`, replay): it consumes 003–005 without error. It suspends with `steps: 2, hooks: 4`. The hook write: one `Hook already exists, continuing … Event "evnt_…003" already exists`. Steps are queued; `hasAwaitedHookCreation: false` (steps pending).
- **Pass 2** (`eventCount: 11`, retained VM): steps folded; suspends `steps: 0, hooks: 4`. The hook write fails again on `evnt_…003`, now with `hasAwaitedHookCreation: true`. Then `Continuing over a hook write in-process { hookIds: ['hook_…G6'] }`, which **names G6 as the awaited hook**. The incremental reload returns `totalEvents: 0`.
- **Pass 3**: same suspension, same conflict, so `reinvoke(0)`. A new delivery replays from scratch (`eventCount: 11`), and the cycle repeats.
- **Totals**: 97 × "Hook already exists" (all `evnt_…003`), 96 × `hasAwaitedHookCreation: true`, 48 × in-process continue for `hook_…G6`. It ends at `Workflow handler exceeded max deliveries (49/48)` → `MAX_DELIVERIES_EXCEEDED`.
- **Why this is G6 and not a fold miss on G4**: only **one** hook write fails per pass. If G4, G5 or G2 were unfolded, they would be retried too. The event count never grows past 11, so G6's `hook_created` is never written. 0 "Replay divergence" and 0 "Replay could not consume event" lines: replay consumed every event it was given.

## On-disk confirmation (InstaBox run 3, world state kept)

`repro-B/claims.py` over `instabox-run3/runs/<seed>/eve-state/.workflow-data`; full output in `repro-B/instabox-claims.txt`. In each of the 4 B hits, the failed child `workflowEntry` has **every** hook token claim at `eventId = …003`. Each hook missing from the log has a claim pointing at a slot that a different hook holds:

| seed | slot 003 holds | claims at 003 with no `hook_created` | other evidence |
|---|---|---|---|
| 4000502 | `…3864` | `…3863` (session inbox), `…3862` (abort) | `…3860` published at **004**, claim still says 003 (claim not rewritten after bump) |
| 4000883 | `…DEPQ` | `…DEPS` (abort), `…DEPT` (session inbox) | `…DEPV` published at 004, claim says 003 |
| 4001982 | `…XA89` | `…XA8A` (session inbox), `…XA8B` (subagent inbox), `…XA87` (abort) | **4 leftover staged `.tmp` files at slot 003**, one per hook: all four drew 003 |
| 4001983 | `…JEGH` | `…JEGE`, `…JEGG` (abort), `…JEGJ` (subagent inbox) | two 0-byte `.tmp` at 004 |

All 4 end `MAX_DELIVERIES_EXCEEDED` (49/48).

## Repro results

- **Full Workflow repro, no eve** (`repro-B/repro.mjs`: Nitro + `workflow@5.2.3`, world-local 5.1.2). The workflow is 4 × `createHook` plus `await Promise.all(hooks.map(h => h.getConflict()))`.
  - Kill point (`kill-point.mjs`, preloaded only in the first server): SIGKILL right after one hook's `hook_created` link while another hook's claim records the same slot. The restarted server recovers the run.
  - **10/10** `failed` / `MAX_DELIVERIES_EXCEEDED` (49/48), each 1.2–1.4 s after restart.
  - Each trial logs 288 "Hook already exists" (3 wedged hooks × 96) and 96 `hasAwaitedHookCreation: true`.
  - The post-kill disk state matches 4001982: four staged `.tmp` files at 003, one published.
- **World-level repro** (`repro-B/world-repro.mjs`: `@workflow/world-local@5.1.2` only; 4 concurrent `hook_created` writes, as core issues them).
  - Injected kill point: 1/1 wedged, and all 49 retries fail with the exact eve log string.
  - **No injection, timer SIGKILL at 2–41 ms: 5/30 trials** left a hook that can never be created. 7 of the 30 kills landed before the writes finished, and 5 of those 7 wedged. The other 23 children finished first.
- **Full app, no injection** (`node repro.mjs --n 30 --random`: plain SIGKILL at a random 0–30 ms after `run_created` lands on disk): **6/30** `MAX_DELIVERIES_EXCEEDED`, 24/30 completed (`repro-B/results-random.txt`). The hits cluster at 15–22 ms, which is the hook-write window.

## Fix hypothesis (untested)

1. **world-local (root cause).** In the `owned` path, treat a slot id the way the `hook_received` claim does.
   - If the claim's slot holds this hook's own `hook_created`, it is a true duplicate: keep the conflict.
   - If the slot holds a different event, look for this hook's `hook_created` elsewhere (`findExistingHookCreatedEventId` already exists). If there is none, the creation never committed: publish with a fresh slot (unpinned) and rewrite the claim's `eventId`.
   - Also rewrite the claim after a bumped publish, as the resume claim already does.
2. **Core (defence in depth).** "Hook already exists" plus `hasAwaitedHookCreation` currently trusts the conflict. If the next replay still has no `hook_created` for that correlation id, fail with a clear error (or back off) instead of `reinvoke(0)` into the delivery cap.
3. **eve (separate, draft C).** `task_wait` should settle when the child session ends `failed`.

## Side finding (not B)

In a `nitro build` output, world-local's `getPackageInfo()` reads `../package.json` next to the bundled chunk. It finds none and falls back to version `"bundled"`. `world.start()` then throws `Invalid version string: "bundled"` (unhandled rejection), so active runs are not recovered after a restart. `repro.mjs` writes a small `package.json` shim to work around it. This may be worth its own small issue.
