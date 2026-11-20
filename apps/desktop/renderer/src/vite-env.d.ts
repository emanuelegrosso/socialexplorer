/// <reference types="vite/client" />
import type { SocialExplorerApi } from "../../shared/bridge";

declare global {
  interface Window {
    socialExplorer?: SocialExplorerApi;
  }
}
