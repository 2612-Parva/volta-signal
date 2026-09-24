import { canonicalizeUrl } from "./net.ts";
import { zonedTimeToUtc } from "./schedule.ts";
import type { RawItem } from "./types.ts";
import { collapseWhitespace, decodeHtmlEntities, stripHtml, truncate } from "./util.ts";

const EVIDENCE_MAX = 400;

function decodeEntities(value: string): string {
  return decodeHtmlEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
}

function tagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!match) return undefined;
  return collapseWhitespace(decodeEntities(match[1] ?? "")) || undefined;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

/* -------------------------------------------------------------- RSS/Atom */

export function parseFeed(xml: string, baseUrl: string): RawItem[] {
  const items: RawItem[] = [];
  const blocks = [
    ...xml.split(/<item[\s>]/i).slice(1).map((chunk) => `<item ${chunk}`),
    ...xml.split(/<entry[\s>]/i).slice(1).map((chunk) => `<entry ${chunk}`),
  ];

  for (const block of blocks) {
    const title = tagText(block, "title");
    let link = tagText(block, "link");
    if (!link) {
      link = /<link[^>]*href=["']([^"']+)["']/i.exec(block)?.[1];
    }
    if (!title || !link) continue;

    const summary =
      tagText(block, "description") ??
      tagText(block, "summary") ??
      tagText(block, "content") ??
      "";

    items.push({
      url: canonicalizeUrl(link, baseUrl),
      title,
      evidenceText: truncate(stripHtml(summary) || title, EVIDENCE_MAX),
      publishedAt: isoOrUndefined(
        tagText(block, "pubDate") ?? tagText(block, "published") ?? tagText(block, "updated"),
      ),
    });
  }

  return items;
}

/* ------------------------------------------------------------------- ICS */

function unfoldIcs(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

type IcsProperty = { name: string; params: Record<string, string>; value: string };

function parseIcsLine(line: string): IcsProperty | null {
  const separator = line.indexOf(":");
  if (separator < 0) return null;
  const head = line.slice(0, separator);
  const value = line.slice(separator + 1);
  const [name, ...paramParts] = head.split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: (name ?? "").toUpperCase(), params, value };
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/**
 * Converts an ICS date value to a UTC instant. Floating values are interpreted
 * in `defaultTimeZone`, matching how Volta publishes local event times.
 */
export function icsDateToIso(
  property: IcsProperty,
  defaultTimeZone: string,
): { iso: string; dateOnly: boolean } | null {
  const raw = property.value.trim();
  const dateOnly = property.params.VALUE === "DATE" || /^\d{8}$/.test(raw);

  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
  if (!match) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? { iso: new Date(parsed).toISOString(), dateOnly } : null;
  }

  const [, y, mo, d, h, mi, s, zulu] = match;
  const wall = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h ?? "0"),
    minute: Number(mi ?? "0"),
    second: Number(s ?? "0"),
  };

  if (zulu) {
    return {
      iso: new Date(
        Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second),
      ).toISOString(),
      dateOnly,
    };
  }

  const timeZone = property.params.TZID ?? defaultTimeZone;
  return { iso: zonedTimeToUtc(wall, timeZone).toISOString(), dateOnly };
}

