const encoder = new TextEncoder();

export function nowIso(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Length-independent constant-time comparison for hex digests and tokens. */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < max; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncate(value: string, max: number): string {
  const clean = collapseWhitespace(value);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return email;
  const user = email.slice(0, at);
  const domain = email.slice(at);
  const keep = user.length <= 2 ? 1 : 2;
  return `${user.slice(0, keep)}***${domain}`;
}

/** Decodes named and numeric (decimal and hex) HTML entities. */
export function decodeHtmlEntities(value: string): string {
  return (
    value
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)))
      .replace(/&nbsp;/gi, " ")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&lsquo;|&rsquo;/gi, "'")
      .replace(/&ldquo;|&rdquo;/gi, '"')
      .replace(/&ndash;/gi, "-")
      .replace(/&mdash;/gi, "—")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      // Ampersand last, so a double-encoded entity is not decoded twice.
      .replace(/&amp;/gi, "&")
  );
}

function codePoint(value: number): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "";
}

export function stripHtml(value: string): string {
  return collapseWhitespace(
    decodeHtmlEntities(
      value
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

export function countWords(value: string): number {
  const clean = collapseWhitespace(value);
  return clean.length === 0 ? 0 : clean.split(" ").length;
}

/** 220 wpm is a reasonable scanning speed for short newsletter copy. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 220));
}

export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function uniqueBy<T, K>(items: T[], key: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export function daysBetween(a: string, b: string): number {
  return (Date.parse(a) - Date.parse(b)) / 86_400_000;
}

export function isValidIsoDate(value: string | undefined): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Formats a UTC instant for human display in the configured timezone. */
export function formatLocal(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatLocalDate(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}
