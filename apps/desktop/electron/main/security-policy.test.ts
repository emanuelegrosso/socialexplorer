import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCsp,
  decideNavigation,
  decideWindowOpen,
  isTrustedAppUrl,
  SECURE_WEB_PREFERENCES,
} from "./security-policy.js";

const trusted = { rendererFileUrl: "file:///app/dist/renderer/index.html" };
const dev = { ...trusted, devServerOrigin: "http://127.0.0.1:5173" };

describe("security policy", () => {
  it("pins hardened web preferences", () => {
    expect(SECURE_WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    });
  });

  it("builds a strict production CSP with no remote origins or inline scripts", () => {
    const csp = buildCsp({});
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/unsafe-eval|https?:|\*/u);
    expect(csp.match(/'unsafe-inline'/gu)).toHaveLength(1);
  });

  it("only allows the dev server in development CSP", () => {
    expect(buildCsp({ devServerOrigin: "http://127.0.0.1:5173" })).toContain("ws://127.0.0.1:5173");
  });

  it("keeps the renderer index.html meta CSP identical to the production CSP", () => {
    const html = readFileSync(
      join(import.meta.dirname, "..", "..", "renderer", "index.html"),
      "utf8",
    );
    const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(html);
    expect(match?.[1]).toBe(buildCsp({}));
  });

  it("allows only the renderer entry (and dev origin when configured)", () => {
    expect(decideNavigation("file:///app/dist/renderer/index.html#/memories", trusted)).toBe(
      "allow",
    );
    expect(decideNavigation("file:///app/dist/renderer/other.html", trusted)).toBe("deny");
    expect(decideNavigation("https://example.com", trusted)).toBe("deny");
    expect(decideNavigation("http://127.0.0.1:5173/", trusted)).toBe("deny");
    expect(decideNavigation("http://127.0.0.1:5173/", dev)).toBe("allow");
    expect(decideNavigation("http://127.0.0.1:5174/", dev)).toBe("deny");
    expect(decideNavigation("javascript:alert(1)", dev)).toBe("deny");
    expect(decideNavigation("not a url", dev)).toBe("deny");
    expect(isTrustedAppUrl(undefined, dev)).toBe(false);
  });

  it("always denies new windows", () => {
    expect(decideWindowOpen()).toEqual({ action: "deny" });
  });
});
