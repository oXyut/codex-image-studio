/** Data contracts shared by the HTTP server, UI and persisted recipes. */
export type Reference = { jobId?: string; uploadId?: string; role: string };
export type TemplateFields = {
  name: string;
  body: string;
  category: string;
  tags: string[];
  favorite: boolean;
};
export type TemplateLayer = TemplateFields & { id: string; version?: number };
export type Template = TemplateLayer & {
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt: string;
};
export type StoredTemplate = Template & { version: number; createdAt: string; archivedAt: string | null };
export type TemplateVersion = TemplateLayer & {
  archivedAt: string | null;
  createdAt: string;
  updatedAt?: string;
  version: number;
  templateId: string;
  operation: string;
  revertedFrom?: number;
};
export type LineageContext = { sourceJobId: string; operation: 'derive' | 'edit'; newBranch: boolean };
export type LineageIntent = { sourceJobId: string | null; operation: string; newBranch: boolean };
export type GenerationInput = {
  prompt: string;
  size: string;
  style: string;
  transparent: boolean;
  basePrompt?: string;
  layers?: TemplateLayer[];
  references?: Reference[];
  lineageContext?: LineageContext;
  lineageIntent?: LineageIntent;
  batch?: Batch;
  favorite?: boolean;
};
export type Batch = { id: string; index: number; count: number; deletedCount?: number };
export type FailureCategory = 'unknown' | 'content' | 'usage' | 'auth' | 'transient' | 'timeout' | 'cancelled';
export type PublicFailure = {
  code: string;
  message: string;
  category?: FailureCategory;
  details?: string | null;
  advice?: string;
  retryable?: boolean;
};
export type StoredImage = {
  fileName: string;
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  revisedPrompt?: string | null;
  recovered?: boolean;
};
export type Job = GenerationInput & {
  id: string;
  kind?: never;
  status: string;
  favorite?: boolean;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  message: string;
  error: PublicFailure | null;
  image: StoredImage | null;
};
export type Upload = {
  id: string;
  kind: 'upload';
  status: 'uploaded';
  name: string;
  createdAt: string;
  image: StoredImage & {
    mime: string;
    bytes: number;
    width: number;
    height: number;
  };
};
export type LineageCommit = {
  jobId: string;
  branchId: string;
  parentIds: string[];
  sourceJobId: string | null;
  operation: string;
  title: string;
  notes: string;
  createdAt: string;
  recipeHash?: string;
};
export type LineageBranch = {
  id: string;
  name: string;
  headJobId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type Deletion = {
  id: string;
  rootId: string;
  title: string;
  deletedAt: string;
  restoredAt: string | null;
  nodeIds: string[];
  scope?: 'nodes';
  jobCount: number;
  uploadCount: number;
};
export type LineageState = { version: number; commits: LineageCommit[]; branches: LineageBranch[]; deletions: Deletion[] };
export type ImageSource = {
  id: string;
  kind?: 'upload';
  name?: string;
  prompt?: string;
  basePrompt?: string;
  status: string;
  favorite?: boolean;
  createdAt: string;
  size?: string;
  style?: string;
  transparent?: boolean;
  layers?: TemplateLayer[];
  references?: Reference[];
  image?: {
    url: string;
    downloadUrl: string;
    mime?: string;
    width?: number;
    height?: number;
    bytes?: number;
    recovered?: boolean;
  } | null;
  batch?: Batch;
  lineage?: Partial<LineageCommit> | null;
  error?: PublicFailure | string | null;
  errorDetails?: string;
  message?: string;
};
export type LineageMetadata = { commits: LineageCommit[]; branches: LineageBranch[]; uploads: ImageSource[] };
export type Health = {
  ready: boolean;
  message: string;
  version?: string | null;
  installed?: boolean;
  authenticated?: boolean;
  supportsImages?: boolean;
  auth?: string;
};
export type GenerationOptions = {
  workspace: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  referenceImages?: (Reference & { path: string })[];
};
export type Generator = {
  generate: (input: Job, options: GenerationOptions) => Promise<StoredImage>;
  health?: (force?: boolean) => Promise<Health>;
};
