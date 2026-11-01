import { createHook } from 'workflow';

// Four hooks with different tokens, created in one suspension, and awaited
// with getConflict(): the same shape as eve's subagent session start
// (two abort hooks, the session inbox hook, the subagent inbox hook).
export async function reproWorkflow(id: string) {
  'use workflow';
  const hooks = ['a', 'b', 'c', 'd'].map((k) =>
    createHook({ token: `repro-b:${id}:${k}` })
  );
  const conflicts = await Promise.all(hooks.map((h) => h.getConflict()));
  return { created: conflicts.filter((c) => c === null).length };
}
