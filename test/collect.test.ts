import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { contentHash, inferAudiences, normalizeItem } from "../src/collect.ts";
import { canonicalizeUrl, isBlockedHost } from "../src/net.ts";
import { parseFeed, parseHtmlIndex, parseHtmlPage, parseIcs, parseJsonLd, parseSitemap } from "../src/parse.ts";
import { stripHtml } from "../src/util.ts";
import { checkEligibility, confidenceFor, type ScoreContext } from "../src/score.ts";
import { getSource } from "../src/sources.ts";
import type { RawItem, SourceDefinition, SourceItem } from "../src/types.ts";

const TZ = "America/Halifax";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

function context(now: Date, overrides: Partial<ScoreContext> = {}): ScoreContext {
  return { now, knownUrls: new Set(), recentlyUsedUrls: new Set(), ...overrides };
}

const voltaBlog = getSource("volta_blog") as SourceDefinition;
const voltaEvents = getSource("volta_events_ics") as SourceDefinition;
const internal = getSource("internal_signals") as SourceDefinition;

/* 1. Normalize and canonicalize an article URL. */

test("canonicalizes article URLs", () => {
  assert.equal(
    canonicalizeUrl("HTTPS://WWW.VoltaEffect.com/news/Seed-Round/?utm_source=x&utm_campaign=y#top"),
    "https://voltaeffect.com/news/Seed-Round",
  );
  assert.equal(
    canonicalizeUrl("/news/cohort-four", "https://voltaeffect.com/blog"),
    "https://voltaeffect.com/news/cohort-four",
  );
  // Parameters that identify a real event are preserved.
  assert.equal(
    canonicalizeUrl("https://voltaeffect.com/events?id=42&utm_medium=email"),
    "https://voltaeffect.com/events?id=42",
  );
});

test("blocks private and metadata hosts", () => {
  for (const host of ["localhost", "127.0.0.1", "169.254.169.254", "10.0.0.5", "192.168.1.1", "metadata.google.internal"]) {
    assert.equal(isBlockedHost(host), true, host);
  }
  assert.equal(isBlockedHost("voltaeffect.com"), false);
});

/* 2. Parse a representative Volta event fixture. */

test("parses the Volta ICS feed with Halifax local times", () => {
  const items = parseIcs(fixture("volta-events.ics"), "https://voltaeffect.com/events", TZ);
  assert.equal(items.length, 4);

  const officeHours = items.find((item) => item.title === "Founder Office Hours");
  assert.ok(officeHours);
  // 13:00 Halifax on 2026-09-10 is ADT (UTC-3).
  assert.equal(officeHours.eventStartAt, "2026-09-10T16:00:00.000Z");
  assert.equal(officeHours.eventEndAt, "2026-09-10T18:00:00.000Z");
  assert.match(officeHours.evidenceText, /Book a 30 minute session/);
  assert.match(officeHours.evidenceText, /Location: Volta, 1505 Barrington St, Halifax/);
  assert.equal(officeHours.url, "https://voltaeffect.com/events/founder-office-hours");

  // A date-only event is treated as lasting the whole day.
  const communityDay = items.find((item) => item.title === "Volta Community Day");
  assert.ok(communityDay);
  assert.equal(
    Date.parse(communityDay.eventEndAt!) - Date.parse(communityDay.eventStartAt!),
    86_400_000,
  );
});

test("parses blog index, sitemap, and JSON-LD fixtures", () => {
  const posts = parseHtmlIndex(fixture("volta-blog.html"), "https://voltaeffect.com/blog", "/news/");
  const urls = posts.map((post) => post.url);
  assert.ok(urls.includes("https://voltaeffect.com/news/atlantic-founder-raises-seed-round"));
  // Tracking parameters and the trailing slash collapse onto one canonical URL.
  assert.equal(urls.filter((url) => url.endsWith("ai-residency-cohort-four")).length, 1);
  assert.equal(posts.find((post) => post.title === "Read More"), undefined);

  const sitemap = parseSitemap(fixture("volta-sitemap.xml"), "https://voltaeffect.com", "/news/");
  assert.equal(sitemap.length, 1);
  assert.equal(sitemap[0]!.title, "Mentor Program Expands to New Brunswick");

  const events = parseJsonLd(fixture("volta-events-jsonld.html"), "https://voltaeffect.com/events");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.eventStartAt, "2026-09-17T22:00:00.000Z");
});

