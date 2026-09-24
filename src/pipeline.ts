import { APPROVAL_TTL_MINUTES, assertCapability, type Config } from "./config.ts";
import { collectAll, selectEligibleItems } from "./collect.ts";
import {
  claimSendAttempt,
  finishJob,
  getIssue,
  getIssueByMonth,
  getLiveSendAttempt,
  getVariant,
  insertVariant,
  latestVariants,
  listIssuesAwaitingMetrics,
  logAudit,
  markIssueSent,
  markSourceItemsUsed,
  nextRevision,
  recordApproval,
  replaceIssueItems,
  saveMetrics,
  setIssueFactsPack,
  setIssueReview,
  setIssueSlackMessage,
  transitionIssue,
  updateSendAttempt,
  updateVariantMailchimp,
  updateVariantRendered,
  upsertIssue,
} from "./db.ts";
import {
  createCampaign,
  createDraftCampaign,
  EspError,
  getAudienceSummary,
  getCampaignReport,
  reconcileSend,
  sendCampaign,
  sendCampaignTest,
  setCampaignContent,
} from "./email.ts";
import { buildFactsPack, generateIssue, GenerationError } from "./generate.ts";
import { previewUrl, signPreviewToken } from "./preview.ts";
import { renderSourceLedger, renderVariant } from "./render.ts";
import { hoursSince, issueIdForMonth, monthKeyOf, monthLabel } from "./schedule.ts";
import { buildReviewBlocks, slackApiWithRetry } from "./slack.ts";
import type {
  CheckFinding,
  FactsPack,
  GeneratedVariant,
  IssueRecord,
  VariantKind,
  VariantRecord,
} from "./types.ts";
import {
  qualityScore,
  releaseChecks,
  report,
  runContentChecks,
  runEmailChecks,
  runLinkChecks,
} from "./validate.ts";
import { newId, nowIso, sha256Hex, maskEmail } from "./util.ts";

export async function variantChecksum(variant: GeneratedVariant): Promise<string> {
  return sha256Hex(JSON.stringify(variant));
}

/**
 * Campaign content is still sent as fully rendered HTML, because inserting into
 * a Mailchimp template requires that template's section names. Until those are
 * supplied, this system owns the footer and must keep proving the unsubscribe
 * and sender-identification placeholders are present.
 */
function usesProviderTemplate(_config: Config): boolean {
  return false;
}

export async function sendIdempotencyKey(
  issueId: string,
  variantId: string,
  audienceId: string,
  mode: "test" | "live",
): Promise<string> {
  return sha256Hex(`${issueId}:${variantId}:${audienceId}:${mode}`);
}

/* ------------------------------------------------------------ collection */

export type CollectStageResult = {
  issue: IssueRecord;
  factsPack: FactsPack;
  warnings: CheckFinding[];
  collectedCount: number;
  eligibleCount: number;
};

/**
 * Stage 1 of the month: gather sources and store the canonical facts pack.
 * Safe to run more than once; the facts pack is simply refreshed.
 */
export async function runCollectStage(
  db: D1Database,
  config: Config,
  now: Date = new Date(),
): Promise<CollectStageResult> {
  const monthKey = monthKeyOf(now, config.timezone);
  const issue = await upsertIssue(db, {
    id: issueIdForMonth(monthKey),
    monthKey,
    status: "collecting",
    primaryCta: config.primaryCta || null,
  });

  const collection = await collectAll(db, config);
  const selection = await selectEligibleItems(db, now);

  const warnings: CheckFinding[] = collection.warnings.map((warning) => ({
    code: warning.code,
    severity: warning.code === "all_first_party_failed" ? "block" : "warn",
    message: warning.message,
  }));

  const factsPack = buildFactsPack({
    issueId: issue.id,
    monthKey,
    items: selection.selected,
    primaryCta: config.primaryCta,
    timezone: config.timezone,
    generatedAt: nowIso(now),
  });

  await setIssueFactsPack(db, issue.id, factsPack, warnings);
  await replaceIssueItems(db, issue.id, selection.selected.map((item) => item.id));
  await logAudit(db, {
    issueId: issue.id,
    actor: "system",
    action: "collect",
    detail: {
      collected: collection.items.length,
      eligible: selection.selected.length,
      failedSources: collection.failedSources,
      durationMs: collection.durationMs,
    },
  });

  return {
    issue: (await getIssue(db, issue.id)) ?? issue,
    factsPack,
    warnings,
    collectedCount: collection.items.length,
    eligibleCount: selection.selected.length,
  };
}

