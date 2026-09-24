import { ConfigError, loadConfig, missingFor, type Config, type Env } from "./config.ts";
import { architectureResponse } from "./architecture.ts";
import { storeInternalSignal } from "./collect.ts";
import { claimJob, finishJob, getIssue, getVariant, logAudit, releaseFailedJob } from "./db.ts";
import { GenerationError } from "./generate.ts";
import { previewResponse, verifyPreviewToken } from "./preview.ts";
import {
  approveAndSend,
  audienceSummaryOrNull,
  currentIssue,
  ingestMetrics,
  regenerateVariant,
    runCollectStage,
    runPublishStage,
    sendTest,
    sourceLedgerText,
    updateReviewCard,
    pushMailchimpDrafts,
    postReviewCard,
} from "./pipeline.ts";
import { renderVariant } from "./render.ts";
import { describeSchedule, dueStages, jobKey, monthKeyOf } from "./schedule.ts";
import {
  ACTION,
  buildApprovalModal,
  buildRevisionModal,
  CALLBACK,
  isApprover,
  revisionInstruction,
  slackApi,
  slackSelectLabel,
  slackSelectValue,
  slackTextValue,
  type SlackViewValues,
  verifySlackSignature,
} from "./slack.ts";
import { timingSafeEqual, truncate } from "./util.ts";

const VERSION = "0.1.0";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function isAdmin(request: Request, config: Config): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  return Boolean(config.adminRunSecret) && timingSafeEqual(token, config.adminRunSecret!);
}

/* ------------------------------------------------------------- handlers */

async function handleHealth(env: Env, config: Config): Promise<Response> {
  let database = "unknown";
  try {
    await env.DB.prepare("SELECT 1").first();
    database = "ok";
  } catch {
    database = "unavailable";
  }

  return json({
    service: "volta-signal",
    version: VERSION,
    environment: config.environment,
    cadence: config.cadence,
    schedule: describeSchedule(config),
    timezone: config.timezone,
    currentMonth: monthKeyOf(new Date(), config.timezone),
    liveSendEnabled: config.liveSendEnabled,
    database,
    // Names only. Never values.
    missing: {
      draft: missingFor(config, "draft"),
      slack: missingFor(config, "slack"),
      preview: missingFor(config, "preview"),
      testSend: missingFor(config, "test_send"),
      liveSend: missingFor(config, "live_send"),
    },
  });
}

async function handlePreview(
  env: Env,
  config: Config,
  variantId: string,
  token: string | null,
): Promise<Response> {
  if (!(await verifyPreviewToken(config, variantId, token))) {
    return text("Preview link is invalid or expired.", 403);
  }

  const variant = await getVariant(env.DB, variantId);
  if (!variant) return text("Not found.", 404);

  const issue = await getIssue(env.DB, variant.issueId);
  if (!issue?.factsPack) return text("Not found.", 404);

  const rendered = renderVariant(variant.structured, {
    monthKey: issue.monthKey,
    timezone: config.timezone,
    factsPack: issue.factsPack,
    draftBanner: true,
  });

  return previewResponse(rendered.html);
}

async function handleAdminRun(
  request: Request,
  env: Env,
  config: Config,
): Promise<Response> {
  if (!isAdmin(request, config)) return text("Unauthorized.", 401);
  if (config.environment === "production") {
    return text("Manual runs are disabled in production.", 403);
  }

  const body = (await request.json().catch(() => ({}))) as { stage?: string; post?: boolean };
  const stage = body.stage ?? "publish";

  try {
    if (stage === "collect") {
      const result = await runCollectStage(env.DB, config);
      return json({
        stage,
        issue: result.issue.id,
        collected: result.collectedCount,
        eligible: result.eligibleCount,
        warnings: result.warnings,
      });
    }

    if (stage === "mailchimp") {
      const issue = await currentIssue(env.DB, config);
      if (!issue) return json({ error: "No issue for this month" }, 404);
      const variants = await pushMailchimpDrafts(env.DB, config, issue.id);
      const posted = await postReviewCard(env.DB, config, issue.id);
      return json({
        stage,
        issue: issue.id,
        posted,
        drafts: variants.map((variant) => ({
          id: variant.id,
          kind: variant.kind,
          campaignId: variant.mailchimpCampaignId ?? null,
          editUrl: variant.mailchimpEditUrl ?? null,
        })),
      });
    }

    const result = await runPublishStage(env.DB, config, { post: body.post !== false });
    return json({
      stage: "publish",
      issue: result.issue.id,
      posted: result.posted,
      recommended: result.issue.recommendedVariant,
      variants: result.variants.map((variant) => ({
        id: variant.id,
        kind: variant.kind,
        subject: variant.subject,
        revision: variant.revision,
        qualityScore: variant.qualityScore,
        readingMinutes: variant.readingMinutes,
      })),
      findings: result.findings,
    });
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: error.message, missing: error.missing }, 400);
    if (error instanceof GenerationError) {
      return json({ error: error.message, errors: error.errors }, 500);
    }
    return json({ error: error instanceof Error ? error.message : "unknown error" }, 500);
  }
}

