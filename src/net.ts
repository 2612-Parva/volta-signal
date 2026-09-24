export const USER_AGENT = "VoltaSignal/0.1 (+https://voltaeffect.com)";

export const MAX_REDIRECTS = 5;
export const MAX_BYTES = 2_000_000;
export const DEFAULT_TIMEOUT_MS = 12_000;

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "ref",
  "ref_src",
  "igshid",
]);

export class FetchGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchGuardError";
  }
}

/**
 * Blocks loopback, link-local, private, and cloud metadata destinations so a
 * redirect cannot pull the worker into an internal network.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  if (host === "metadata.google.internal") return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }

  return false;
}

export function assertSafeUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchGuardError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchGuardError(`Blocked protocol: ${url.protocol}`);
  }
  if (isBlockedHost(url.hostname)) {
    throw new FetchGuardError(`Blocked host: ${url.hostname}`);
  }
  return url;
}

/**
 * Removes tracking parameters and normalizes casing/trailing slashes while
 * preserving query parameters that identify a real article or event.
 */
export function canonicalizeUrl(rawUrl: string, base?: string): string {
  const url = new URL(rawUrl, base);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }

  return url.toString();
}

export function isVoltaOwned(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === "voltaeffect.com" || host.endsWith(".voltaeffect.com");
  } catch {
    return false;
  }
}

export function addUtm(rawUrl: string, campaign: string): string {
  if (!isVoltaOwned(rawUrl)) return rawUrl;
  const url = new URL(rawUrl);
  url.searchParams.set("utm_source", "newsletter");
  url.searchParams.set("utm_medium", "email");
  url.searchParams.set("utm_campaign", campaign);
  return url.toString();
}

export type SafeResponse = {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
};

async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - maxBytes))));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8").decode(merged), truncated };
}

/**
 * Fetch with manual redirect handling so every hop is re-validated against the
 * host guard, plus hard caps on time and response size.
 */
export async function safeFetch(
  rawUrl: string,
  options: { method?: "GET" | "HEAD"; timeoutMs?: number; maxBytes?: number; readBody?: boolean } = {},
): Promise<SafeResponse> {
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const readBody = options.readBody ?? method === "GET";

  let current = assertSafeUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current.toString(), {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          finalUrl: current.toString(),
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          body: "",
          truncated: false,
        };
      }
      current = assertSafeUrl(new URL(location, current).toString());
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const { text, truncated } = readBody
      ? await readCapped(response, maxBytes)
      : { text: "", truncated: false };

    return {
      finalUrl: current.toString(),
      status: response.status,
      contentType,
      body: text,
      truncated,
    };
  }

  throw new FetchGuardError(`Too many redirects for ${rawUrl}`);
}
