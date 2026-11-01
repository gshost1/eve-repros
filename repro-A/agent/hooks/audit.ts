import { defineHook } from "eve/hooks";

// Stands in for any slow authored hook (an audit log write, a metrics call).
export default defineHook({
  events: {
    async "call.started"() {
      await new Promise((r) => setTimeout(r, Number(process.env.HOOK_MS ?? 500)));
    },
  },
});
