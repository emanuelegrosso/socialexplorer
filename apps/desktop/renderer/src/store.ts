import { create } from "zustand";

export const VIEW_IDS = ["discover", "analytics", "memories", "movie-studio", "import", "settings"] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export interface UiState {
  readonly activeView: ViewId;
  readonly sidebarCollapsed: boolean;
  readonly activeDatasetId: string | null;
  readonly setActiveView: (view: ViewId) => void;
  readonly toggleSidebar: () => void;
  readonly setActiveDataset: (datasetId: string | null) => void;
}

/** Serializable UI state only: no handles, functions-as-data, or domain records. */
export const createUiStore = () =>
  create<UiState>()((set) => ({
    activeView: "discover",
    sidebarCollapsed: false,
    activeDatasetId: null,
    setActiveView: (activeView) => {
      set({ activeView });
    },
    toggleSidebar: () => {
      set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
    },
    setActiveDataset: (datasetId) => {
      set({ activeDatasetId: datasetId });
    },
  }));

export const useUiStore = createUiStore();

export function snapshotUiState(
  state: UiState,
): Pick<UiState, "activeView" | "sidebarCollapsed" | "activeDatasetId"> {
  return {
    activeView: state.activeView,
    sidebarCollapsed: state.sidebarCollapsed,
    activeDatasetId: state.activeDatasetId,
  };
}