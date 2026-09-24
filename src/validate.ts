import {
  DEFAULT_MAX_READING_MINUTES,
  DEFAULT_PREHEADER_MAX,
  DEFAULT_SUBJECT_MAX,
  DEFAULT_SUBJECT_MIN,
} from "./config.ts";
import { safeFetch } from "./net.ts";
import { ADDRESS_PLACEHOLDER, UNSUBSCRIBE_PLACEHOLDER } from "./render.ts";
import { MIN_ITEMS_FOR_FULL_ISSUE } from "./score.ts";
import type {
  CheckFinding,
  FactsPack,
  GeneratedVariant,
  RenderedEmail,
  ValidationReport,
  VariantKind,
} from "./types.ts";
import { VARIANT_KINDS } from "./types.ts";

export function report(findings: CheckFinding[]): ValidationReport {
  const blockers = findings.filter((finding) => finding.severity === "block");
  const warnings = findings.filter((finding) => finding.severity === "warn");
  return { findings, blockers, warnings, ok: blockers.length === 0 };
}

/* --------------------------------------------------------- content checks */

export function runContentChecks(
  variants: GeneratedVariant[],
  factsPack: FactsPack,
  options: { now: Date; readingMinutesByKind?: Partial<Record<VariantKind, number>> },
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const knownIds = new Set(factsPack.items.map((item) => item.source_item_id));

  if (variants.length !== VARIANT_KINDS.length) {
    findings.push({
      code: "variant_count",
      severity: "block",
      message: `Expected ${VARIANT_KINDS.length} variants, found ${variants.length}`,
    });
  }

  if (factsPack.items.length < MIN_ITEMS_FOR_FULL_ISSUE) {
    findings.push({
      code: "thin_issue",
      severity: "warn",
      message: `Only ${factsPack.items.length} eligible items this month; consider a light edition or no send.`,
    });
  }

  for (const variant of variants) {
    const kind = variant.kind;
    const subjectLength = variant.subject.trim().length;

    if (subjectLength < DEFAULT_SUBJECT_MIN || subjectLength > DEFAULT_SUBJECT_MAX) {
      findings.push({
        code: "subject_length",
        severity: "warn",
        variantKind: kind,
        message: `Subject is ${subjectLength} characters (preferred ${DEFAULT_SUBJECT_MIN}-${DEFAULT_SUBJECT_MAX}).`,
      });
    }

    if (variant.preheader.trim().length > DEFAULT_PREHEADER_MAX) {
      findings.push({
        code: "preheader_length",
        severity: "warn",
        variantKind: kind,
        message: `Preheader exceeds ${DEFAULT_PREHEADER_MAX} characters.`,
      });
    }

    const seen = new Set<string>();
    let itemCount = 0;
    let primaryCtaMentions = 0;

    for (const section of variant.sections) {
      for (const item of section.items) {
        itemCount += 1;

        if (item.sourceItemIds.length === 0) {
          findings.push({
            code: "missing_source",
            severity: "block",
            variantKind: kind,
            message: `"${item.headline}" has no source.`,
          });
        }

        for (const id of item.sourceItemIds) {
          if (!knownIds.has(id)) {
            findings.push({
              code: "unapproved_source",
              severity: "block",
              variantKind: kind,
              message: `"${item.headline}" cites unapproved source ${id}.`,
            });
          }
          if (seen.has(id)) {
            findings.push({
              code: "repeated_item",
              severity: "block",
              variantKind: kind,
              message: `Source ${id} appears more than once in this edition.`,
            });
          }
          seen.add(id);

          const fact = factsPack.items.find((entry) => entry.source_item_id === id);
          if (fact?.event_start_at) {
            const isFutureSection = /upcoming|coming up|events|what's on|calendar|ahead/i.test(
              section.heading,
            );
            if (isFutureSection && Date.parse(fact.event_start_at) < options.now.getTime()) {
              findings.push({
                code: "past_event_in_future_section",
                severity: "block",
                variantKind: kind,
                message: `"${fact.title}" already happened but sits in "${section.heading}".`,
              });
            }
          }
        }

        if (item.ctaUrl === variant.primaryCta.url) primaryCtaMentions += 1;
      }
    }

    if (itemCount === 0) {
      findings.push({
        code: "empty_edition",
        severity: "block",
        variantKind: kind,
        message: "Edition has no content items.",
      });
    }

    if (primaryCtaMentions > 1) {
      findings.push({
        code: "cta_repeated",
        severity: "warn",
        variantKind: kind,
        message: "The primary CTA link is repeated inside the body.",
      });
    }

    const minutes = options.readingMinutesByKind?.[kind];
    if (minutes && minutes > DEFAULT_MAX_READING_MINUTES) {
      findings.push({
        code: "reading_time",
        severity: "warn",
        variantKind: kind,
        message: `Estimated reading time is ${minutes} minutes (target ${DEFAULT_MAX_READING_MINUTES}).`,
      });
    }
  }

  return findings;
}

