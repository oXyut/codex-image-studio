import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  Generator,
  Health,
  LineageCommit,
  LineageState,
  PublicFailure,
  Reference,
} from '../shared/types.js';
import type { publicJob, publicUpload } from '../src/http-app.js';
import type { LineageStore } from '../src/lineage-store.js';

export type TestAdapter = Generator & { health: () => Promise<Health> };
type PublicJob = ReturnType<typeof publicJob>;
export type TestJob = Omit<PublicJob, 'image' | 'references'> & {
  lineage: LineageCommit; lineageIntent?: never; lineageContext?: never;
  references?: (Reference & { path?: never })[];
  image: (NonNullable<PublicJob['image']> & { fileName?: never }) | null;
};
type PublicUpload = ReturnType<typeof publicUpload>;
export type TestUpload = PublicUpload & { lineage: LineageCommit; path?: never; image: PublicUpload['image'] & { path?: never; fileName?: never } };
export type ErrorBody = { error: PublicFailure };
export type BatchBody = { batchId: string; jobs: TestJob[] };
export type LineageBody = LineageState & { uploads: TestUpload[] };
export type TrashBody = { deletions: ReturnType<LineageStore['trash']> };
export type DeletionPlan = ReturnType<LineageStore['deletionPreview']>;
export type FailedPlan = ReturnType<LineageStore['failedDeletionPreview']>;
export type RestoreBody = Awaited<ReturnType<LineageStore['restore']>>;
export type DeleteBody = Awaited<ReturnType<LineageStore['softDelete']>>;

// HTTP JSON is untrusted; each call names the endpoint contract being tested.
export async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

export function serverPort(server: Server): number {
  return (server.address() as AddressInfo).port;
}

export function listen(server: Server): Promise<void> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
