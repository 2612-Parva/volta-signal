import type { Config } from "./config.ts";
import {
  allKnownUrls,
  candidateSourceItems,
  recentlyUsedUrls,
  upsertSourceItem,
} from "./db.ts";
import { canonicalizeUrl, safeFetch } from "./net.ts";
import { parseFeed, parseHtmlIndex, parseHtmlPage, parseIcs, parseJsonLd, parseSitemap } from "./parse.ts";
import { checkEligibility, confidenceFor, scoreItem, WINDOWS, type ScoreContext } from "./score.ts";
import { fetchableSources, getSource } from "./sources.ts";
import type {
  Audience,
  CollectionResult,
  CollectionWarning,
  RawItem,
  SourceDefinition,
  SourceItem,
} from "./types.ts";
import { collapseWhitespace, newId, nowIso, sha256Hex, truncate, uniqueBy } from "./util.ts";

const AUDIENCE_HINTS: Array<{ audience: Audience; keywords: string[] }> = [
  { audience: "founder", keywords: ["founder", "startup", "funding", "investor", "pitch", "raise", "ceo"] },
  { audience: "builder", keywords: ["developer", "engineer", "demo", "build", "technical", "hackathon", "prototype", "api"] },
  { audience: "coach", keywords: ["mentor", "coach", "advisor", "ei ", "small business", "workshop"] },
  { audience: "public", keywords: ["community", "open house", "tour", "public", "celebration"] },
];

export function inferAudiences(text: string, fallback: Audience[]): Audience[] {
  const haystack = ` ${text.toLowerCase()} `;
  const matched = AUDIENCE_HINTS.filter((hint) =>
    hint.keywords.some((keyword) => haystack.includes(keyword)),
  ).map((hint) => hint.audience);
  return matched.length > 0 ? [...new Set(matched)] : fallback;
}

/**
 * The hash covers the fields that make an item materially different, so an
 * unchanged item re-collected next month maps to the same row.
 */
export async function contentHash(raw: RawItem, canonicalUrl: string): Promise<string> {
  const input = [
    canonicalUrl,
    collapseWhitespace(raw.title).toLowerCase(),
    raw.publishedAt ?? "",
    raw.eventStartAt ?? "",
    raw.eventEndAt ?? "",
    collapseWhitespace(raw.evidenceText).toLowerCase(),
  ].join("|");
  return sha256Hex(input);
}

export async function normalizeItem(
  raw: RawItem,
  source: SourceDefinition,
  context: ScoreContext,
): Promise<SourceItem | null> {
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(raw.url, source.url || undefined);
  } catch {
    return null;
  }

  const title = collapseWhitespace(raw.title);
  if (!title) return null;

  const hash = await contentHash(raw, canonicalUrl);
  const evidenceText = truncate(raw.evidenceText || title, 400);

  const base: SourceItem = {
    id: newId("src"),
    canonicalUrl,
    sourceDomain: new URL(canonicalUrl).hostname,
    sourceKind: source.kind,
    sourceId: source.id,
    title: truncate(title, 200),
    evidenceText,
    publishedAt: raw.publishedAt,
    eventStartAt: raw.eventStartAt,
    eventEndAt: raw.eventEndAt,
    province: raw.province ?? source.province,
    audiences: raw.audiences ?? inferAudiences(`${title} ${evidenceText}`, source.defaultAudience),
    consent: raw.consent ?? (source.kind === "internal" ? "unknown" : "public"),
    confidence: confidenceFor(source),
    score: 0,
    contentHash: hash,
  };

  const breakdown = scoreItem(base, source, context);
  base.score = breakdown.total;
  base.scoreBreakdown = breakdown;
  return base;
}

async function parseSource(source: SourceDefinition, body: string, timezone: string): Promise<RawItem[]> {
  switch (source.kind) {
    case "rss":
    case "atom":
      return parseFeed(body, source.url);
    case "ics":
      return parseIcs(body, source.url, timezone);
    case "jsonld": {
      const events = parseJsonLd(body, source.url);
      return events.length > 0 ? events : parseHtmlPage(body, source.url);
    }
    case "html_index":
      return parseHtmlIndex(body, source.url, source.linkPattern ?? "/");
    case "html_page":
      return parseHtmlPage(body, source.url);
    case "sitemap":
      return parseSitemap(body, source.url, source.linkPattern ?? "/");
    case "internal":
      return [];
    default:
      return [];
  }
}

/**
 * Fetches every enabled source and stores what it finds. A failing source
 * produces a warning and never a substitute item.
 */
