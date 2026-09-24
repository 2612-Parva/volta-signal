import { PREVIEW_TTL_DAYS } from "./config.ts";
import type { Config } from "./config.ts";
import { hmacSha256Hex, timingSafeEqual } from "./util.ts";

/**
 * Preview links are unguessable and short-lived: `<expiry>.<hmac>` over the
 * variant id. No session system is introduced for the MVP.
 */
export async function signPreviewToken(
  config: Config,
  variantId: string,
  expiresAtMs: number = Date.now() + PREVIEW_TTL_DAYS * 86_400_000,
): Promise<string> {
  if (!config.previewSigningSecret) throw new Error("PREVIEW_SIGNING_SECRET is not configured");
  const expiry = String(Math.floor(expiresAtMs / 1000));
  const signature = await hmacSha256Hex(config.previewSigningSecret, `${variantId}:${expiry}`);
  return `${expiry}.${signature}`;
}

export async function verifyPreviewToken(
  config: Config,
  variantId: string,
  token: string | null,
  now: Date = new Date(),
): Promise<boolean> {
  if (!config.previewSigningSecret || !token) return false;

  const [expiry, signature] = token.split(".");
  if (!expiry || !signature) return false;

  const expirySeconds = Number(expiry);
  if (!Number.isFinite(expirySeconds)) return false;
  if (expirySeconds * 1000 < now.getTime()) return false;

  const expected = await hmacSha256Hex(config.previewSigningSecret, `${variantId}:${expiry}`);
  return timingSafeEqual(expected, signature);
}

export function previewUrl(config: Config, variantId: string, token: string): string {
  return `${config.appBaseUrl}/preview/${variantId}?token=${token}`;
}

const CSP =
  "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function previewResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": CSP,
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}