/* ------------------------------------------------------------ link checks */

export type LinkCheck = {
  url: string;
  status: number;
  ok: boolean;
  checkedAt: string;
  error?: string;
  primary: boolean;
};

/**
 * HEAD first, falling back to a bounded GET, because several Volta pages do not
 * answer HEAD. Redirect and host safety are enforced inside `safeFetch`.
 */
export async function checkLink(url: string, primary: boolean): Promise<LinkCheck> {
  const checkedAt = new Date().toISOString();
  try {
    let response = await safeFetch(url, { method: "HEAD", readBody: false, timeoutMs: 8000 });
    if (response.status === 405 || response.status === 501 || response.status === 403) {
      response = await safeFetch(url, { method: "GET", maxBytes: 200_000, timeoutMs: 8000 });
    }
    return {
      url,
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      checkedAt,
      primary,
    };
  } catch (error) {
    return {
      url,
      status: 0,
      ok: false,
      checkedAt,
      primary,
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}

export function collectLinks(variant: GeneratedVariant): Array<{ url: string; primary: boolean }> {
  const links = new Map<string, boolean>();
  links.set(variant.primaryCta.url, true);
  for (const section of variant.sections) {
    for (const item of section.items) {
      if (item.ctaUrl && !links.has(item.ctaUrl)) links.set(item.ctaUrl, false);
    }
  }
  return [...links.entries()].map(([url, primary]) => ({ url, primary }));
}

export async function runLinkChecks(
  variant: GeneratedVariant,
): Promise<{ findings: CheckFinding[]; checks: LinkCheck[] }> {
  const targets = collectLinks(variant);
  const checks = await Promise.all(targets.map((target) => checkLink(target.url, target.primary)));
  const findings: CheckFinding[] = [];

  for (const check of checks) {
    if (check.ok) continue;
    findings.push({
      code: check.primary ? "primary_link_broken" : "secondary_link_broken",
      severity: check.primary ? "block" : "warn",
      variantKind: variant.kind,
      message: `${check.primary ? "Primary CTA" : "Link"} ${check.url} failed (${check.error ?? `HTTP ${check.status}`}).`,
    });
  }

  return { findings, checks };
}

/* ----------------------------------------------------------- email checks */

const FORBIDDEN_MARKUP = /<\s*(script|form|iframe|object|embed|applet)\b/i;
const MERGE_TAG = /\*\|[A-Z0-9_:]+\|\*/g;
const APPROVED_MERGE_TAGS = new Set([UNSUBSCRIBE_PLACEHOLDER, ADDRESS_PLACEHOLDER]);
const UNRESOLVED_TOKEN = /\{\{\s*[\w.]+\s*\}\}|\$\{[\w.]+\}/;

export function runEmailChecks(
  rendered: RenderedEmail,
  options: { kind?: VariantKind; usesProviderTemplate: boolean } = { usesProviderTemplate: false },
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const add = (code: string, severity: CheckFinding["severity"], message: string) =>
    findings.push({ code, severity, message, variantKind: options.kind });

  if (rendered.html.trim().length === 0) add("empty_html", "block", "HTML body is empty.");
  if (rendered.text.trim().length === 0) add("empty_text", "block", "Plain-text body is empty.");

  // With a provider template the ESP owns the footer, so the placeholder check
  // only applies to bodies this system renders end to end.
  if (!options.usesProviderTemplate && !rendered.html.includes(UNSUBSCRIBE_PLACEHOLDER)) {
    add("missing_unsubscribe", "block", "HTML body has no unsubscribe placeholder.");
  }
  if (!options.usesProviderTemplate && !rendered.text.includes(UNSUBSCRIBE_PLACEHOLDER)) {
    add("missing_unsubscribe_text", "block", "Plain-text body has no unsubscribe placeholder.");
  }
  if (!options.usesProviderTemplate && !rendered.html.includes(ADDRESS_PLACEHOLDER)) {
    add("missing_sender_identification", "block", "HTML body has no sender identification placeholder.");
  }

  if (FORBIDDEN_MARKUP.test(rendered.html)) {
    add("forbidden_markup", "block", "HTML body contains script, form, iframe, or embedded content.");
  }

  for (const match of rendered.html.match(MERGE_TAG) ?? []) {
    if (!APPROVED_MERGE_TAGS.has(match)) {
      add("unknown_merge_tag", "warn", `Unexpected merge tag ${match}.`);
    }
  }

  if (UNRESOLVED_TOKEN.test(rendered.html)) {
    add("unresolved_token", "block", "HTML body contains an unresolved template token.");
  }

  for (const image of rendered.html.match(/<img\b[^>]*>/gi) ?? []) {
    if (!/\balt\s*=\s*["'][^"']*["']/i.test(image)) {
      add("image_missing_alt", "block", "An image has no alt text.");
    }
  }

  return findings;
}

/* ---------------------------------------------------------- quality score */

/** 0-100 heuristic used to rank the three variants for the recommendation. */
export function qualityScore(
  variant: GeneratedVariant,
  findings: CheckFinding[],
  factsPack: FactsPack,
  readingMinutesValue: number,
): number {
  const mine = findings.filter((finding) => !finding.variantKind || finding.variantKind === variant.kind);
  const items = variant.sections.flatMap((section) => section.items);
  const citedIds = new Set(items.flatMap((item) => item.sourceItemIds));

  const coverage = factsPack.items.length === 0 ? 0 : citedIds.size / factsPack.items.length;
  const firstParty = [...citedIds].filter((id) =>
    factsPack.items.find((item) => item.source_item_id === id)?.source_authority === "volta",
  ).length;
  const firstPartyRatio = citedIds.size === 0 ? 0 : firstParty / citedIds.size;

  let score = 50;
  score += Math.round(Math.min(1, coverage) * 15);
  score += Math.round(firstPartyRatio * 15);
  score += Math.min(10, items.length * 2);
  score += readingMinutesValue <= DEFAULT_MAX_READING_MINUTES ? 10 : 0;
  score -= mine.filter((finding) => finding.severity === "warn").length * 4;
  score -= mine.filter((finding) => finding.severity === "block").length * 25;

  return Math.max(0, Math.min(100, score));
}

/* --------------------------------------------------------- release policy */

export type ReleaseContext = {
  approverAuthorized: boolean;
  audienceId?: string;
  approvedChecksum?: string | null;
  currentChecksum: string;
  approvalAgeMinutes: number;
  approvalTtlMinutes: number;
  duplicateIdempotencyKey: boolean;
};

/** Final gate immediately before a live send. */
export function releaseChecks(context: ReleaseContext): CheckFinding[] {
  const findings: CheckFinding[] = [];

  if (!context.approverAuthorized) {
    findings.push({ code: "unauthorized_approver", severity: "block", message: "Approver is not on the allowlist." });
  }
  if (!context.audienceId) {
    findings.push({ code: "unknown_audience", severity: "block", message: "No audience is configured." });
  }
  if (context.approvedChecksum && context.approvedChecksum !== context.currentChecksum) {
    findings.push({ code: "variant_changed", severity: "block", message: "The variant changed after approval." });
  }
  if (context.approvalAgeMinutes > context.approvalTtlMinutes) {
    findings.push({ code: "approval_expired", severity: "block", message: "Approval expired; run preflight again." });
  }
  if (context.duplicateIdempotencyKey) {
    findings.push({ code: "duplicate_send", severity: "block", message: "This send was already attempted." });
  }

  return findings;
}

export function summarizeFindings(findings: CheckFinding[]): string {
  if (findings.length === 0) return "No warnings.";
  return findings
    .map((finding) => `${finding.severity === "block" ? "BLOCK" : "warn"} · ${finding.message}`)
    .join("\n");
}
