// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  contentSecurityPolicyMeta,
} from "./vite/content-security-policy.ts";
import { crossOriginIsolationHeaders } from "./vite/host-headers";
import config from "./vite.config";

describe("vite config", () => {
  it("sends COOP same-origin and COEP require-corp from dev and preview servers", () => {
    expect(crossOriginIsolationHeaders).toEqual({
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    expect(config.server?.headers).toMatchObject(crossOriginIsolationHeaders);
    expect(config.preview?.headers).toMatchObject(crossOriginIsolationHeaders);
  });

  it("sends a strict Content-Security-Policy from the preview and a relaxed one for development", () => {
    const preview = config.preview?.headers as Record<string, string>;
    const dev = config.server?.headers as Record<string, string>;
    expect(preview["Content-Security-Policy"]).toBe(contentSecurityPolicy(false));
    expect(dev["Content-Security-Policy"]).toBe(contentSecurityPolicy(true));
    expect(preview["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(preview["Content-Security-Policy"]).toContain("object-src 'none'");
    expect(preview["Content-Security-Policy"]).not.toContain(" 'unsafe-eval'");
    const scripts = (preview["Content-Security-Policy"] ?? "")
      .split("; ")
      .find((d) => d.startsWith("script-src"));
    expect(scripts).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(dev["Content-Security-Policy"]).toContain("'unsafe-inline'");
  });

  it("allows https fetches only for user-opened remote images, and keeps scripts self-hosted (WEB-FILE-06, WEB-SEC-02)", () => {
    const connect = contentSecurityPolicy(false)
      .split("; ")
      .find((d) => d.startsWith("connect-src"));
    expect(connect).toBe("connect-src 'self' https:");
    expect(contentSecurityPolicy(false)).toContain("script-src 'self' 'wasm-unsafe-eval'");
  });

  it("puts the production policy in the built page without frame-ancestors", () => {
    expect(contentSecurityPolicyMeta()).not.toContain("frame-ancestors");
    expect(contentSecurityPolicyMeta()).toContain("script-src 'self' 'wasm-unsafe-eval'");
  });

  it("registers the PWA plugin", () => {
    const names = config.plugins?.flat().map((p) => (p && "name" in p ? p.name : undefined));
    expect(names).toContain("vite-plugin-pwa");
  });
});
