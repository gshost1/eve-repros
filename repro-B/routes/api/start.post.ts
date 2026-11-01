import { start } from 'workflow/api';
import { reproWorkflow } from '../../workflows/repro.js';

export default async ({ req }: { req: Request }) => {
  const { id } = await req.json();
  const run = await start(reproWorkflow, [id]);
  return Response.json({ runId: run.runId });
};
