import { batchVisibility } from './deletion-ui.js';

const batchId = job => typeof job.batch?.id === 'string' && Number.isSafeInteger(job.batch.count) && job.batch.count > 1 ? job.batch.id : null;

// Request IDs identify a batch. Completion times and shared references do not.
export function groupGenerationHistory(jobs, allJobs = jobs) {
  const allBatches = new Map();
  for (const job of allJobs) {
    const id = batchId(job); if (!id) continue;
    if (!allBatches.has(id)) allBatches.set(id, []);
    allBatches.get(id).push(job);
  }
  const groups = [], batches = new Map();
  for (const job of jobs) {
    const id = batchId(job);
    if (id) {
      if (!batches.has(id)) {
        const members = allBatches.get(id) || jobs.filter(value => batchId(value) === id);
        const { total, deleted, missing } = batchVisibility(members);
        const createdAt = members.map(value => value.createdAt).filter(Boolean).sort()[0];
        const group = { kind: 'batch', id, jobs: [], total, deleted, missing, retained: members.length, createdAt };
        batches.set(id, group); groups.push(group);
      }
      batches.get(id).jobs.push(job);
    } else {
      const last = groups.at(-1);
      if (last?.kind === 'single') last.jobs.push(job);
      else groups.push({ kind: 'single', id: job.id, jobs: [job] });
    }
  }
  for (const group of batches.values()) group.jobs.sort((a, b) => a.batch.index - b.batch.index || a.id.localeCompare(b.id));
  return groups;
}