export async function collectAll(db: D1Database, config: Config): Promise<CollectionResult> {
  const startedAt = Date.now();
  const now = new Date();
  const warnings: CollectionWarning[] = [];
  const failedSources: string[] = [];
  const attemptedSources: string[] = [];

  const context: ScoreContext = {
    now,
    knownUrls: await allKnownUrls(db),
    recentlyUsedUrls: await recentlyUsedUrls(
      db,
      new Date(now.getTime() - WINDOWS.reuseSuppressionDays * 86_400_000).toISOString(),
    ),
  };

  const collected: SourceItem[] = [];

  for (const source of fetchableSources()) {
    attemptedSources.push(source.id);
    try {
      const response = await safeFetch(source.url);
      if (response.status < 200 || response.status >= 300) {
        failedSources.push(source.id);
        warnings.push({
          code: "source_http_error",
          sourceId: source.id,
          message: `${source.label ?? source.id} returned HTTP ${response.status}`,
        });
        continue;
      }

      const raws = await parseSource(source, response.body, config.timezone);
      if (raws.length === 0) {
        warnings.push({
          code: "source_empty",
          sourceId: source.id,
          message: `${source.label ?? source.id} returned no parsable items`,
        });
      }

      for (const raw of raws) {
        const item = await normalizeItem(raw, source, context);
        if (item) collected.push(item);
      }
    } catch (error) {
      failedSources.push(source.id);
      warnings.push({
        code: "source_failed",
        sourceId: source.id,
        message: `${source.label ?? source.id}: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  }

  // Prefer the highest-scoring record when two sources report the same URL.
  const deduped = uniqueBy(
    [...collected].sort((a, b) => b.score - a.score),
    (item) => item.canonicalUrl,
  );

  for (const item of deduped) {
    item.id = await upsertSourceItem(db, item);
  }

  const firstPartyAttempted = fetchableSources().filter((source) => source.firstParty);
  const firstPartyFailed = firstPartyAttempted.filter((source) => failedSources.includes(source.id));
  if (firstPartyAttempted.length > 0 && firstPartyFailed.length === firstPartyAttempted.length) {
    warnings.push({
      code: "all_first_party_failed",
      message: "Every first-party Volta source failed; no recommendation can be trusted.",
    });
  }

  return {
    items: deduped,
    warnings,
    durationMs: Date.now() - startedAt,
    failedSources,
    attemptedSources,
  };
}

export type SelectionResult = {
  selected: SourceItem[];
  rejected: Array<{ item: SourceItem; reason: string }>;
};

export const MAX_ITEMS_PER_ISSUE = 12;

/**
 * Applies the inclusion rules to everything currently stored and returns the
 * ranked shortlist that becomes the canonical facts pack.
 */
export async function selectEligibleItems(
  db: D1Database,
  now: Date = new Date(),
  limit: number = MAX_ITEMS_PER_ISSUE,
): Promise<SelectionResult> {
  const since = new Date(now.getTime() - WINDOWS.evergreenDays * 86_400_000).toISOString();
  const candidates = await candidateSourceItems(db, since, now.toISOString());

  const context: ScoreContext = {
    now,
    knownUrls: new Set(candidates.map((item) => item.canonicalUrl)),
    recentlyUsedUrls: await recentlyUsedUrls(
      db,
      new Date(now.getTime() - WINDOWS.reuseSuppressionDays * 86_400_000).toISOString(),
    ),
  };

  const selected: SourceItem[] = [];
  const rejected: Array<{ item: SourceItem; reason: string }> = [];

  for (const item of candidates) {
    const source = getSource(item.sourceId);
    if (!source) {
      rejected.push({ item, reason: "unknown_source" });
      continue;
    }
    const verdict = checkEligibility(item, source, context);
    if (verdict.eligible) selected.push(item);
    else rejected.push({ item, reason: verdict.reason ?? "ineligible" });
  }

  const ranked = uniqueBy(
    selected.sort((a, b) => b.score - a.score),
    (item) => item.canonicalUrl,
  ).slice(0, limit);

  return { selected: ranked, rejected };
}

/** Stores an internal signal that a person explicitly approved for use. */
export async function storeInternalSignal(
  db: D1Database,
  input: {
    url: string;
    title: string;
    evidenceText: string;
    approvedBy: string;
    audiences?: Audience[];
    publishedAt?: string;
  },
): Promise<SourceItem> {
  const source = getSource("internal_signals");
  if (!source) throw new Error("internal_signals source is not registered");

  const canonicalUrl = canonicalizeUrl(input.url);
  const raw: RawItem = {
    url: canonicalUrl,
    title: input.title,
    evidenceText: input.evidenceText,
    publishedAt: input.publishedAt ?? nowIso(),
    audiences: input.audiences,
    consent: "approved",
  };

  const context: ScoreContext = {
    now: new Date(),
    knownUrls: new Set(),
    recentlyUsedUrls: new Set(),
  };

  const item = await normalizeItem(raw, source, context);
  if (!item) throw new Error("Internal signal could not be normalized");

  item.consent = "approved";
  item.id = await upsertSourceItem(db, item);
  return item;
}
