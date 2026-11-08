// HTTP plumbing shared by the core and by modules: a small router, JSON in and out, cookies,
// and the client's address.
//
// Router patterns are exact paths with ":name" segments and an optional trailing "*":
//     router.get("/api/forum/threads/:id", handler)
//     router.get("/forum/*", handler)            rc.params["*"] is the rest of the path
// A handler is async (req, res, rc). rc carries the request's parts and helpers:
//     rc.url, rc.path, rc.params, rc.query (URLSearchParams), rc.ip, rc.log
//     rc.body({ maxBytes, optional })  the JSON object sent (application/json only)
//     rc.json(status, body, headers)   rc.send(status, body, contentType, headers)
//     rc.account, rc.session           set by auth.requireSession / requireRole / optionalSession
// Throw an HttpError for an expected refusal; anything else is logged and answered with 500.
// Every POST, PUT, PATCH and DELETE passes the router's CSRF guard first (the request's Origin,
// or its Referer, must be one of the site's own), unless the route is added with { csrf: false }.

import net from "node:net";

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra.body || null;
    this.headers = extra.headers || null;
  }
}

const STATUS_TEXT = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  409: "Conflict", 413: "Payload Too Large", 415: "Unsupported Media Type", 426: "Upgrade Required", 429: "Too Many Requests",
  500: "Internal Server Error", 503: "Service Unavailable" };

export function statusText(status) {
  return STATUS_TEXT[status] || "Error";
}

export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(text);
}

export function sendError(res, err) {
  const body = { error: err.code, message: err.message };
  if (err.extra) Object.assign(body, err.extra);
  sendJson(res, err.status, body, err.headers || {});
}

// The request body as a JSON object. Only application/json is taken (a cross-site form cannot
// send it without CORS, which this service never allows).
export function readJson(req, { maxBytes = 4096, optional = false } = {}) {
  return new Promise((resolve, reject) => {
    const length = req.headers["content-length"];
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (optional && (length === "0" || (!length && !req.headers["transfer-encoding"]))) {
      req.resume();
      return resolve({});
    }
    if (type !== "application/json") {
      req.resume();
      return reject(new HttpError(415, "unsupported_media_type", "Send JSON (Content-Type: application/json)."));
    }
    if (length && Number(length) > maxBytes) {
      req.resume();
      return reject(new HttpError(413, "payload_too_large", "The request is too large."));
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        req.resume();
        return reject(new HttpError(413, "payload_too_large", "The request is too large."));
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (e) {
        return reject(new HttpError(400, "bad_request", "The request is not valid JSON."));
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return reject(new HttpError(400, "bad_request", "Send a JSON object."));
      }
      resolve(value);
    });
    req.on("error", () => {
      if (!done) {
        done = true;
        reject(new HttpError(400, "bad_request", "The request could not be read."));
      }
    });
  });
}

