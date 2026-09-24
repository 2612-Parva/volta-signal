import type {
  CheckFinding,
  FactsPack,
  GeneratedVariant,
  IssueRecord,
  IssueStatus,
  SourceItem,
  VariantKind,
  VariantRecord,
} from "./types.ts";
import { newId, nowIso, safeJsonParse } from "./util.ts";

export type SendAttemptRecord = {
  id: string;
  issueId: string;
  variantId: string;
  audienceId: string;
  mode: "test" | "live";
  idempotencyKey: string;
  approverSlackId: string;
  providerCampaignId: string | null;
  status: "approved" | "creating" | "testing" | "sending" | "sent" | "failed";
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
};

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  return String(row[key] ?? "");
}

function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function int(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

export function mapIssue(row: Row): IssueRecord {
  return {
    id: str(row, "id"),
    monthKey: str(row, "month_key"),
    status: str(row, "status") as IssueStatus,
    recommendedVariant: strOrNull(row, "recommended_variant") as VariantKind | null,
    primaryCta: strOrNull(row, "primary_cta"),
    factsPack: safeJsonParse<FactsPack | null>(strOrNull(row, "facts_pack_json"), null),
    warnings: safeJsonParse<CheckFinding[]>(strOrNull(row, "warnings_json"), []),
    slackChannelId: strOrNull(row, "slack_channel_id"),
    slackMessageTs: strOrNull(row, "slack_message_ts"),
    approvedVariantId: strOrNull(row, "approved_variant_id"),
    approvedChecksum: strOrNull(row, "approved_checksum"),
    approvedAt: strOrNull(row, "approved_at"),
    approvedBy: strOrNull(row, "approved_by"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
    sentAt: strOrNull(row, "sent_at"),
  };
}

export function mapSourceItem(row: Row): SourceItem {
  return {
    id: str(row, "id"),
    canonicalUrl: str(row, "canonical_url"),
    sourceDomain: str(row, "source_domain"),
    sourceKind: str(row, "source_kind") as SourceItem["sourceKind"],
    sourceId: str(row, "source_id"),
    title: str(row, "title"),
    evidenceText: str(row, "evidence_text"),
    publishedAt: strOrNull(row, "published_at") ?? undefined,
    eventStartAt: strOrNull(row, "event_start_at") ?? undefined,
    eventEndAt: strOrNull(row, "event_end_at") ?? undefined,
    province: (strOrNull(row, "province") ?? undefined) as SourceItem["province"],
    audiences: safeJsonParse<SourceItem["audiences"]>(strOrNull(row, "audience_json"), []),
    consent: str(row, "consent") as SourceItem["consent"],
    confidence: int(row, "confidence"),
    score: int(row, "score"),
    scoreBreakdown: safeJsonParse<Record<string, number>>(
      strOrNull(row, "score_breakdown_json"),
      {},
    ),
    contentHash: str(row, "content_hash"),
    firstSeenAt: strOrNull(row, "first_seen_at") ?? undefined,
    lastSeenAt: strOrNull(row, "last_seen_at") ?? undefined,
    lastUsedAt: strOrNull(row, "last_used_at") ?? undefined,
  };
}

export function mapVariant(row: Row): VariantRecord {
  return {
    id: str(row, "id"),
    issueId: str(row, "issue_id"),
    kind: str(row, "kind") as VariantKind,
    subject: str(row, "subject"),
    preheader: str(row, "preheader"),
    structured: safeJsonParse<GeneratedVariant>(
      strOrNull(row, "structured_json"),
      {} as GeneratedVariant,
    ),
    htmlBody: str(row, "html_body"),
    textBody: str(row, "text_body"),
    checksum: str(row, "checksum"),
    qualityScore: int(row, "quality_score"),
    readingMinutes: int(row, "reading_minutes"),
    warnings: safeJsonParse<CheckFinding[]>(strOrNull(row, "warnings_json"), []),
    revision: int(row, "revision"),
    createdAt: str(row, "created_at"),
    mailchimpCampaignId: strOrNull(row, "mailchimp_campaign_id") ?? undefined,
    mailchimpWebId: row.mailchimp_web_id == null ? undefined : int(row, "mailchimp_web_id"),
    mailchimpEditUrl: strOrNull(row, "mailchimp_edit_url") ?? undefined,
  };
}

function mapSendAttempt(row: Row): SendAttemptRecord {
  return {
    id: str(row, "id"),
    issueId: str(row, "issue_id"),
    variantId: str(row, "variant_id"),
    audienceId: str(row, "audience_id"),
    mode: str(row, "mode") as "test" | "live",
    idempotencyKey: str(row, "idempotency_key"),
    approverSlackId: str(row, "approver_slack_id"),
    providerCampaignId: strOrNull(row, "provider_campaign_id"),
    status: str(row, "status") as SendAttemptRecord["status"],
    errorCode: strOrNull(row, "error_code"),
    errorMessage: strOrNull(row, "error_message"),
    createdAt: str(row, "created_at"),
    updatedAt: str(row, "updated_at"),
    sentAt: strOrNull(row, "sent_at"),
  };
}

/* ------------------------------------------------------------------ audit */

export async function logAudit(
  db: D1Database,
  entry: { issueId?: string | null; actor: string; action: string; detail?: unknown },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_events (id, issue_id, actor, action, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId("aud"),
      entry.issueId ?? null,
      entry.actor,
      entry.action,
      JSON.stringify(entry.detail ?? {}),
      nowIso(),
    )
    .run();
}

/* -------------------------------------------------------------- job locks */

/** Returns true only for the caller that won the unique job key. */
export async function claimJob(
  db: D1Database,
  jobKey: string,
  monthKey: string,
  stage: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO job_runs (job_key, month_key, stage, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`,
    )
    .bind(jobKey, monthKey, stage, nowIso())
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function finishJob(
  db: D1Database,
  jobKey: string,
  status: "completed" | "failed",
  detail?: unknown,
): Promise<void> {
  await db
    .prepare(
      `UPDATE job_runs SET status = ?, detail_json = ?, finished_at = ? WHERE job_key = ?`,
    )
    .bind(status, JSON.stringify(detail ?? {}), nowIso(), jobKey)
    .run();
}

/** Allows a failed stage to be retried on a later cron tick. */
export async function releaseFailedJob(db: D1Database, jobKey: string): Promise<void> {
  await db.prepare(`DELETE FROM job_runs WHERE job_key = ? AND status = 'failed'`).bind(jobKey).run();
}

/* ----------------------------------------------------------------- issues */

export async function getIssueByMonth(
  db: D1Database,
  monthKey: string,
): Promise<IssueRecord | null> {
  const row = await db
    .prepare(`SELECT * FROM issues WHERE month_key = ?`)
    .bind(monthKey)
    .first<Row>();
  return row ? mapIssue(row) : null;
}

export async function getIssue(db: D1Database, issueId: string): Promise<IssueRecord | null> {
  const row = await db.prepare(`SELECT * FROM issues WHERE id = ?`).bind(issueId).first<Row>();
  return row ? mapIssue(row) : null;
}

export async function upsertIssue(
  db: D1Database,
  issue: { id: string; monthKey: string; status: IssueStatus; primaryCta: string | null },
): Promise<IssueRecord> {
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO issues (id, month_key, status, primary_cta, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(month_key) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .bind(issue.id, issue.monthKey, issue.status, issue.primaryCta, timestamp, timestamp)
    .run();
  const record = await getIssueByMonth(db, issue.monthKey);
  if (!record) throw new Error(`Issue ${issue.monthKey} vanished after upsert`);
  return record;
}

export async function setIssueFactsPack(
  db: D1Database,
  issueId: string,
  factsPack: FactsPack,
  warnings: CheckFinding[],
): Promise<void> {
  await db
    .prepare(
      `UPDATE issues SET facts_pack_json = ?, warnings_json = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(JSON.stringify(factsPack), JSON.stringify(warnings), nowIso(), issueId)
    .run();
}

export async function setIssueReview(
  db: D1Database,
  issueId: string,
  input: {
    recommendedVariant: VariantKind;
    warnings: CheckFinding[];
    slackChannelId?: string | null;
    slackMessageTs?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE issues
         SET status = 'review',
             recommended_variant = ?,
             warnings_json = ?,
             slack_channel_id = COALESCE(?, slack_channel_id),
             slack_message_ts = COALESCE(?, slack_message_ts),
             updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.recommendedVariant,
      JSON.stringify(input.warnings),
      input.slackChannelId ?? null,
      input.slackMessageTs ?? null,
      nowIso(),
      issueId,
    )
    .run();
}

export async function setIssueSlackMessage(
  db: D1Database,
  issueId: string,
  channelId: string,
  messageTs: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE issues SET slack_channel_id = ?, slack_message_ts = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(channelId, messageTs, nowIso(), issueId)
    .run();
}

/**
 * Conditional status change. Returns false when the issue was not in one of the
 * expected states, which is how concurrent approvals are rejected.
 */
export async function transitionIssue(
  db: D1Database,
  issueId: string,
  from: IssueStatus[],
  to: IssueStatus,
): Promise<boolean> {
  const placeholders = from.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `UPDATE issues SET status = ?, updated_at = ?
        WHERE id = ? AND status IN (${placeholders})`,
    )
    .bind(to, nowIso(), issueId, ...from)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function recordApproval(
  db: D1Database,
  issueId: string,
  variantId: string,
  checksum: string,
  approverSlackId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE issues
         SET approved_variant_id = ?, approved_checksum = ?, approved_by = ?, approved_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(variantId, checksum, approverSlackId, nowIso(), nowIso(), issueId)
    .run();
}

export async function markIssueSent(db: D1Database, issueId: string): Promise<void> {
  const timestamp = nowIso();
  await db
    .prepare(`UPDATE issues SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?`)
    .bind(timestamp, timestamp, issueId)
    .run();
}

export async function listIssuesAwaitingMetrics(
  db: D1Database,
  phase: "early" | "settled",
): Promise<IssueRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT i.* FROM issues i
        WHERE i.status = 'sent'
          AND i.sent_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM issue_metrics m WHERE m.issue_id = i.id AND m.phase = ?
          )`,
    )
    .bind(phase)
    .all<Row>();
  return (results ?? []).map(mapIssue);
}

/* ----------------------------------------------------------- source items */

/**
 * Inserts a newly seen item, or refreshes `last_seen_at` when the same
 * (url, content hash) pair is already stored. Returns the stored id.
 */
export async function upsertSourceItem(db: D1Database, item: SourceItem): Promise<string> {
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO source_items (
         id, canonical_url, source_domain, source_kind, source_id, title, evidence_text,
         published_at, event_start_at, event_end_at, province, audience_json, consent,
         confidence, score, score_breakdown_json, content_hash, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_url, content_hash) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         score = excluded.score,
         score_breakdown_json = excluded.score_breakdown_json,
         confidence = excluded.confidence`,
    )
    .bind(
      item.id,
      item.canonicalUrl,
      item.sourceDomain,
      item.sourceKind,
      item.sourceId,
      item.title,
      item.evidenceText,
      item.publishedAt ?? null,
      item.eventStartAt ?? null,
      item.eventEndAt ?? null,
      item.province ?? null,
      JSON.stringify(item.audiences),
      item.consent,
      item.confidence,
      item.score,
      JSON.stringify(item.scoreBreakdown ?? {}),
      item.contentHash,
      timestamp,
      timestamp,
    )
    .run();

  const row = await db
    .prepare(`SELECT id FROM source_items WHERE canonical_url = ? AND content_hash = ?`)
    .bind(item.canonicalUrl, item.contentHash)
    .first<Row>();
  return row ? str(row, "id") : item.id;
}

