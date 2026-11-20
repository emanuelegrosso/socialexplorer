import type { WebPreferences } from "electron";

export function buildCsp(options: { readonly devServerOrigin?: string | undefined }): string {
  const dev = options.devServerOrigin;
  const connect = dev === undefined ? "'none'" : `'self' ${dev} ${dev.replace(/^http/u, "ws")}`;
  const script = dev === undefined ? "'self'" : "'self' 'unsafe-inline'";
  return [
    "default-src 'none'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
} as const satisfies WebPreferences;

export interface TrustedOrigins {
  /** file:// URL of the packaged renderer entry (index.html). */
  readonly rendererFileUrl?: string | undefined;
  /** Vite dev server origin, only in development. */
  readonly devServerOrigin?: string | undefined;
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** True only for the app's own renderer document; hash/query changes are allowed, nothing else. */
export function isTrustedAppUrl(url: string | undefined, trusted: TrustedOrigins): boolean {
  if (url === undefined) {
    return false;
  }
  const parsed = parse(url);
  if (parsed === undefined) {
    return false;
  }
  if (trusted.devServerOrigin !== undefined && parsed.origin === trusted.devServerOrigin) {
    return true;
  }
  if (trusted.rendererFileUrl !== undefined && parsed.protocol === "file:") {
    const expected = parse(trusted.rendererFileUrl);
    return expected !== undefined && parsed.pathname === expected.pathname;
  }
  return false;
}

export function decideNavigation(url: string, trusted: TrustedOrigins): "allow" | "deny" {
  return isTrustedAppUrl(url, trusted) ? "allow" : "deny";
}

/** External links are never opened from the app; window.open is always denied. */
export function decideWindowOpen(): { readonly action: "deny" } {
  return { action: "deny" };
}