export function parseIcs(text: string, fallbackUrl: string, defaultTimeZone: string): RawItem[] {
  const items: RawItem[] = [];
  let current: Record<string, IcsProperty> | null = null;

  for (const line of unfoldIcs(text)) {
    const trimmed = line.trim();
    if (trimmed === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (trimmed === "END:VEVENT") {
      if (current) items.push(...icsEventToItem(current, fallbackUrl, defaultTimeZone));
      current = null;
      continue;
    }
    if (!current) continue;

    const property = parseIcsLine(trimmed);
    if (property) current[property.name] = property;
  }

  return items;
}

function icsEventToItem(
  event: Record<string, IcsProperty>,
  fallbackUrl: string,
  defaultTimeZone: string,
): RawItem[] {
  const summary = event.SUMMARY ? unescapeIcsText(event.SUMMARY.value) : "";
  if (!summary) return [];

  const start = event.DTSTART ? icsDateToIso(event.DTSTART, defaultTimeZone) : null;
  if (!start) return [];

  let endIso = event.DTEND ? icsDateToIso(event.DTEND, defaultTimeZone)?.iso : undefined;
  if (!endIso) {
    const durationMs = start.dateOnly ? 86_400_000 : 3_600_000;
    endIso = new Date(Date.parse(start.iso) + durationMs).toISOString();
  }

  const description = event.DESCRIPTION ? unescapeIcsText(event.DESCRIPTION.value) : "";
  const location = event.LOCATION ? unescapeIcsText(event.LOCATION.value) : "";
  const url = event.URL?.value?.trim();

  return [
    {
      url: canonicalizeUrl(url && /^https?:/i.test(url) ? url : fallbackUrl),
      title: collapseWhitespace(summary),
      evidenceText: truncate(
        [stripHtml(description), location ? `Location: ${location}` : ""].filter(Boolean).join(" "),
        EVIDENCE_MAX,
      ) || collapseWhitespace(summary),
      eventStartAt: start.iso,
      eventEndAt: endIso,
    },
  ];
}

/* ---------------------------------------------------------------- JSON-LD */

type JsonLdNode = Record<string, unknown>;

function flattenJsonLd(node: unknown, out: JsonLdNode[]): void {
  if (Array.isArray(node)) {
    for (const child of node) flattenJsonLd(child, out);
    return;
  }
  if (!node || typeof node !== "object") return;

  const record = node as JsonLdNode;
  out.push(record);
  if (record["@graph"]) flattenJsonLd(record["@graph"], out);
  if (record.itemListElement) flattenJsonLd(record.itemListElement, out);
  if (record.item) flattenJsonLd(record.item, out);
}

export function parseJsonLd(html: string, baseUrl: string): RawItem[] {
  const items: RawItem[] = [];
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeEntities(block[1] ?? ""));
    } catch {
      continue;
    }

    const nodes: JsonLdNode[] = [];
    flattenJsonLd(parsed, nodes);

    for (const node of nodes) {
      const type = String(node["@type"] ?? "");
      const isEvent = /event/i.test(type);
      const isArticle = /article|blogposting|newsarticle/i.test(type);
      if (!isEvent && !isArticle) continue;

      const name = typeof node.name === "string" ? node.name : typeof node.headline === "string" ? node.headline : "";
      const rawUrl = typeof node.url === "string" ? node.url : "";
      if (!name || !rawUrl) continue;

      const description = typeof node.description === "string" ? node.description : "";
      items.push({
        url: canonicalizeUrl(rawUrl, baseUrl),
        title: collapseWhitespace(name),
        evidenceText: truncate(stripHtml(description) || name, EVIDENCE_MAX),
        eventStartAt: isEvent ? isoOrUndefined(String(node.startDate ?? "")) : undefined,
        eventEndAt: isEvent ? isoOrUndefined(String(node.endDate ?? "")) : undefined,
        publishedAt: isArticle ? isoOrUndefined(String(node.datePublished ?? "")) : undefined,
      });
    }
  }

  return items;
}

/* ------------------------------------------------------------------ HTML */

const CTA_TEXT = /^(read more|read|learn more|view|continue reading|more|register|details)$/i;

/**
 * Link-list pages render several anchors per post (image, title, CTA), so keep
 * the longest anchor text per canonical URL.
 */
export function parseHtmlIndex(html: string, baseUrl: string, linkPattern: string): RawItem[] {
  const byUrl = new Map<string, RawItem>();

  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1] ?? "";
    if (!href.includes(linkPattern)) continue;

    let url: string;
    try {
      url = canonicalizeUrl(href, baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:/.test(url)) continue;

    const text = stripHtml(match[2] ?? "");
    if (!text || CTA_TEXT.test(text) || text.length < 8) continue;

    const existing = byUrl.get(url);
    if (!existing || text.length > existing.title.length) {
      byUrl.set(url, {
        url,
        title: truncate(text, 160),
        evidenceText: truncate(text, EVIDENCE_MAX),
        publishedAt: findInlineDate(html, href),
      });
    }
  }

  return [...byUrl.values()];
}

/** Looks for a human date near the link, which is how Volta renders post cards. */
function findInlineDate(html: string, href: string): string | undefined {
  const index = html.indexOf(href);
  if (index < 0) return undefined;
  const window = stripHtml(html.slice(Math.max(0, index - 600), index + 600));
  const match =
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i.exec(window);
  return isoOrUndefined(match?.[0]);
}

export function parseHtmlPage(html: string, url: string): RawItem[] {
  const meta = (pattern: RegExp): string | undefined => {
    const raw = pattern.exec(html)?.[1];
    return raw ? collapseWhitespace(decodeEntities(raw)) : undefined;
  };

  // `tagText` and `stripHtml` already decode entities; only raw attribute
  // captures need decoding here.
  const title =
    tagText(html, "h1") ??
    meta(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ??
    tagText(html, "title");
  if (!title) return [];

  const description =
    meta(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i) ??
    meta(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ??
    firstParagraph(html);

  return [
    {
      url: canonicalizeUrl(url),
      title: truncate(title, 160),
      evidenceText: truncate(stripHtml(description ?? title), EVIDENCE_MAX),
    },
  ];
}

function firstParagraph(html: string): string | undefined {
  for (const match of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripHtml(match[1] ?? "");
    if (text.length > 60) return text;
  }
  return undefined;
}

export function parseSitemap(xml: string, baseUrl: string, linkPattern: string): RawItem[] {
  const items: RawItem[] = [];

  for (const match of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const block = match[1] ?? "";
    const loc = tagText(block, "loc");
    if (!loc || !loc.includes(linkPattern)) continue;

    const slug = loc.split(linkPattern)[1]?.replace(/\/+$/, "");
    if (!slug) continue;

    const title = slug
      .split("-")
      .map((word) => (word.length > 2 ? word[0]!.toUpperCase() + word.slice(1) : word))
      .join(" ");

    items.push({
      url: canonicalizeUrl(loc, baseUrl),
      title,
      evidenceText: `Volta published "${title}".`,
      publishedAt: isoOrUndefined(tagText(block, "lastmod")),
    });
  }

  return items;
}
