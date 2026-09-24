import type { SourceDefinition } from "./types.ts";

/**
 * Allowlist of sources. Only URLs that have been verified against the live site
 * are enabled; everything else stays disabled with a note describing the exact
 * input required before it can be turned on.
 */
export const SOURCES: SourceDefinition[] = [
  {
    id: "volta_events_ics",
    label: "Volta events calendar",
    url: "https://calendar.voltaeffect.com/api/calendar/ics",
    kind: "ics",
    authority: "volta",
    defaultAudience: ["founder", "builder", "public"],
    firstParty: true,
    enabled: true,
    province: "NS",
  },
  {
    id: "volta_blog",
    label: "Volta news",
    url: "https://voltaeffect.com/blog",
    kind: "html_index",
    authority: "volta",
    defaultAudience: ["founder", "builder", "coach", "public"],
    firstParty: true,
    enabled: true,
    province: "NS",
    linkPattern: "/news/",
  },
  {
    id: "volta_sitemap_news",
    label: "Volta news (sitemap fallback)",
    url: "https://voltaeffect.com/sitemap.xml",
    kind: "sitemap",
    authority: "volta",
    defaultAudience: ["founder", "builder", "public"],
    firstParty: true,
    enabled: true,
    province: "NS",
    linkPattern: "/news/",
    note: "Stable fallback used when the blog markup changes.",
  },
  {
    id: "volta_events_page",
    label: "Volta events page",
    url: "https://voltaeffect.com/events",
    kind: "jsonld",
    authority: "volta",
    defaultAudience: ["founder", "builder", "public"],
    firstParty: true,
    enabled: true,
    province: "NS",
  },
  {
    id: "volta_ai_residency",
    label: "AI Residency",
    url: "https://voltaeffect.com/ai-residency",
    kind: "html_page",
    authority: "volta",
    defaultAudience: ["founder", "builder"],
    firstParty: true,
    enabled: true,
    evergreen: true,
    province: "NS",
  },
  {
    id: "volta_ai_small_business",
    label: "AI for Small Business",
    url: "https://voltaeffect.com/ai-for-small-business",
    kind: "html_page",
    authority: "volta",
    defaultAudience: ["founder", "coach"],
    firstParty: true,
    enabled: true,
    evergreen: true,
    province: "NS",
  },
  {
    id: "volta_community",
    label: "Volta community",
    url: "https://voltaeffect.com/community",
    kind: "html_page",
    authority: "volta",
    defaultAudience: ["founder", "builder", "coach", "public"],
    firstParty: true,
    enabled: true,
    evergreen: true,
    province: "NS",
  },
  {
    id: "internal_signals",
    label: "Approved internal signals",
    url: "",
    kind: "internal",
    authority: "volta",
    defaultAudience: ["founder", "coach"],
    firstParty: true,
    enabled: true,
    note: "Populated by /admin/signal with explicit consent; never fetched.",
  },

  // Disabled until the exact feed URL is confirmed by the named owner.
  {
    id: "official_event_platform",
    label: "Official event platform feed",
    url: "",
    kind: "rss",
    authority: "volta",
    defaultAudience: ["founder", "builder", "public"],
    firstParty: true,
    enabled: false,
    note: "Amy to supply the official calendar/API endpoint (plan section 5).",
  },
  {
    id: "government_programs",
    label: "Federal/provincial program announcements",
    url: "",
    kind: "rss",
    authority: "government",
    defaultAudience: ["founder"],
    firstParty: false,
    enabled: false,
    note: "Add the confirmed ACOA/NS funding feed URL before enabling.",
  },
  {
    id: "ecosystem_publication",
    label: "Regional ecosystem publication",
    url: "",
    kind: "rss",
    authority: "ecosystem",
    defaultAudience: ["founder", "public"],
    firstParty: false,
    enabled: false,
    note: "Pick a small set of credible regional publications with Bader.",
  },
];

export function enabledSources(): SourceDefinition[] {
  return SOURCES.filter((source) => source.enabled && (source.url !== "" || source.kind === "internal"));
}

export function fetchableSources(): SourceDefinition[] {
  return enabledSources().filter((source) => source.kind !== "internal");
}

export function getSource(id: string): SourceDefinition | undefined {
  return SOURCES.find((source) => source.id === id);
}

/** Hostnames the collector is allowed to contact. */
export function allowedHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const source of SOURCES) {
    if (!source.url) continue;
    try {
      hosts.add(new URL(source.url).hostname.toLowerCase());
    } catch {
      // A malformed registry URL is reported during collection, not here.
    }
  }
  return hosts;
}