test("parses an RSS feed", () => {
  const xml = `<rss><channel><item>
      <title><![CDATA[Program applications open]]></title>
      <link>https://example.org/post?utm_source=rss</link>
      <description>&lt;p&gt;Apply before the deadline.&lt;/p&gt;</description>
      <pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
    </item></channel></rss>`;
  const items = parseFeed(xml, "https://example.org");
  assert.equal(items.length, 1);
  assert.equal(items[0]!.url, "https://example.org/post");
  assert.equal(items[0]!.evidenceText, "Apply before the deadline.");
  assert.equal(items[0]!.publishedAt, "2026-09-01T10:00:00.000Z");
});

/* 3. Deduplicate an updated versus unchanged item. */

test("content hash is stable for unchanged items and changes on material updates", async () => {
  const raw: RawItem = {
    url: "https://voltaeffect.com/news/seed-round",
    title: "Halifax founder closes seed round",
    evidenceText: "The company will hire in Halifax.",
    publishedAt: "2026-09-08T00:00:00.000Z",
  };

  const first = await contentHash(raw, raw.url);
  const unchanged = await contentHash({ ...raw, title: "  Halifax founder closes seed round " }, raw.url);
  const updated = await contentHash({ ...raw, evidenceText: "The round grew to a second close." }, raw.url);

  assert.equal(first, unchanged);
  assert.notEqual(first, updated);
});

test("decodes hex, decimal, and named HTML entities in titles and evidence", () => {
  // Volta's community page renders apostrophes as &#x27;.
  const page = parseHtmlPage(
    `<html><head><meta name="description" content="Founders &amp; builders &ndash; don&#x27;t build in a bubble." /></head>
     <body><h1>Don&#x27;t build in a bubble</h1></body></html>`,
    "https://voltaeffect.com/community",
  );

  assert.equal(page[0]!.title, "Don't build in a bubble");
  assert.equal(page[0]!.evidenceText, "Founders & builders - don't build in a bubble.");
  assert.equal(stripHtml("<p>Caf&#233; &amp; co&#x2d;work</p>"), "Café & co-work");
});

test("infers audiences from item text and falls back to the source default", () => {
  assert.deepEqual(inferAudiences("Founder office hours and pitch practice", ["public"]), ["founder"]);
  assert.deepEqual(inferAudiences("Quiet announcement", ["public"]), ["public"]);
});

/* 4. Exclude an expired event. */

test("excludes events that already finished and events beyond the window", async () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const items = parseIcs(fixture("volta-events.ics"), "https://voltaeffect.com/events", TZ);

  const past = items.find((item) => item.title === "August Demo Night")!;
  const upcoming = items.find((item) => item.title === "AI Residency Showcase")!;

  const pastItem = (await normalizeItem(past, voltaEvents, context(now)))!;
  const upcomingItem = (await normalizeItem(upcoming, voltaEvents, context(now)))!;

  assert.equal(checkEligibility(pastItem, voltaEvents, context(now)).reason, "event_past");
  assert.equal(checkEligibility(upcomingItem, voltaEvents, context(now)).eligible, true);

  const farOut: SourceItem = { ...upcomingItem, eventStartAt: "2027-03-01T12:00:00.000Z", eventEndAt: "2027-03-01T14:00:00.000Z" };
  assert.equal(checkEligibility(farOut, voltaEvents, context(now)).reason, "event_too_far_out");
});

/* 5. Exclude an internal item without approval. */

test("internal signals require explicit consent", async () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const raw: RawItem = {
    url: "https://voltaeffect.com/community",
    title: "Member closed a major customer this month",
    evidenceText: "Shared by the member during a community check-in.",
    publishedAt: "2026-08-28T00:00:00.000Z",
  };

  const unapproved = (await normalizeItem(raw, internal, context(now)))!;
  assert.equal(unapproved.consent, "unknown");
  assert.equal(checkEligibility(unapproved, internal, context(now)).reason, "consent_unknown");

  const approved = (await normalizeItem({ ...raw, consent: "approved" }, internal, context(now)))!;
  assert.equal(checkEligibility(approved, internal, context(now)).eligible, true);
});

test("suppresses items used in a recent edition", async () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const raw: RawItem = {
    url: "https://voltaeffect.com/news/cohort-four",
    title: "AI Residency opens applications for cohort four",
    evidenceText: "Founders can apply before the deadline this month.",
    publishedAt: "2026-08-29T00:00:00.000Z",
  };
  const item = (await normalizeItem(raw, voltaBlog, context(now)))!;

  const reused = context(now, { recentlyUsedUrls: new Set([item.canonicalUrl]) });
  assert.equal(checkEligibility(item, voltaBlog, reused).reason, "used_recently");
});

test("first-party sources carry the highest confidence", () => {
  assert.equal(confidenceFor(voltaBlog), 25);
  assert.ok(confidenceFor(voltaBlog) > confidenceFor({ ...voltaBlog, authority: "ecosystem", firstParty: false }));
});
