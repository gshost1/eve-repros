import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Do something quick.",
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});
