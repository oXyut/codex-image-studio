export type View = "create" | "history" | "lineage" | "templates";
export type Reference = { jobId?: string; uploadId?: string; role: string };
export type Template = {
  id: string;
  name: string;
  body: string;
  category: string;
  tags: string[];
  favorite: boolean;
  version?: number;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt: string;
};
export type TemplateVersion = Template & {
  version: number;
  createdAt: string;
  operation?: string;
};
export type ImageSource = {
  id: string;
  kind?: "upload";
  name?: string;
  prompt?: string;
  basePrompt?: string;
  status: string;
  createdAt: string;
  size?: string;
  style?: string;
  transparent?: boolean;
  layers?: Template[];
  references?: Reference[];
  image?: {
    url: string;
    downloadUrl: string;
    width?: number;
    height?: number;
    bytes?: number;
    recovered?: boolean;
  };
  batch?: { id: string; index: number; count: number; deletedCount?: number };
  lineage?: {
    title?: string;
    notes?: string;
    branchId?: string;
    sourceJobId?: string;
    parentIds?: string[];
    operation?: string;
    [key: string]: unknown;
  };
  error?:
    | null
    | string
    | {
        message?: string;
        code?: string;
        details?: string;
        [key: string]: unknown;
      };
  errorDetails?: string;
  message?: string;
  [key: string]: unknown;
};
export type Draft = {
  prompt: string;
  layers: Template[];
  references: Reference[];
  count: number;
  size: string;
  style: string;
  transparent: boolean;
  lineageContext: {
    sourceJobId: string;
    operation: "derive" | "edit";
    newBranch: boolean;
  } | null;
};
export type Api = <T = any>(path: string, options?: RequestInit) => Promise<T>;
export type LineageMetadata = {
  commits: any[];
  branches: any[];
  uploads: ImageSource[];
};
export type StudioContextValue = {
  api: Api;
  jobs: ImageSource[];
  uploads: ImageSource[];
  templates: Template[];
  metadata: LineageMetadata;
  health: { ready: boolean; message: string; version?: string } | null;
  loading: boolean;
  loadingError: string;
  refresh: () => Promise<void>;
  refreshHealth: () => Promise<void>;
  draft: Draft;
  updateDraft: (change: Partial<Draft> | ((draft: Draft) => Draft)) => void;
  canUndo: boolean;
  undoDraft: () => void;
  draftSaved: boolean;
  view: View;
  navigate: (view: View, id?: string, batchId?: string) => void;
  selectedId: string | null;
  select: (id: string | null) => void;
  graphBatchId: string;
  setGraphBatchId: (id: string) => void;
  addReference: (source: ImageSource, role?: string) => boolean;
  addTemplate: (template: Template) => boolean;
  replaceFromSource: (source: ImageSource, derive?: boolean) => void;
  applyExample: (prompt: string) => void;
  generate: () => Promise<void>;
  submitting: boolean;
  retry: (source: ImageSource) => Promise<void>;
  cancel: (source: ImageSource) => Promise<void>;
  openPreview: (source: ImageSource) => void;
  requestDelete: (source: ImageSource) => void;
  openTrash: () => void;
  run: (action: () => Promise<unknown>) => Promise<void>;
};