/* ------------------------------------------------------------ generation */

async function storeVariant(
  db: D1Database,
  config: Config,
  issue: IssueRecord,
  factsPack: FactsPack,
  generated: GeneratedVariant,
  findings: CheckFinding[],
): Promise<VariantRecord> {
  const rendered = renderVariant(generated, {
    monthKey: issue.monthKey,
    timezone: config.timezone,
    factsPack,
  });

  const emailFindings = runEmailChecks(rendered, {
    kind: generated.kind,
    usesProviderTemplate: usesProviderTemplate(config),
  });
  const variantFindings = [
    ...findings.filter((finding) => finding.variantKind === generated.kind),
    ...emailFindings,
  ];

  const record: VariantRecord = {
    id: newId("var"),
    issueId: issue.id,
    kind: generated.kind,
    subject: generated.subject,
    preheader: generated.preheader,
    structured: generated,
    htmlBody: rendered.html,
    textBody: rendered.text,
    checksum: await variantChecksum(generated),
    qualityScore: qualityScore(generated, variantFindings, factsPack, rendered.readingMinutes),
    readingMinutes: rendered.readingMinutes,
    warnings: variantFindings,
    revision: await nextRevision(db, issue.id, generated.kind),
    createdAt: nowIso(),
  };

  await insertVariant(db, record);
  return record;
}

export type PublishStageResult = {
  issue: IssueRecord;
  variants: VariantRecord[];
  findings: CheckFinding[];
  posted: boolean;
};

/**
 * Stage 2 of the month: refresh time-sensitive sources, generate the three
 * variants, run deterministic checks, and post the Slack review card.
 */
export async function runPublishStage(
  db: D1Database,
  config: Config,
  options: { now?: Date; post?: boolean } = {},
): Promise<PublishStageResult> {
  const now = options.now ?? new Date();
  assertCapability(config, "draft");

  const collectResult = await runCollectStage(db, config, now);
  const issue = collectResult.issue;
  const factsPack = collectResult.factsPack;

  if (factsPack.items.length === 0) {
    await transitionIssue(db, issue.id, ["collecting", "drafted", "review"], "failed");
    throw new GenerationError("No eligible source items; nothing can be generated this month.");
  }

  const generation = await generateIssue(config, factsPack);

  const findings: CheckFinding[] = [...collectResult.warnings];
  findings.push(...runContentChecks(generation.issue.variants, factsPack, { now }));

  const variants: VariantRecord[] = [];
  for (const generated of generation.issue.variants) {
    variants.push(await storeVariant(db, config, issue, factsPack, generated, findings));
  }

  for (const variant of variants) {
    const linkResult = await runLinkChecks(variant.structured);
    findings.push(...linkResult.findings);
  }

  const recommended = pickRecommended(variants, findings);
  await transitionIssue(db, issue.id, ["collecting", "drafted", "review", "failed"], "drafted");
  await setIssueReview(db, issue.id, { recommendedVariant: recommended.kind, warnings: findings });

  const withDrafts = await pushMailchimpDrafts(db, config, issue.id);

  let posted = false;
  if (options.post !== false) {
    posted = await postReviewCard(db, config, issue.id);
  }

  await logAudit(db, {
    issueId: issue.id,
    actor: "system",
    action: "generate",
    detail: {
      attempts: generation.attempts,
      recommended: recommended.kind,
      blockers: findings.filter((finding) => finding.severity === "block").length,
      warnings: findings.filter((finding) => finding.severity === "warn").length,
      mailchimpDrafts: withDrafts.filter((variant) => variant.mailchimpCampaignId).length,
    },
  });

  return {
    issue: (await getIssue(db, issue.id)) ?? issue,
    variants: withDrafts,
    findings,
    posted,
  };
}

function pickRecommended(variants: VariantRecord[], findings: CheckFinding[]): VariantRecord {
  const blocked = new Set(
    findings.filter((finding) => finding.severity === "block").map((finding) => finding.variantKind),
  );
  const clean = variants.filter((variant) => !blocked.has(variant.kind));
  const pool = clean.length > 0 ? clean : variants;
  return [...pool].sort((a, b) => {
    if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
    // Volta's monthly edition is founders-first, so break ties that way.
    if (a.kind === "founder_signal") return -1;
    if (b.kind === "founder_signal") return 1;
    return 0;
  })[0]!;
}

/* ----------------------------------------------------------------- slack */