async function handleAdminSignal(request: Request, env: Env, config: Config): Promise<Response> {
  if (!isAdmin(request, config)) return text("Unauthorized.", 401);

  const body = (await request.json().catch(() => null)) as {
    url?: string;
    title?: string;
    evidenceText?: string;
    approvedBy?: string;
    publishedAt?: string;
  } | null;

  if (!body?.url || !body.title || !body.evidenceText || !body.approvedBy) {
    return json({ error: "url, title, evidenceText, and approvedBy are required" }, 400);
  }

  const item = await storeInternalSignal(env.DB, {
    url: body.url,
    title: body.title,
    evidenceText: body.evidenceText,
    approvedBy: body.approvedBy,
    publishedAt: body.publishedAt,
  });

  await logAudit(env.DB, {
    actor: body.approvedBy,
    action: "internal_signal_added",
    detail: { id: item.id, url: item.canonicalUrl },
  });

  return json({ id: item.id, score: item.score, consent: item.consent });
}

async function handleAdminStatus(request: Request, env: Env, config: Config): Promise<Response> {
  if (!isAdmin(request, config)) return text("Unauthorized.", 401);
  const issue = await currentIssue(env.DB, config);
  if (!issue) return json({ issue: null, month: monthKeyOf(new Date(), config.timezone) });
  return json({
    id: issue.id,
    monthKey: issue.monthKey,
    status: issue.status,
    recommended: issue.recommendedVariant,
    sources: issue.factsPack?.items.length ?? 0,
    warnings: issue.warnings,
    sentAt: issue.sentAt,
  });
}

/* --------------------------------------------------------------- slack */

type SlackPayload = {
  type?: string;
  user?: { id?: string };
  trigger_id?: string;
  response_url?: string;
  actions?: Array<{ action_id?: string; value?: string }>;
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: SlackViewValues };
  };
};