export function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!out.has(name)) out.set(name, part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, path = "/", httpOnly = true, secure = true, sameSite = "Strict" } = {}) {
  let c = name + "=" + value + "; Path=" + path;
  if (maxAge !== undefined) c += "; Max-Age=" + Math.floor(maxAge);
  if (httpOnly) c += "; HttpOnly";
  if (secure) c += "; Secure";
  if (sameSite) c += "; SameSite=" + sameSite;
  return c;
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// The header a trusted front hop sets to the visitor's address. trustProxy true is nginx's X-Real-IP (nginx overwrites it in
// every location); a string names the one header an edge sets (a Cloudflare Tunnel's cloudflared reaches h9web from loopback and
// forwards the visitor's own X-Real-IP untouched, so for that topology only cf-connecting-ip is believed).
export const PROXY_HEADERS = new Set(["x-real-ip", "cf-connecting-ip"]);

export function proxyHeaderFor(trustProxy) {
  if (!trustProxy) return null;
  const name = trustProxy === true ? "x-real-ip" : String(trustProxy).toLowerCase();
  if (!PROXY_HEADERS.has(name)) throw new Error("trustProxy must be true, false or one of: " + [...PROXY_HEADERS].join(", "));
  return name;
}

// The client's address: the trusted header's single valid address when the connection comes from this machine and trustProxy
// is on, the connection's own address otherwise.
export function clientIp(req, trustProxy) {
  const header = proxyHeaderFor(trustProxy);
  let address = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
  if (header && isLoopback(address)) {
    const real = String(req.headers[header] || "").trim();
    if (net.isIP(real)) address = real;
  }
  if (address.startsWith("::ffff:") && net.isIPv4(address.slice(7))) address = address.slice(7);
  return address;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function compile(pattern) {
  if (typeof pattern !== "string" || !pattern.startsWith("/")) throw new Error("router: pattern must start with /: " + pattern);
  const parts = pattern.split("/").slice(1);
  const rest = parts[parts.length - 1] === "*";
  if (rest) parts.pop();
  for (const p of parts) if (p.includes("*")) throw new Error("router: * only as the last segment: " + pattern);
  return { pattern, parts, rest };
}

function matchParts(route, segments) {
  if (route.rest ? segments.length < route.parts.length : segments.length !== route.parts.length) return null;
  const params = {};
  for (let i = 0; i < route.parts.length; i++) {
    const p = route.parts[i];
    if (p.startsWith(":")) {
      if (!segments[i]) return null;
      let v;
      try { v = decodeURIComponent(segments[i]); } catch (e) { return null; }
      if (v.length > 200) return null;
      params[p.slice(1)] = v;
    } else if (p !== segments[i]) {
      return null;
    }
  }
  if (route.rest) params["*"] = segments.slice(route.parts.length).join("/");
  return params;
}

export class Router {
  constructor({ log, csrfGuard, trustProxy = false }) {
    this.routes = [];
    this.log = log;
    this.csrfGuard = csrfGuard;
    this.trustProxy = trustProxy;
  }

  add(method, pattern, handler, opts = {}) {
    if (typeof handler !== "function") throw new Error("router: handler for " + pattern + " is not a function");
    const route = compile(pattern);
    for (const r of this.routes) {
      if (r.method === method && r.pattern === route.pattern) throw new Error("router: " + method + " " + pattern + " is already taken");
    }
    this.routes.push({ ...route, method, handler, opts });
    return this;
  }

  get(p, h, o) { return this.add("GET", p, h, o); }
  post(p, h, o) { return this.add("POST", p, h, o); }
  put(p, h, o) { return this.add("PUT", p, h, o); }
  patch(p, h, o) { return this.add("PATCH", p, h, o); }
  delete(p, h, o) { return this.add("DELETE", p, h, o); }

  // A router that only takes patterns under the given prefixes ("/api/forum" allows
  // "/api/forum" and "/api/forum/..."), for a module.
  scoped(prefixes) {
    const parent = this;
    const allowed = (pattern) => prefixes.some((p) => pattern === p || pattern.startsWith(p + "/"));
    const scopedAdd = (method) => (pattern, handler, opts) => {
      if (!allowed(pattern)) throw new Error("router: " + pattern + " is outside this module's paths (" + prefixes.join(", ") + ")");
      parent.add(method, pattern, handler, opts);
      return api;
    };
    const api = {
      prefixes: prefixes.slice(),
      get: scopedAdd("GET"), post: scopedAdd("POST"), put: scopedAdd("PUT"), patch: scopedAdd("PATCH"), delete: scopedAdd("DELETE"),
    };
    return api;
  }

  find(method, pathname) {
    const segments = pathname.split("/").slice(1);
    const allow = new Set();
    for (const r of this.routes) {
      const params = matchParts(r, segments);
      if (!params) continue;
      if (r.method === method || (method === "HEAD" && r.method === "GET")) return { route: r, params };
      allow.add(r.method);
    }
    return allow.size ? { allow: [...allow] } : null;
  }

  // Answers the request when a route matches it; false when none does.
  async handle(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://h9web.invalid");
    } catch (e) {
      sendError(res, new HttpError(400, "bad_request", "Bad address."));
      return true;
    }
    const found = this.find(req.method, url.pathname);
    if (!found) return false;
    if (found.allow) {
      sendError(res, new HttpError(405, "method_not_allowed", "Method not allowed.", { headers: { Allow: found.allow.join(", ") } }));
      return true;
    }
    const { route, params } = found;
    const rc = {
      req, res, url, path: url.pathname, params, query: url.searchParams,
      ip: clientIp(req, this.trustProxy), log: this.log, account: null, session: null,
      body: (o) => readJson(req, o),
      json: (status, body, headers) => sendJson(res, status, body, headers),
      send: (status, body, contentType = "text/plain; charset=utf-8", headers = {}) => {
        if (res.headersSent) return;
        res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body), "X-Content-Type-Options": "nosniff", ...headers });
        res.end(body);
      },
    };
    try {
      if (UNSAFE.has(req.method) && route.opts.csrf !== false && this.csrfGuard && !this.csrfGuard(req)) {
        throw new HttpError(403, "csrf", "This request did not come from the site's own pages.");
      }
      await route.handler(req, res, rc);
      if (!res.headersSent) throw new Error("the handler sent no answer");
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err);
      } else {
        if (this.log) this.log.error("handler.error", { route: route.method + " " + route.pattern, error: err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : String(err) });
        sendError(res, new HttpError(500, "server_error", "Something went wrong on our side."));
      }
    }
    return true;
  }
}
