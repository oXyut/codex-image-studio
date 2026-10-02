import type { Batch } from './types.js';
export function batchVisibility(jobs: { batch?: Partial<Batch> }[]) {
  const total = jobs[0]?.batch?.count ?? jobs.length;
  const deleted = Math.max(0, ...jobs.map(job => Number.isSafeInteger(job.batch?.deletedCount) ? job.batch!.deletedCount! : 0));
  return { total, deleted, missing: Math.max(0, total - jobs.length - deleted) };
}