export async function postReviewCard(
  db: D1Database,
  config: Config,
  issueId: string,
): Promise<boolean> {
  const issue = await getIssue(db, issueId);
  if (!issue || !issue.factsPack) return false;

  if (!config.slack.botToken || !config.slack.reviewChannelId) return false;

  const variants = await latestVariants(db, issueId);
  const tokens = new Map<string, string>();
  for (const variant of variants) {
    if (config.previewSigningSecret) {
      tokens.set(variant.id, await signPreviewToken(config, variant.id));
    }
  }

  const findings = issue.warnings;
  const brokenLinks = findings.filter((finding) => finding.code.endsWith("link_broken")).length;

  const blocks = buildReviewBlocks(
    {
      issueId,
      monthKey: issue.monthKey,
      generatedAt: issue.factsPack.generated_at,
      recommended: (issue.recommendedVariant ?? "founder_signal") as VariantKind,
      recommendationReason:
        variants.find((variant) => variant.kind === issue.recommendedVariant)?.structured.rationale ??
        "Highest quality score with no blocking checks.",
      variants,
      factsPack: issue.factsPack,
      findings,
      linkStatus: brokenLinks === 0 ? "all links OK" : `${brokenLinks} link issue(s)`,
      previewUrl: (variantId) => {
        const token = tokens.get(variantId);
        return token
          ? previewUrl(config, variantId, token)
          : `${config.appBaseUrl}/preview/${variantId}`;
      },
      liveSendEnabled: config.liveSendEnabled,
    },
    config,
  );

  const channel = issue.slackChannelId ?? config.slack.reviewChannelId;
  const ts = issue.slackMessageTs;
  const method = ts ? "chat.update" : "chat.postMessage";

  const result = await slackApiWithRetry(config, method, {
    channel,
    ...(ts ? { ts } : {}),
    text: `Volta monthly review · ${monthLabel(issue.monthKey)}`,
    blocks,
  });

  if (result.ts && (result.channel || channel)) {
    await setIssueSlackMessage(db, issueId, result.channel ?? channel, result.ts);
  }
  await transitionIssue(db, issueId, ["drafted", "review"], "review");
  return true;
}

/**
 * Create or refresh Mailchimp *draft* campaigns for the latest variants.
 * Nothing is sent. Reviewers edit in Mailchimp, then Slack "Send test" / approve.
 */
