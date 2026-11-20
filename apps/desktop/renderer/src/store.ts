import { create } from "zustand";

export const VIEW_IDS = [
  "home",
  "discover",
  "memories",
  "timeline",
  "analytics",
  "import",
  "movie-studio",
] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export interface UiState {
  readonly activeView: ViewId;
  readonly sidebarCollapsed: boolean;
  readonly activeDatasetId: string | null;
  readonly pendingFocusMessageId: string | null;
  readonly setActiveView: (view: ViewId) => void;
  readonly toggleSidebar: () => void;
  readonly setActiveDataset: (datasetId: string | null) => void;
  readonly setPendingFocusMessageId: (messageId: string | null) => void;
}

/** Serializable UI state only: no handles, functions-as-data, or domain records. */
export const createUiStore = () =>
  create<UiState>()((set) => ({
    activeView: "home",
    sidebarCollapsed: false,
    activeDatasetId: null,
    pendingFocusMessageId: null,
    setActiveView: (activeView) => {
      set({ activeView });
    },
    toggleSidebar: () => {
      set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
    },
    setActiveDataset: (datasetId) => {
      set({ activeDatasetId: datasetId });
    },
    setPendingFocusMessageId: (messageId) => {
      set({ pendingFocusMessageId: messageId });
    },
  }));

export const useUiStore = createUiStore();

export function snapshotUiState(
  state: UiState,
): Pick<UiState, "activeView" | "sidebarCollapsed" | "activeDatasetId" | "pendingFocusMessageId"> {
  return {
    activeView: state.activeView,
    sidebarCollapsed: state.sidebarCollapsed,
    activeDatasetId: state.activeDatasetId,
    pendingFocusMessageId: state.pendingFocusMessageId,
  };
}