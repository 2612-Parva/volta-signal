import type { Authority, SourceDefinition, SourceItem } from "./types.ts";

/**
 * Collection windows, widened from the weekly reference design because this
 * newsletter ships once a month during the first week.
 */
export const WINDOWS = {
  newsDays: 31,
  evergreenDays: 90,
  eventsAheadDays: 45,
  reuseSuppressionDays: 120,
} as const;

export const MIN_SCORE = 45;
export const MIN_CONFIDENCE = 15;

export type ScoreContext = {
  now: Date;
  recentlyUsedUrls: Set<string>;
  knownUrls: Set<string>;
};

export type ScoreBreakdown = {
  authority: number;
  relevance: number;
  actionability: number;
  freshness: number;
  atlantic: number;
  novelty: number;
  promotional: number;
  total: number;
};

const AUTHORITY_CONFIDENCE: Record<Authority, number> = {
  volta: 25,
  government: 22,
  company: 18,
  ecosystem: 14,
};

const MISSION_KEYWORDS = [
  "founder",
  "startup",
  "funding",
  "investment",
  "raise",
  "accelerator",
  "residency",
  "cohort",
  "demo day",
  "mentor",
  "incubat",
  "artificial intelligence",
  " ai ",
  "venture",
  "scale",
  "product",
  "customer",
  "revenue",
  "hiring",
  "small business",
  "community",
];

const ACTION_KEYWORDS = [
  "apply",
  "application",
  "register",
  "registration",
  "rsvp",
  "deadline",
  "sign up",
  "join",
  "submit",
  "office hours",
  "workshop",
  "call for",
  "nominat",
];

const ATLANTIC_KEYWORDS = [
  "halifax",
  "nova scotia",
  "atlantic canada",
  "new brunswick",
  "prince edward island",
  "newfoundland",
  "moncton",
  "fredericton",
  "saint john",
  "st. john's",
  "dartmouth",
  "sydney",
  "charlottetown",
];

const PROMOTIONAL_KEYWORDS = [
  "buy now",
  "limited time offer",
  "discount code",
  "promo code",
  "sponsored post",
  "act now",
  "don't miss out",
  "exclusive deal",
];

export function confidenceFor(source: SourceDefinition): number {
  const base = AUTHORITY_CONFIDENCE[source.authority];
  return source.firstParty ? base : Math.max(0, base - 2);
}

function haystack(item: Pick<SourceItem, "title" | "evidenceText">): string {
  return ` ${item.title} ${item.evidenceText} `.toLowerCase();
}

function countHits(text: string, keywords: string[]): number {
  let hits = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) hits += 1;
  }
  return hits;
}

/** Deterministic pre-LLM score. The model never changes these numbers. */
export function scoreItem(
  item: SourceItem,
  source: SourceDefinition,
  context: ScoreContext,
): ScoreBreakdown {
  const text = haystack(item);
  const nowMs = context.now.getTime();

  const authority = confidenceFor(source);

  const relevance = Math.min(25, countHits(text, MISSION_KEYWORDS) * 5 + (source.firstParty ? 5 : 0));

  const hasFutureEvent = item.eventStartAt ? Date.parse(item.eventStartAt) > nowMs : false;
  const actionability = Math.min(
    20,
    countHits(text, ACTION_KEYWORDS) * 5 + (hasFutureEvent ? 8 : 0),
  );

  let freshness = 0;
  if (hasFutureEvent) {
    const daysAhead = (Date.parse(item.eventStartAt!) - nowMs) / 86_400_000;
    freshness = daysAhead <= WINDOWS.eventsAheadDays ? 15 : 6;
  } else if (item.publishedAt) {
    const ageDays = (nowMs - Date.parse(item.publishedAt)) / 86_400_000;
    if (ageDays <= 7) freshness = 15;
    else if (ageDays <= WINDOWS.newsDays) freshness = 12;
    else if (ageDays <= WINDOWS.evergreenDays) freshness = 6;
    else freshness = 0;
  } else if (source.evergreen) {
    freshness = 8;
  }

  const atlantic = item.province || countHits(text, ATLANTIC_KEYWORDS) > 0 ? 10 : 3;

  const seenBefore = context.knownUrls.has(item.canonicalUrl);
  const usedRecently = context.recentlyUsedUrls.has(item.canonicalUrl);
  const novelty = usedRecently ? 0 : seenBefore ? 2 : 5;

  const exclamations = (item.title.match(/!/g) ?? []).length;
  const promotional = -Math.min(
    15,
    countHits(text, PROMOTIONAL_KEYWORDS) * 8 + (exclamations > 1 ? 4 : 0),
  );

  const total = Math.max(
    0,
    authority + relevance + actionability + freshness + atlantic + novelty + promotional,
  );

  return { authority, relevance, actionability, freshness, atlantic, novelty, promotional, total };
}

export type EligibilityResult = { eligible: boolean; reason?: string };

/** Hard inclusion rules applied before anything reaches the facts pack. */
export function checkEligibility(
  item: SourceItem,
  source: SourceDefinition,
  context: ScoreContext,
): EligibilityResult {
  if (item.consent === "unknown") {
    return { eligible: false, reason: "consent_unknown" };
  }
  if (!/^https?:\/\//i.test(item.canonicalUrl)) {
    return { eligible: false, reason: "missing_url" };
  }

  const nowMs = context.now.getTime();

  if (item.eventStartAt) {
    const endMs = Date.parse(item.eventEndAt ?? item.eventStartAt);
    if (Number.isFinite(endMs) && endMs < nowMs) {
      return { eligible: false, reason: "event_past" };
    }
    const startMs = Date.parse(item.eventStartAt);
    if (startMs - nowMs > WINDOWS.eventsAheadDays * 86_400_000) {
      return { eligible: false, reason: "event_too_far_out" };
    }
  } else if (item.publishedAt) {
    const ageDays = (nowMs - Date.parse(item.publishedAt)) / 86_400_000;
    const limit = source.evergreen ? WINDOWS.evergreenDays : WINDOWS.newsDays;
    if (ageDays > limit) return { eligible: false, reason: "outside_window" };
  } else if (!source.evergreen) {
    return { eligible: false, reason: "no_date" };
  }

  if (context.recentlyUsedUrls.has(item.canonicalUrl)) {
    return { eligible: false, reason: "used_recently" };
  }
  if (item.confidence < MIN_CONFIDENCE) {
    return { eligible: false, reason: "low_confidence" };
  }
  if (item.score < MIN_SCORE) {
    return { eligible: false, reason: "low_score" };
  }

  return { eligible: true };
}

/** Threshold below which the issue is flagged as thin. */
export const MIN_ITEMS_FOR_FULL_ISSUE = 4;
