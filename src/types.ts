export type Audience = "founder" | "builder" | "coach" | "public";
export type Province = "NS" | "NB" | "PE" | "NL";
export type Consent = "public" | "approved" | "unknown";
export type SourceKind =
  | "rss"
  | "atom"
  | "ics"
  | "jsonld"
  | "html_index"
  | "html_page"
  | "sitemap"
  | "internal";
export type Authority = "volta" | "government" | "company" | "ecosystem";

export type VariantKind = "founder_signal" | "builder_dispatch" | "community_pulse";

export const VARIANT_KINDS: VariantKind[] = [
  "founder_signal",
  "builder_dispatch",
  "community_pulse",
];

export type IssueStatus =
  | "collecting"
  | "drafted"
  | "review"
  | "approved"
  | "sending"
  | "sent"
  | "failed"
  | "expired";

export type SourceDefinition = {
  id: string;
  url: string;
  kind: SourceKind;
  authority: Authority;
  defaultAudience: Audience[];
  /** First-party Volta sources gate the recommendation when they all fail. */
  firstParty: boolean;
  enabled: boolean;
  /** Opportunity pages that stay relevant beyond the monthly news window. */
  evergreen?: boolean;
  province?: Province;
  /** For `html_index` and `sitemap`: substring that identifies a content link. */
  linkPattern?: string;
  label?: string;
  note?: string;
};

export type SourceItem = {
  id: string;
  canonicalUrl: string;
  sourceDomain: string;
  sourceKind: SourceKind;
  sourceId: string;
  title: string;
  evidenceText: string;
  publishedAt?: string;
  eventStartAt?: string;
  eventEndAt?: string;
  province?: Province;
  audiences: Audience[];
  consent: Consent;
  confidence: number;
  score: number;
  scoreBreakdown?: Record<string, number>;
  contentHash: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  lastUsedAt?: string;
};

/** A source item before scoring and hashing, as produced by a parser. */
export type RawItem = {
  url: string;
  title: string;
  evidenceText: string;
  publishedAt?: string;
  eventStartAt?: string;
  eventEndAt?: string;
  province?: Province;
  audiences?: Audience[];
  consent?: Consent;
};

export type CollectionWarning = {
  code: string;
  message: string;
  sourceId?: string;
};

export type CollectionResult = {
  items: SourceItem[];
  warnings: CollectionWarning[];
  durationMs: number;
  failedSources: string[];
  attemptedSources: string[];
};

export type FactsPackItem = {
  source_item_id: string;
  title: string;
  evidence: string;
  url: string;
  published_at?: string;
  event_start_at?: string;
  event_end_at?: string;
  province?: Province;
  audiences: Audience[];
  source_authority: Authority;
  allowed_claims: string[];
};

export type FactsPack = {
  issue_id: string;
  month_key: string;
  cadence: "monthly";
  generated_at: string;
  timezone: string;
  primary_cta: string;
  items: FactsPackItem[];
};

export type GeneratedItem = {
  sourceItemIds: string[];
  headline: string;
  copy: string;
  ctaLabel?: string;
  ctaUrl?: string;
};

export type GeneratedSection = {
  heading: string;
  items: GeneratedItem[];
};

export type GeneratedVariant = {
  kind: VariantKind;
  subject: string;
  preheader: string;
  intro: string;
  primaryCta: { label: string; url: string };
  sections: GeneratedSection[];
  rationale: string;
};

export type GeneratedIssue = {
  variants: GeneratedVariant[];
};

export type Severity = "block" | "warn";

export type CheckFinding = {
  code: string;
  severity: Severity;
  message: string;
  variantKind?: VariantKind;
};

export type ValidationReport = {
  findings: CheckFinding[];
  blockers: CheckFinding[];
  warnings: CheckFinding[];
  ok: boolean;
};

export type RenderedEmail = {
  html: string;
  text: string;
  readingMinutes: number;
};

export type VariantRecord = {
  id: string;
  issueId: string;
  kind: VariantKind;
  subject: string;
  preheader: string;
  structured: GeneratedVariant;
  htmlBody: string;
  textBody: string;
  checksum: string;
  qualityScore: number;
  readingMinutes: number;
  warnings: CheckFinding[];
  revision: number;
  createdAt: string;
  mailchimpCampaignId?: string;
  mailchimpWebId?: number;
  mailchimpEditUrl?: string;
};

export type IssueRecord = {
  id: string;
  monthKey: string;
  status: IssueStatus;
  recommendedVariant: VariantKind | null;
  primaryCta: string | null;
  factsPack: FactsPack | null;
  warnings: CheckFinding[];
  slackChannelId: string | null;
  slackMessageTs: string | null;
  approvedVariantId: string | null;
  approvedChecksum: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
};