export async function getSourceItems(db: D1Database, ids: string[]): Promise<SourceItem[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM source_items WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<Row>();
  return (results ?? []).map(mapSourceItem);
}

export async function allKnownUrls(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare(`SELECT DISTINCT canonical_url FROM source_items`).all<Row>();
  return new Set((results ?? []).map((row) => str(row, "canonical_url")));
}

/**
 * Items that could plausibly appear in the current issue: recently seen news,
 * or anything with an event that has not finished yet.
 */
export async function candidateSourceItems(
  db: D1Database,
  sinceIso: string,
  nowIsoValue: string,
): Promise<SourceItem[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM source_items
        WHERE last_seen_at >= ?
           OR (event_start_at IS NOT NULL AND COALESCE(event_end_at, event_start_at) >= ?)
        ORDER BY score DESC, last_seen_at DESC`,
    )
    .bind(sinceIso, nowIsoValue)
    .all<Row>();
  return (results ?? []).map(mapSourceItem);
}

/** Canonical URLs used in a sent issue since `sinceIso`, for reuse suppression. */
export async function recentlyUsedUrls(db: D1Database, sinceIso: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT s.canonical_url AS canonical_url
         FROM source_items s
         JOIN issue_items ii ON ii.source_item_id = s.id
         JOIN issues i ON i.id = ii.issue_id
        WHERE i.sent_at IS NOT NULL AND i.sent_at >= ?`,
    )
    .bind(sinceIso)
    .all<Row>();
  return new Set((results ?? []).map((row) => str(row, "canonical_url")));
}

