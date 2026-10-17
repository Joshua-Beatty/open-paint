/**
 * The Content-Security-Policy for the app (WEB-SEC-01). Everything is self-hosted, so every source
 * is `'self'`. WASM needs `'wasm-unsafe-eval'`, and the inline style attributes that React and
 * React Aria set need `style-src 'unsafe-inline'`. Development adds `'unsafe-inline'` scripts for
 * the React Refresh preamble and the `ws:` HMR socket. Production never does.
 */
export function contentSecurityPolicy(development: boolean): string {
  return cspDirectives(development).join("; ");
}

/** The policy as the production `<meta>` tag. Browsers ignore `frame-ancestors` in a meta tag. */
export function contentSecurityPolicyMeta(): string {
  return cspDirectives(false)
    .filter((directive) => !directive.startsWith("frame-ancestors"))
    .join("; ");
}

function cspDirectives(development: boolean): string[] {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${development ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' https:${development ? " ws:" : ""}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ];
}
