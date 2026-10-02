import type {
  Health,
  ImageSource,
  LineageMetadata,
  Reference,
  Template,
  TemplateLayer,
} from '@shared/types.js';
export type { ImageSource,LineageMetadata,Reference,Template,TemplateLayer,TemplateVersion } from '@shared/types.js';
export type View = "create" | "history" | "lineage" | "templates";
export type Draft = {
  prompt: string;
  layers: TemplateLayer[];
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
export type Api = <T = unknown>(path: string, options?: RequestInit) => Promise<T>;
export type StudioContextValue = {
  api: Api;
  jobs: ImageSource[];
  uploads: ImageSource[];
  templates: Template[];
  metadata: LineageMetadata;
  health: Health | null;
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
  addTemplate: (template: TemplateLayer) => boolean;
  replaceFromSource: (source: ImageSource, derive?: boolean) => void;
  applyExample: (prompt: string) => void;
  generate: () => Promise<void>;
  submitting: boolean;
  retry: (source: ImageSource) => Promise<void>;
  cancel: (source: ImageSource) => Promise<void>;
  setFavorite: (source: ImageSource, favorite: boolean) => Promise<void>;
  favoritePendingIds: string[];
  openPreview: (source: ImageSource) => void;
  requestDelete: (source: ImageSource) => void;
  openTrash: () => void;
  run: (action: () => Promise<unknown>) => Promise<void>;
};