export async function replaceIssueItems(
  db: D1Database,
  issueId: string,
  sourceItemIds: string[],
): Promise<void> {
  const statements = [db.prepare(`DELETE FROM issue_items WHERE issue_id = ?`).bind(issueId)];
  for (const id of sourceItemIds) {
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO issue_items (issue_id, source_item_id) VALUES (?, ?)`)
        .bind(issueId, id),
    );
  }
  await db.batch(statements);
}

export async function markSourceItemsUsed(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  await db
    .prepare(`UPDATE source_items SET last_used_at = ? WHERE id IN (${placeholders})`)
    .bind(nowIso(), ...ids)
    .run();
}

/* --------------------------------------------------------------- variants */

export async function nextRevision(
  db: D1Database,
  issueId: string,
  kind: VariantKind,
): Promise<number> {
  const row = await db
    .prepare(`SELECT MAX(revision) AS revision FROM variants WHERE issue_id = ? AND kind = ?`)
    .bind(issueId, kind)
    .first<Row>();
  return int(row ?? {}, "revision") + 1;
}

export async function insertVariant(db: D1Database, variant: VariantRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO variants (
         id, issue_id, kind, subject, preheader, structured_json, html_body, text_body,
         checksum, quality_score, reading_minutes, warnings_json, revision, created_at,
         mailchimp_campaign_id, mailchimp_web_id, mailchimp_edit_url
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      variant.id,
      variant.issueId,
      variant.kind,
      variant.subject,
      variant.preheader,
      JSON.stringify(variant.structured),
      variant.htmlBody,
      variant.textBody,
      variant.checksum,
      variant.qualityScore,
      variant.readingMinutes,
      JSON.stringify(variant.warnings),
      variant.revision,
      variant.createdAt,
      variant.mailchimpCampaignId ?? null,
      variant.mailchimpWebId ?? null,
      variant.mailchimpEditUrl ?? null,
    )
    .run();
}

export async function updateVariantRendered(
  db: D1Database,
  variantId: string,
  input: { htmlBody: string; textBody: string },
): Promise<void> {
  await db
    .prepare(`UPDATE variants SET html_body = ?, text_body = ? WHERE id = ?`)
    .bind(input.htmlBody, input.textBody, variantId)
    .run();
}

export async function updateVariantMailchimp(
  db: D1Database,
  variantId: string,
  input: { campaignId: string; webId?: number; editUrl: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE variants
          SET mailchimp_campaign_id = ?, mailchimp_web_id = ?, mailchimp_edit_url = ?
        WHERE id = ?`,
    )
    .bind(input.campaignId, input.webId ?? null, input.editUrl, variantId)
    .run();
}