async function handleSlackCommands(
  request: Request,
  env: Env,
  config: Config,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();
  const form = new URLSearchParams(rawBody);
  if (form.get("ssl_check") === "1") return text("ok", 200);

  const valid = await verifySlackSignature({
    signingSecret: config.slack.signingSecret ?? "",
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    rawBody,
  });
  if (!valid) return text("Invalid signature.", 401);

  const userId = form.get("user_id") ?? "";
  const verb = (form.get("text") ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const responseUrl = form.get("response_url") ?? undefined;
  const help =
    "*Manual Volta Signal*\n`/volta publish` — collect, generate three variants, post the review card\n`/volta card` — refresh Mailchimp drafts and re-post Slack (no Groq)\n`/volta status` — this month’s issue\nSend test and Approve and send stay on the card. This command does not email the list.";

  if (!verb || verb === "help") {
    return json({ response_type: "ephemeral", text: help });
  }

  if (verb === "status") {
    const issue = await currentIssue(env.DB, config);
    if (!issue) {
      return json({
        response_type: "ephemeral",
        text: `No issue for ${monthKeyOf(new Date(), config.timezone)} yet. Run \`/volta publish\`.`,
      });
    }
    return json({
      response_type: "ephemeral",
      text: `*${issue.monthKey}* · ${issue.status} · recommended ${issue.recommendedVariant ?? "—"} · ${issue.factsPack?.items.length ?? 0} sources`,
    });
  }

  if (!isApprover(config, userId)) {
    return json({ response_type: "ephemeral", text: "You are not on the approver allowlist." });
  }

  if (verb === "publish" || verb === "card") {
    ctx.waitUntil(
      (async () => {
        try {
          if (verb === "card") {
            const issue = await currentIssue(env.DB, config);
            if (!issue) {
              await replySlack(responseUrl, "No issue this month. Run `/volta publish` first.");
              return;
            }
            await pushMailchimpDrafts(env.DB, config, issue.id);
            const posted = await postReviewCard(env.DB, config, issue.id);
            await replySlack(
              responseUrl,
              posted
                ? "Slack card refreshed. Use *Send test* or *Approve and send* on the card."
                : "Drafts refreshed, but Slack did not post. Check the bot is in the channel.",
            );
            return;
          }

          const result = await runPublishStage(env.DB, config, { post: true });
          await replySlack(
            responseUrl,
            result.posted
              ? `Posted *${result.issue.monthKey}* (${result.variants.length} variants, recommended ${result.issue.recommendedVariant}). Open #volta-signal-review — *Send test* and *Approve and send* are on the card.`
              : `Generated ${result.variants.length} variants but Slack did not post. Invite the bot to the review channel.`,
          );
        } catch (error) {
          await replySlack(
            responseUrl,
            `Failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      })(),
    );
    return json({
      response_type: "ephemeral",
      text:
        verb === "publish"
          ? "Generating three variants (about 1–2 minutes). I’ll confirm here. Nothing is sent to the list yet."
          : "Refreshing drafts and the Slack card…",
    });
  }

  return json({ response_type: "ephemeral", text: help });
}

async function replySlack(responseUrl: string | undefined, text: string): Promise<void> {
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ replace_original: false, response_type: "ephemeral", text }),
  }).catch(() => undefined);
}

function formatRevisionFailure(error: unknown): string {
  if (error instanceof GenerationError) {
    const details =
      error.errors.length > 0
        ? error.errors
            .slice(0, 8)
            .map((entry) => `• [${entry.code}] ${entry.message}`)
            .join("\n")
        : error.message;
    return `Revision failed after one retry:\n${details}\n_Try Request change again, or pick a lighter change (e.g. warmer)._`;
  }
  return `Revision failed: ${error instanceof Error ? error.message : "unknown error"}`;
}

async function respondInThread(
  env: Env,
  config: Config,
  variantId: string,
  message: string,
): Promise<void> {
  const variant = await getVariant(env.DB, variantId);
  if (!variant) return;
  const issue = await getIssue(env.DB, variant.issueId);
  if (!issue) return;
  await updateReviewCard(config, issue, message);
}

async function handleSlackActions(
  request: Request,
  env: Env,
  config: Config,
  ctx: ExecutionContext,
): Promise<Response> {
  // The raw body must be read before parsing, or the signature cannot match.
  const rawBody = await request.text();

  // Slack's "Save Request URL" check is an unsigned POST (`ssl_check=1`) or a
  // url_verification JSON body. Neither has a usable signature.
  const form = new URLSearchParams(rawBody);
  if (form.get("ssl_check") === "1") return text("ok", 200);
  try {
    const probe = JSON.parse(rawBody) as { type?: string; challenge?: string };
    if (probe.type === "url_verification" && probe.challenge) {
      return json({ challenge: probe.challenge });
    }
  } catch {
    /* body is the signed interactivity payload, not JSON */
  }

  const valid = await verifySlackSignature({
    signingSecret: config.slack.signingSecret ?? "",
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    rawBody,
  });
  if (!valid) return text("Invalid signature.", 401);

  const payload = JSON.parse(form.get("payload") ?? "{}") as SlackPayload;
  const userId = payload.user?.id ?? "unknown";

  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    const actionId = action?.action_id ?? "";
    const variantId = action?.value ?? "";

    if (actionId.startsWith(ACTION.preview)) return new Response(null, { status: 200 });

    if (actionId.startsWith(ACTION.sources)) {
      const ledger = await sourceLedgerText(env.DB, variantId);
      const body = `*Source ledger*\n${truncate(ledger, 2800)}`;
      ctx.waitUntil(respondInThread(env, config, variantId, body).catch(() => undefined));
      return json({
        response_type: "ephemeral",
        text: `${body}\n\n_Also posted in the thread under this card. Click “replies” below the review message if you don’t see it._`,
      });
    }

    if (actionId.startsWith(ACTION.sendTest)) {
      if (!isApprover(config, userId)) {
        await logAudit(env.DB, { actor: userId, action: "unauthorized_test_send", detail: { variantId } });
        return json({ response_type: "ephemeral", text: "You are not on the approver allowlist." });
      }
      ctx.waitUntil(
        (async () => {
          const outcome = await sendTest(env.DB, config, variantId, userId).catch((error) => ({
            status: "failed" as const,
            message: error instanceof Error ? error.message : "unknown error",
          }));
          const text = `Test send: ${outcome.message}`;
          await replySlack(payload.response_url, text);
          await respondInThread(env, config, variantId, text);
        })(),
      );
      return json({
        response_type: "ephemeral",
        text: "Sending a Mailchimp *test copy* to the ESP_REPLY_TO inbox (not a live list send). I’ll confirm here in a few seconds.",
      });
    }

    if (actionId.startsWith(ACTION.requestChange)) {
      const variant = await getVariant(env.DB, variantId);
      if (!variant || !payload.trigger_id) {
        return json({
          response_type: "ephemeral",
          text: "Could not open the change form. Refresh the card with `/volta card` and try again.",
        });
      }
      try {
        await slackApi(config, "views.open", {
          trigger_id: payload.trigger_id,
          view: buildRevisionModal(variant),
        });
      } catch (error) {
        return json({
          response_type: "ephemeral",
          text: `Could not open Request change: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
      return new Response(null, { status: 200 });
    }

    if (actionId.startsWith(ACTION.approve)) {
      if (!isApprover(config, userId)) {
        await logAudit(env.DB, { actor: userId, action: "unauthorized_approve", detail: { variantId } });
        return json({ response_type: "ephemeral", text: "You are not on the approver allowlist." });
      }
      const variant = await getVariant(env.DB, variantId);
      if (!variant || !payload.trigger_id) {
        return json({
          response_type: "ephemeral",
          text: "Could not open Approve. Refresh the card with `/volta card` and try again.",
        });
      }

      try {
        const audience = await audienceSummaryOrNull(config, config.esp.audienceId);
        await slackApi(config, "views.open", {
          trigger_id: payload.trigger_id,
          view: buildApprovalModal({
            variant,
            audienceName: audience.name,
            audienceCount: audience.memberCount,
            fromName: config.esp.fromName,
            warnings: variant.warnings,
            checksum: variant.checksum,
          }),
        });
      } catch (error) {
        return json({
          response_type: "ephemeral",
          text: `Could not open Approve: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
      return new Response(null, { status: 200 });
    }

    return new Response(null, { status: 200 });
  }

  if (payload.type === "view_submission") {
    const callbackId = payload.view?.callback_id;
    const variantId = payload.view?.private_metadata ?? "";

    if (callbackId === CALLBACK.revision) {
      const values = payload.view?.state?.values ?? {};
      const changeType = slackSelectValue(values, "change_type") || "custom";
      const dropLabel = slackSelectLabel(values, "drop_item");
      const note = slackTextValue(values, "note");

      if (changeType === "custom" && !note) {
        return json({
          response_action: "errors",
          errors: { note: "Add a short note for a custom change." },
        });
      }
      if (changeType === "remove_item" && !dropLabel && !note) {
        return json({
          response_action: "errors",
          errors: {
            drop_item: "Pick the item to remove, or name it in the note.",
          },
        });
      }

      const previous = await getVariant(env.DB, variantId);
      const items = previous?.structured.sections?.flatMap((section) => section.items) ?? [];
      const instruction = revisionInstruction({
        changeType,
        note,
        dropLabel: dropLabel || undefined,
        itemCount: items.length,
        readingMinutes: previous?.readingMinutes,
      });

      ctx.waitUntil(
        (async () => {
          try {
            const revision = await regenerateVariant(env.DB, config, variantId, instruction);
            const issue = await getIssue(env.DB, revision.issueId);
            if (issue) {
              await postReviewCard(env.DB, config, issue.id);
            }
            await respondInThread(
              env,
              config,
              revision.id,
              `New revision ${revision.revision} of *${revision.kind}* · ${revision.subject} (quality ${revision.qualityScore}/100). Change: ${changeType}${dropLabel ? ` · dropped “${dropLabel}”` : ""}. Card refreshed — use Preview / Send test on the new revision.`,
            );
          } catch (error) {
            await respondInThread(
              env,
              config,
              variantId,
              formatRevisionFailure(error),
            );
          }
        })(),
      );
      return json({ response_action: "clear" });
    }

    if (callbackId === CALLBACK.approval) {
      ctx.waitUntil(
        (async () => {
          const outcome = await approveAndSend(env.DB, config, variantId, payload.user?.id ?? "unknown").catch(
            (error) => ({
              status: "failed" as const,
              message: error instanceof Error ? error.message : "unknown error",
              campaignId: undefined,
            }),
          );
          const detail = outcome.campaignId ? ` (campaign ${outcome.campaignId})` : "";
          const text = `*${outcome.status.toUpperCase()}* · ${outcome.message}${detail}`;
          await replySlack(payload.response_url, text);
          await respondInThread(env, config, variantId, text);
        })(),
      );
      return json({ response_action: "clear" });
    }
  }

  return new Response(null, { status: 200 });
}

/* ---------------------------------------------------------------- entry */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = loadConfig(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return handleHealth(env, config);
    }

    if (request.method === "GET" && path === "/architecture") {
      return architectureResponse();
    }

    const preview = /^\/preview\/([\w-]+)$/.exec(path);
    if (request.method === "GET" && preview) {
      return handlePreview(env, config, preview[1]!, url.searchParams.get("token"));
    }

    if (path === "/slack/actions") {
      if (request.method === "GET") return text("ok", 200);
      if (request.method === "POST") return handleSlackActions(request, env, config, ctx);
    }

    if (path === "/slack/commands") {
      if (request.method === "GET") return text("ok", 200);
      if (request.method === "POST") return handleSlackCommands(request, env, config, ctx);
    }

    if (path === "/admin/run") {
      if (request.method === "GET") {
        return text("POST /admin/run with Authorization: Bearer <ADMIN_RUN_SECRET> and JSON {\"stage\":\"publish\"}.", 405);
      }
      if (request.method === "POST") return handleAdminRun(request, env, config);
    }

    if (request.method === "POST" && path === "/admin/signal") {
      return handleAdminSignal(request, env, config);
    }

    if (request.method === "GET" && path === "/admin/status") {
      return handleAdminStatus(request, env, config);
    }

    return text("Not found.", 404);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const config = loadConfig(env);
    ctx.waitUntil(runScheduled(env, config, new Date(event.scheduledTime)));
  },
};

export async function runScheduled(env: Env, config: Config, now: Date): Promise<void> {
  const monthKey = monthKeyOf(now, config.timezone);

  for (const stage of dueStages(now, config)) {
    const key = jobKey(monthKey, stage);
    await releaseFailedJob(env.DB, key);
    const claimed = await claimJob(env.DB, key, monthKey, stage);
    if (!claimed) continue;

    try {
      if (stage === "collect") {
        const result = await runCollectStage(env.DB, config, now);
        await finishJob(env.DB, key, "completed", {
          collected: result.collectedCount,
          eligible: result.eligibleCount,
        });
      } else {
        const result = await runPublishStage(env.DB, config, { now });
        await finishJob(env.DB, key, "completed", {
          variants: result.variants.length,
          posted: result.posted,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      await finishJob(env.DB, key, "failed", { message });
      await logAudit(env.DB, { actor: "system", action: `${stage}_failed`, detail: { message } });

      if (config.slack.botToken && config.slack.reviewChannelId) {
        await slackApi(config, "chat.postMessage", {
          channel: config.slack.reviewChannelId,
          text: `:rotating_light: Volta Signal ${stage} failed for ${monthKey}: ${truncate(message, 400)}`,
        }).catch(() => undefined);
      }
    }
  }

  await ingestMetrics(env.DB, config, now).catch(() => 0);
}