export async function pushMailchimpDrafts(
  db: D1Database,
  config: Config,
  issueId: string,
  onlyVariantIds?: string[],
): Promise<VariantRecord[]> {
  const variants = await latestVariants(db, issueId);
  const audienceId = config.esp.testAudienceId || config.esp.audienceId;
  if (!config.esp.apiKey || !config.esp.replyTo || !audienceId) return variants;

  const issue = await getIssue(db, issueId);
  const updated: VariantRecord[] = [];

  for (const original of variants) {
    if (onlyVariantIds && !onlyVariantIds.includes(original.id)) {
      updated.push(original);
      continue;
    }

    let variant = original;
    try {
      let htmlBody = variant.htmlBody;
      let textBody = variant.textBody;
      if (issue?.factsPack) {
        const rendered = renderVariant(variant.structured, {
          monthKey: issue.monthKey,
          timezone: config.timezone,
          factsPack: issue.factsPack,
        });
        htmlBody = rendered.html;
        textBody = rendered.text;
        await updateVariantRendered(db, variant.id, { htmlBody, textBody });
        variant = { ...variant, htmlBody, textBody };
      }

      if (variant.mailchimpCampaignId) {
        await setCampaignContent(config, variant.mailchimpCampaignId, {
          html: htmlBody,
          text: textBody,
        });
        updated.push(variant);
        continue;
      }

      const draft = await createDraftCampaign(
        config,
        {
          audienceId,
          subject: variant.subject,
          preheader: variant.preheader,
          title: `Volta draft ${issue?.monthKey ?? ""} · ${variant.kind} r${variant.revision}`,
        },
        { html: htmlBody, text: textBody },
      );

      await updateVariantMailchimp(db, variant.id, {
        campaignId: draft.id,
        webId: draft.webId,
        editUrl: draft.editUrl,
      });
      updated.push({
        ...variant,
        mailchimpCampaignId: draft.id,
        mailchimpWebId: draft.webId,
        mailchimpEditUrl: draft.editUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      await logAudit(db, {
        issueId,
        actor: "system",
        action: "mailchimp_draft_failed",
        detail: { variantId: variant.id, message },
      });
      updated.push(variant);
    }
  }

  return updated;
}

export async function updateReviewCard(
  config: Config,
  issue: IssueRecord,
  text: string,
): Promise<void> {
  if (!issue.slackChannelId || !issue.slackMessageTs) return;
  await slackApiWithRetry(config, "chat.postMessage", {
    channel: issue.slackChannelId,
    thread_ts: issue.slackMessageTs,
    text,
  });
}

/* ------------------------------------------------------------- revisions */

export async function regenerateVariant(
  db: D1Database,
  config: Config,
  variantId: string,
  note: string,
): Promise<VariantRecord> {
  const previous = await getVariant(db, variantId);
  if (!previous) throw new Error("Variant not found");

  const issue = await getIssue(db, previous.issueId);
  if (!issue?.factsPack) throw new Error("Issue facts pack is missing");

  // Revisions reuse the stored facts pack; sources are not recollected.
  const generation = await generateIssue(config, issue.factsPack, {
    revisionNote: note,
    onlyKind: previous.kind,
  });
  const generated = generation.issue.variants[0];
  if (!generated) throw new Error("Revision returned no variant");

  const findings = runContentChecks([generated], issue.factsPack, { now: new Date() }).filter(
    (finding) => finding.code !== "variant_count",
  );
  const record = await storeVariant(db, config, issue, issue.factsPack, generated, findings);
  const [withDraft] = await pushMailchimpDrafts(db, config, issue.id, [record.id]);

  await logAudit(db, {
    issueId: issue.id,
    actor: "slack",
    action: "revision",
    detail: { variantId, kind: previous.kind, revision: record.revision, note },
  });

  return withDraft ?? record;
}

/* ------------------------------------------------------------------ send */

export type SendOutcome = {
  status: "sent" | "duplicate" | "blocked" | "failed";
  message: string;
  campaignId?: string;
  findings?: CheckFinding[];
};

async function preflight(
  config: Config,
  variant: VariantRecord,
  issue: IssueRecord,
  approverSlackId: string,
  audienceId: string | undefined,
  mode: "test" | "live",
): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];

  const linkResult = await runLinkChecks(variant.structured);
  findings.push(...linkResult.findings);

  findings.push(
    ...runEmailChecks(
      { html: variant.htmlBody, text: variant.textBody, readingMinutes: variant.readingMinutes },
      { kind: variant.kind, usesProviderTemplate: usesProviderTemplate(config) },
    ),
  );

  if (issue.factsPack) {
    findings.push(
      ...runContentChecks([variant.structured], issue.factsPack, { now: new Date() }).filter(
        (finding) => finding.code !== "variant_count",
      ),
    );
  }

  if (mode === "live") {
    findings.push(
      ...releaseChecks({
        approverAuthorized: config.slack.approverIds.includes(approverSlackId),
        audienceId,
        approvedChecksum: issue.approvedChecksum,
        currentChecksum: variant.checksum,
        approvalAgeMinutes: issue.approvedAt
          ? (Date.now() - Date.parse(issue.approvedAt)) / 60_000
          : 0,
        approvalTtlMinutes: APPROVAL_TTL_MINUTES,
        duplicateIdempotencyKey: false,
      }),
    );
  }

  return findings;
}