export async function getVariant(db: D1Database, variantId: string): Promise<VariantRecord | null> {
  const row = await db.prepare(`SELECT * FROM variants WHERE id = ?`).bind(variantId).first<Row>();
  return row ? mapVariant(row) : null;
}

/** Latest revision of each variant kind for an issue. */
export async function latestVariants(db: D1Database, issueId: string): Promise<VariantRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT v.* FROM variants v
        JOIN (
          SELECT kind, MAX(revision) AS revision FROM variants WHERE issue_id = ? GROUP BY kind
        ) latest ON latest.kind = v.kind AND latest.revision = v.revision
       WHERE v.issue_id = ?
       ORDER BY v.kind`,
    )
    .bind(issueId, issueId)
    .all<Row>();
  return (results ?? []).map(mapVariant);
}

/* ---------------------------------------------------------- send attempts */

export type ClaimSendResult =
  | { claimed: true; attempt: SendAttemptRecord }
  | { claimed: false; attempt: SendAttemptRecord };

/**
 * Inserts the send attempt behind a unique idempotency key. A losing caller
 * receives the existing attempt and must not call the provider again.
 */
export async function claimSendAttempt(
  db: D1Database,
  input: {
    issueId: string;
    variantId: string;
    audienceId: string;
    mode: "test" | "live";
    idempotencyKey: string;
    approverSlackId: string;
  },
): Promise<ClaimSendResult> {
  const timestamp = nowIso();
  const id = newId("snd");
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO send_attempts (
         id, issue_id, variant_id, audience_id, mode, idempotency_key, approver_slack_id,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`,
    )
    .bind(
      id,
      input.issueId,
      input.variantId,
      input.audienceId,
      input.mode,
      input.idempotencyKey,
      input.approverSlackId,
      timestamp,
      timestamp,
    )
    .run();

  const row = await db
    .prepare(`SELECT * FROM send_attempts WHERE idempotency_key = ?`)
    .bind(input.idempotencyKey)
    .first<Row>();
  if (!row) throw new Error("Send attempt row missing after insert");

  return { claimed: (result.meta?.changes ?? 0) > 0, attempt: mapSendAttempt(row) };
}

