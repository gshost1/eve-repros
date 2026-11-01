import { definePlugin } from 'nitro';

// Start the World at boot so world-local recovers active runs after a
// restart (same as the workbench's start-pg-world plugin).
export default definePlugin(async () => {
  import('workflow/runtime').then(async ({ getWorld }) => {
    const world = await getWorld();
    await world.start?.();
  });
});
