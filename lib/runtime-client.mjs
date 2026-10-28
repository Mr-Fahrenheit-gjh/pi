/** Page-local identity lets different tabs use different kernels without a shared cookie. */
export function pageRuntime(pathname = typeof window === "undefined" ? "/" : window.location?.pathname || "/") {
  if (pathname === "/feynman" || pathname.startsWith("/feynman/")) return "feynman";
  if (pathname === "/pi-meta" || pathname.startsWith("/pi-meta/")) return "meta";
  return "pi";
}
export function runtimeStorageKey(key, runtime = pageRuntime()) {
  return runtime === "pi" ? key : `${runtime}:${key}`;
}
export function runtimeApi(path, runtime = pageRuntime()) {
  if (runtime === "pi" || !path.startsWith("/api/") || path.startsWith("/api/runtime/")) return path;
  const resource = path.slice(5).split(/[/?]/)[0];
  // Feynman shares host utilities; Pi Meta keeps its own file roots and terminals.
  if (runtime === "feynman" && ["files", "file-index", "git", "home", "cwd", "open-in-explorer", "chat-attachments", "browser", "terminal", "terminals", "worktrees", "web-auth"].includes(resource)) return path;
  if (runtime === "meta" && ["web-auth", "service"].includes(resource)) return path;
  return runtime === "meta" ? `/api/runtime/meta/${path.slice(5)}` : `/api/runtime/feynman/${path.slice(5)}`;
}
function scopedAbsolute(input) {
  if (typeof window === "undefined" || !window.location?.origin) return input;
  const url = new URL(input, window.location.href);
  if (url.origin !== window.location.origin) return input;
  const path = runtimeApi(url.pathname + url.search);
  if (path === url.pathname + url.search) return input;
  return new URL(path, url.origin).href;
}
/** Scope at dispatch time; navigation cannot retarget an already-issued request. */
export const runtimeFetch = (input, init) => {
  if (typeof input === "string") return globalThis.fetch(input.startsWith("/api/") ? runtimeApi(input) : scopedAbsolute(input), init);
  if (input instanceof URL) return globalThis.fetch(scopedAbsolute(input.href), init);
  if (input instanceof Request) {
    const url = scopedAbsolute(input.url);
    return globalThis.fetch(url === input.url ? input : new Request(url, input), init);
  }
  throw new TypeError("Unsupported runtime request input");
};
export function runtimePage(runtime) { return runtime === "pi" ? "/" : runtime === "meta" ? "/pi-meta" : "/feynman"; }
