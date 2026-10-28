import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";

const PREFIX = "/api/runtime/meta/";
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

export function piMetaUpstreamPath(input) {
  const url = new URL(input);
  if (!url.pathname.startsWith(PREFIX)) throw new Error("Pi Meta path refused");
  const suffix = url.pathname.slice(PREFIX.length);
  const resource = suffix.split("/", 1)[0];
  if (!/^[a-z][a-z0-9-]*$/.test(resource) || ["runtime", "service", "pi-meta-control"].includes(resource)) {
    throw new Error("Pi Meta path refused");
  }
  return `/api/${suffix}${url.search}`;
}

/** Forward an already-authenticated, same-origin request to the private worker. */
export async function forwardPiMetaRequest(socketPath, request) {
  const upstreamPath = piMetaUpstreamPath(request.url);
  const headers = {};
  request.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (!HOP_HEADERS.has(key) && key !== "host" && key !== "origin" && key !== "content-length" && !key.startsWith("x-forwarded-")) headers[key] = value;
  });
  headers.host = "localhost";
  if (request.headers.has("origin")) headers.origin = "http://localhost";
  if (request.headers.has("sec-fetch-site")) headers["sec-fetch-site"] = "same-origin";

  return new Promise((resolve, reject) => {
    const upstream = httpRequest({ socketPath, method: request.method, path: upstreamPath, headers }, (incoming) => {
      const resultHeaders = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        const name = incoming.rawHeaders[i];
        if (!HOP_HEADERS.has(name.toLowerCase())) resultHeaders.append(name, incoming.rawHeaders[i + 1]);
      }
      const status = incoming.statusCode || 502;
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming);
      resolve(new Response(body, { status, headers: resultHeaders }));
    });
    upstream.once("error", reject);
    const abort = () => upstream.destroy(new Error("Pi Meta request aborted"));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    upstream.once("close", () => request.signal.removeEventListener("abort", abort));
    if (request.body) Readable.fromWeb(request.body).on("error", error => upstream.destroy(error)).pipe(upstream);
    else upstream.end();
  });
}