export async function updateSendAttempt(
  db: D1Database,
  id: string,
  patch: Partial<
    Pick<
      SendAttemptRecord,
      "status" | "providerCampaignId" | "errorCode" | "errorMessage" | "sentAt"
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }
  if (patch.providerCampaignId !== undefined) {
    fields.push("provider_campaign_id = ?");
    values.push(patch.providerCampaignId);
  }
  if (patch.errorCode !== undefined) {
    fields.push("error_code = ?");
    values.push(patch.errorCode);
  }
  if (patch.errorMessage !== undefined) {
    fields.push("error_message = ?");
    values.push(patch.errorMessage);
  }
  if (patch.sentAt !== undefined) {
    fields.push("sent_at = ?");
    values.push(patch.sentAt);
  }
  fields.push("updated_at = ?");
  values.push(nowIso());

  await db
    .prepare(`UPDATE send_attempts SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values, id)
    .run();
}

export async function getLiveSendAttempt(
  db: D1Database,
  issueId: string,
): Promise<SendAttemptRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM send_attempts WHERE issue_id = ? AND mode = 'live' ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(issueId)
    .first<Row>();
  return row ? mapSendAttempt(row) : null;
}

/* ---------------------------------------------------------------- metrics */

export async function saveMetrics(
  db: D1Database,
  input: {
    issueId: string;
    phase: "early" | "settled";
    providerCampaignId: string;
    emailsSent: number;
    uniqueOpens: number;
    uniqueClicks: number;
    unsubscribes: number;
    bounces: number;
    complaints: number;
    raw: unknown;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO issue_metrics (
         issue_id, phase, provider_campaign_id, emails_sent, unique_opens, unique_clicks,
         unsubscribes, bounces, complaints, raw_json, collected_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id, phase) DO UPDATE SET
         emails_sent = excluded.emails_sent,
         unique_opens = excluded.unique_opens,
         unique_clicks = excluded.unique_clicks,
         unsubscribes = excluded.unsubscribes,
         bounces = excluded.bounces,
         complaints = excluded.complaints,
         raw_json = excluded.raw_json,
         collected_at = excluded.collected_at`,
    )
    .bind(
      input.issueId,
      input.phase,
      input.providerCampaignId,
      input.emailsSent,
      input.uniqueOpens,
      input.uniqueClicks,
      input.unsubscribes,
      input.bounces,
      input.complaints,
      JSON.stringify(input.raw ?? {}),
      nowIso(),
    )
    .run();
}