/** Test send against the non-production audience. Never touches live state. */
export async function sendTest(
  db: D1Database,
  config: Config,
  variantId: string,
  approverSlackId: string,
): Promise<SendOutcome> {
  assertCapability(config, "test_send");

  const variant = await getVariant(db, variantId);
  if (!variant) return { status: "failed", message: "Variant not found." };
  const issue = await getIssue(db, variant.issueId);
  if (!issue) return { status: "failed", message: "Issue not found." };

  const audienceId = config.esp.testAudienceId!;
  const testInbox = config.esp.replyTo;
  if (!testInbox) {
    return { status: "failed", message: "ESP_REPLY_TO is not set, so there is no inbox to send a test to." };
  }

  const key = await sendIdempotencyKey(
    issue.id,
    `${variant.id}:${Math.floor(Date.now() / 120_000)}`,
    audienceId,
    "test",
  );
  const claim = await claimSendAttempt(db, {
    issueId: issue.id,
    variantId: variant.id,
    audienceId,
    mode: "test",
    idempotencyKey: key,
    approverSlackId,
  });

  if (!claim.claimed) {
    return {
      status: "duplicate",
      message: `Test already ${claim.attempt.status} for this revision.`,
      campaignId: claim.attempt.providerCampaignId ?? undefined,
    };
  }

  try {
    await updateSendAttempt(db, claim.attempt.id, { status: "creating" });
    const campaignId = await createCampaign(config, {
      audienceId,
      subject: `[TEST] ${variant.subject}`,
      preheader: variant.preheader,
      title: `Volta Signal TEST ${issue.monthKey} ${variant.kind}`,
    });
    await setCampaignContent(config, campaignId, {
      html: variant.htmlBody,
      text: variant.textBody,
    });
    await updateSendAttempt(db, claim.attempt.id, { status: "testing", providerCampaignId: campaignId });
    await sendCampaignTest(config, campaignId, [testInbox]);
    await updateSendAttempt(db, claim.attempt.id, { status: "sent", sentAt: nowIso() });

    await logAudit(db, {
      issueId: issue.id,
      actor: approverSlackId,
      action: "send_test",
      detail: { variantId, campaignId, inbox: maskEmail(testInbox) },
    });
    return {
      status: "sent",
      message: `Test sent to ${maskEmail(testInbox)}. Check that inbox and Spam/Promotions. Subject starts with [TEST].`,
      campaignId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    await updateSendAttempt(db, claim.attempt.id, {
      status: "failed",
      errorCode: error instanceof EspError ? String(error.status) : "unknown",
      errorMessage: message,
    });
    // A failed test must not affect live eligibility.
    return { status: "failed", message: `Test send failed: ${message}` };
  }
}

/**
 * The single consequential action. Approval, preflight, state transition, and
 * exactly one provider send call behind a unique idempotency key.
 */
export async function approveAndSend(
  db: D1Database,
  config: Config,
  variantId: string,
  approverSlackId: string,
): Promise<SendOutcome> {
  if (!config.liveSendEnabled) {
    return { status: "blocked", message: "Live send is disabled (LIVE_SEND_ENABLED=false)." };
  }
  assertCapability(config, "live_send");

  if (!config.slack.approverIds.includes(approverSlackId)) {
    await logAudit(db, { actor: approverSlackId, action: "unauthorized_send_attempt", detail: { variantId } });
    return { status: "blocked", message: "You are not on the approver allowlist." };
  }

  const variant = await getVariant(db, variantId);
  if (!variant) return { status: "failed", message: "Variant not found." };

  let issue = await getIssue(db, variant.issueId);
  if (!issue) return { status: "failed", message: "Issue not found." };

  if (issue.status === "sent") {
    return { status: "duplicate", message: `Issue ${issue.monthKey} was already sent.` };
  }

  const moved = await transitionIssue(db, issue.id, ["drafted", "review"], "approved");
  if (!moved && issue.status !== "approved") {
    return { status: "blocked", message: `Issue is ${issue.status}; nothing sent.` };
  }
  await recordApproval(db, issue.id, variant.id, variant.checksum, approverSlackId);
  issue = (await getIssue(db, issue.id))!;

  const audienceId = config.esp.audienceId!;
  const findings = await preflight(config, variant, issue, approverSlackId, audienceId, "live");
  const validation = report(findings);
  if (!validation.ok) {
    await transitionIssue(db, issue.id, ["approved"], "review");
    await logAudit(db, {
      issueId: issue.id,
      actor: approverSlackId,
      action: "send_blocked",
      detail: { blockers: validation.blockers },
    });
    return {
      status: "blocked",
      message: "Preflight blocked the send; the issue is back in review.",
      findings: validation.blockers,
    };
  }

  const key = await sendIdempotencyKey(issue.id, variant.id, audienceId, "live");
  const claim = await claimSendAttempt(db, {
    issueId: issue.id,
    variantId: variant.id,
    audienceId,
    mode: "live",
    idempotencyKey: key,
    approverSlackId,
  });

  if (!claim.claimed) {
    return {
      status: "duplicate",
      message: `Send already ${claim.attempt.status}. No second provider call was made.`,
      campaignId: claim.attempt.providerCampaignId ?? undefined,
    };
  }

  const sending = await transitionIssue(db, issue.id, ["approved"], "sending");
  if (!sending) {
    await updateSendAttempt(db, claim.attempt.id, {
      status: "failed",
      errorCode: "state",
      errorMessage: "Issue was not in the approved state",
    });
    return { status: "blocked", message: "Issue state changed; nothing sent." };
  }

  let campaignId: string | undefined;
  try {
    await updateSendAttempt(db, claim.attempt.id, { status: "creating" });
    campaignId = await createCampaign(config, {
      audienceId,
      subject: variant.subject,
      preheader: variant.preheader,
      title: `Volta monthly ${issue.monthKey} · ${variant.kind}`,
    });
    await setCampaignContent(config, campaignId, { html: variant.htmlBody, text: variant.textBody });
    await updateSendAttempt(db, claim.attempt.id, { status: "sending", providerCampaignId: campaignId });

    await sendCampaign(config, campaignId);

    await updateSendAttempt(db, claim.attempt.id, { status: "sent", sentAt: nowIso() });
    await markIssueSent(db, issue.id);
    await markSourceItemsUsed(
      db,
      issue.factsPack?.items.map((item) => item.source_item_id) ?? [],
    );
    await logAudit(db, {
      issueId: issue.id,
      actor: approverSlackId,
      action: "send_live",
      detail: { variantId, campaignId, checksum: variant.checksum },
    });

    return { status: "sent", message: "Edition sent.", campaignId };
  } catch (error) {
    const ambiguous = error instanceof EspError && error.ambiguous;

    if (ambiguous && campaignId) {
      // Never repeat the send call after a timeout; ask the provider instead.
      const state = await reconcileSend(config, campaignId).catch(() => "not_sent" as const);
      if (state === "sent") {
        await updateSendAttempt(db, claim.attempt.id, { status: "sent", sentAt: nowIso(), providerCampaignId: campaignId });
        await markIssueSent(db, issue.id);
        await logAudit(db, {
          issueId: issue.id,
          actor: approverSlackId,
          action: "send_live_reconciled",
          detail: { campaignId },
        });
        return { status: "sent", message: "Send confirmed after an ambiguous provider response.", campaignId };
      }
    }

    const message = error instanceof Error ? error.message : "unknown error";
    await updateSendAttempt(db, claim.attempt.id, {
      status: "failed",
      errorCode: error instanceof EspError ? String(error.status) : "unknown",
      errorMessage: message,
      providerCampaignId: campaignId ?? null,
    });
    await transitionIssue(db, issue.id, ["sending"], "failed");
    await logAudit(db, {
      issueId: issue.id,
      actor: approverSlackId,
      action: "send_failed",
      detail: { message, campaignId },
    });
    return { status: "failed", message: `Send failed: ${message}`, campaignId };
  }
}

/* --------------------------------------------------------------- metrics */

export async function ingestMetrics(db: D1Database, config: Config, now: Date = new Date()): Promise<number> {
  if (!config.esp.apiKey) return 0;
  let updated = 0;

  for (const phase of ["early", "settled"] as const) {
    const threshold = phase === "early" ? config.metricsEarlyAfterHours : config.metricsSettledAfterHours;
    const issues = await listIssuesAwaitingMetrics(db, phase);

    for (const issue of issues) {
      if (!issue.sentAt || hoursSince(issue.sentAt, now) < threshold) continue;
      const attempt = await getLiveSendAttempt(db, issue.id);
      if (!attempt?.providerCampaignId) continue;

      try {
        const metrics = await getCampaignReport(config, attempt.providerCampaignId);
        await saveMetrics(db, {
          issueId: issue.id,
          phase,
          providerCampaignId: attempt.providerCampaignId,
          ...metrics,
        });
        updated += 1;
      } catch (error) {
        await logAudit(db, {
          issueId: issue.id,
          actor: "system",
          action: "metrics_failed",
          detail: { phase, message: error instanceof Error ? error.message : "unknown" },
        });
      }
    }
  }

  return updated;
}

/* ------------------------------------------------------------- utilities */

export async function sourceLedgerText(db: D1Database, variantId: string): Promise<string> {
  const variant = await getVariant(db, variantId);
  if (!variant) return "Variant not found.";
  const issue = await getIssue(db, variant.issueId);
  if (!issue?.factsPack) return "Facts pack not found.";
  return renderSourceLedger(variant.structured, issue.factsPack) || "No sources cited.";
}

export async function audienceSummaryOrNull(
  config: Config,
  audienceId: string | undefined,
): Promise<{ name: string; memberCount: number | null }> {
  if (!audienceId || !config.esp.apiKey) return { name: audienceId ?? "not configured", memberCount: null };
  try {
    const summary = await getAudienceSummary(config, audienceId);
    return { name: summary.name, memberCount: summary.memberCount };
  } catch {
    return { name: audienceId, memberCount: null };
  }
}

export async function currentIssue(
  db: D1Database,
  config: Config,
  now: Date = new Date(),
): Promise<IssueRecord | null> {
  return getIssueByMonth(db, monthKeyOf(now, config.timezone));
}

export { finishJob };
