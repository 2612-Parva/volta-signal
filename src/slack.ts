import type { Config } from "./config.ts";
import { monthLabel } from "./schedule.ts";
import type { CheckFinding, FactsPack, VariantKind, VariantRecord } from "./types.ts";
import { formatLocal, hmacSha256Hex, timingSafeEqual, truncate } from "./util.ts";

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export const ACTION = {
  preview: "vs_preview",
  sources: "vs_sources",
  sendTest: "vs_send_test",
  requestChange: "vs_request_change",
  approve: "vs_approve",
} as const;

export const CALLBACK = {
  revision: "vs_revision_modal",
  approval: "vs_approval_modal",
} as const;

/**
 * Verifies `v0=HMAC_SHA256(v0:timestamp:rawBody)` over the *raw* body, with a
 * five-minute replay window and constant-time comparison.
 */
export async function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  now?: Date;
}): Promise<boolean> {
  const { signingSecret, timestamp, signature, rawBody } = input;
  if (!signingSecret || !timestamp || !signature) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = `v0=${await hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`)}`;
  return timingSafeEqual(expected, signature);
}

export function isApprover(config: Config, userId: string | undefined): boolean {
  return Boolean(userId) && config.slack.approverIds.includes(userId!);
}

export type SlackViewValues = Record<
  string,
  Record<string, { value?: string; selected_option?: { value?: string; text?: { text?: string } } }>
>;

/** Slack nests modal fields as state.values[block_id][action_id]. */
export function slackSelectValue(values: SlackViewValues, blockId: string): string {
  const block = values[blockId];
  if (!block) return "";
  for (const action of Object.values(block)) {
    const selected = action?.selected_option?.value;
    if (selected) return selected;
  }
  return "";
}

export function slackSelectLabel(values: SlackViewValues, blockId: string): string {
  const block = values[blockId];
  if (!block) return "";
  for (const action of Object.values(block)) {
    const label = action?.selected_option?.text?.text;
    if (label) return label;
  }
  return "";
}

export function slackTextValue(values: SlackViewValues, blockId: string): string {
  const block = values[blockId];
  if (!block) return "";
  for (const action of Object.values(block)) {
    if (action?.selected_option) continue;
    if (typeof action?.value === "string" && action.value.trim()) return action.value.trim();
  }
  return "";
}

const CHANGE_INSTRUCTIONS: Record<string, string> = {
  shorter:
    "Make this edition shorter. Keep at most three content items. Cut the intro to two sentences. Drop the weakest story. Do not add anything new.",
  remove_item:
    "Delete the named item completely. Do not mention it. Do not replace it with a new story. Keep the other items.",
  different_lead: "Lead with a different story from the facts pack. Do not invent a new lead.",
  warmer: "Keep the same items. Rewrite in a warmer, more human Volta voice. No new claims.",
  more_founder: "Reframe for founders: deadlines, asks, traction. Same sources only.",
  more_builder: "Reframe for builders: demos, tools, practice. Same sources only.",
  custom: "Apply the reviewer's note. Use only the existing facts pack.",
};

export function revisionInstruction(input: {
  changeType: string;
  note: string;
  dropLabel?: string;
  itemCount?: number;
  readingMinutes?: number;
}): string {
  const type = CHANGE_INSTRUCTIONS[input.changeType] ? input.changeType : "custom";
  const parts = [CHANGE_INSTRUCTIONS[type]];
  if (input.itemCount != null) {
    parts.push(`It currently has ${input.itemCount} items and reads at about ${input.readingMinutes ?? "?"} minutes.`);
  }
  if (input.dropLabel) parts.push(`Remove this item: ${input.dropLabel}.`);
  if (input.note) parts.push(`Reviewer note: ${input.note}`);
  return parts.join(" ");
}

/* ------------------------------------------------------------- web api */

type SlackResponse = { ok: boolean; error?: string; ts?: string; channel?: string };

export async function slackApi<T extends SlackResponse>(
  config: Config,
  method: string,
  body: unknown,
): Promise<T> {
  if (!config.slack.botToken) throw new Error("SLACK_BOT_TOKEN is not configured");

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.slack.botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as T;
  if (!payload.ok) throw new Error(`Slack ${method} failed: ${payload.error ?? response.status}`);
  return payload;
}

/** Bounded backoff; a failed Slack post must not discard the finished issue. */
export async function slackApiWithRetry<T extends SlackResponse>(
  config: Config,
  method: string,
  body: unknown,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await slackApi<T>(config, method, body);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Slack request failed");
}

/* -------------------------------------------------------------- blocks */

type Block = Record<string, unknown>;

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text: truncate(text, 2900) } };
}

function context(text: string): Block {
  return { type: "context", elements: [{ type: "mrkdwn", text: truncate(text, 2900) }] };
}

export type ReviewMessageInput = {
  issueId: string;
  monthKey: string;
  generatedAt: string;
  recommended: VariantKind;
  recommendationReason: string;
  variants: VariantRecord[];
  factsPack: FactsPack;
  findings: CheckFinding[];
  linkStatus: string;
  previewUrl: (variantId: string) => string;
  liveSendEnabled: boolean;
};

export function buildReviewBlocks(input: ReviewMessageInput, config: Config): Block[] {
  const recommended =
    input.variants.find((variant) => variant.kind === input.recommended) ?? input.variants[0];
  const blockers = input.findings.filter((finding) => finding.severity === "block");
  const warnings = input.findings.filter((finding) => finding.severity === "warn");

  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Volta monthly · ${monthLabel(input.monthKey)}`, emoji: false },
    },
    context(
      [
        `Generated ${formatLocal(input.generatedAt, config.timezone)}`,
        `${input.factsPack.items.length} sources`,
        `${blockers.length} blockers · ${warnings.length} warnings`,
        input.linkStatus,
      ].join(" · "),
    ),
  ];

  if (recommended) {
    blocks.push(
      section(
        [
          `*Recommended: ${recommended.kind.replace("_", " ")}*`,
          `*${recommended.subject}*`,
          `_${recommended.preheader}_`,
          `Quality ${recommended.qualityScore}/100 · ~${recommended.readingMinutes} min read`,
          input.recommendationReason,
        ].join("\n"),
      ),
    );
  }

  for (const variant of input.variants) {
    const items = variant.structured.sections?.flatMap((s) => s.items) ?? [];
    blocks.push(
      section(
        [
          `*${variant.kind.replace("_", " ")}* (rev ${variant.revision})`,
          `Subject: ${variant.subject}`,
          `Quality ${variant.qualityScore}/100 · ${items.length} items · ~${variant.readingMinutes} min`,
          variant.mailchimpEditUrl ? `<${variant.mailchimpEditUrl}|Open draft in Mailchimp>` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Preview" },
            url: input.previewUrl(variant.id),
            action_id: `${ACTION.preview}_${variant.kind}`,
          },
          ...(variant.mailchimpEditUrl
            ? [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Edit in Mailchimp" },
                  url: variant.mailchimpEditUrl,
                  action_id: `${ACTION.preview}_mc_${variant.kind}`,
                },
              ]
            : []),
          {
            type: "button",
            text: { type: "plain_text", text: "Sources" },
            action_id: `${ACTION.sources}_${variant.kind}`,
            value: variant.id,
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Send test" },
            action_id: `${ACTION.sendTest}_${variant.kind}`,
            value: variant.id,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Request change" },
            action_id: `${ACTION.requestChange}_${variant.kind}`,
            value: variant.id,
          },
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Approve and send" },
            action_id: `${ACTION.approve}_${variant.kind}`,
            value: variant.id,
          },
        ],
      },
    );
  }

  if (input.findings.length > 0) {
    blocks.push(
      section(
        `*Checks*\n${input.findings
          .slice(0, 12)
          .map((finding) => `${finding.severity === "block" ? ":no_entry:" : ":warning:"} ${finding.message}`)
          .join("\n")}`,
      ),
    );
  }

  if (!input.liveSendEnabled) {
    blocks.push(context(":lock: Live send is disabled (`LIVE_SEND_ENABLED=false`). Test sends still work."));
  }

  return blocks;
}

export function buildRevisionModal(variant: VariantRecord): Block {
  const items = variant.structured.sections?.flatMap((section) => section.items) ?? [];
  // Slack requires unique option values; source ids can repeat across items.
  const dropOptions = items.slice(0, 10).map((item, index) => {
    const label = truncate(item.headline || `Item ${index + 1}`, 72);
    const source = item.sourceItemIds?.[0] ?? "none";
    return {
      text: { type: "plain_text", text: label },
      value: truncate(`${index}:${source}`, 75),
    };
  });

  const blocks: Block[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(
          `Revising *${variant.kind.replace("_", " ")}* (rev ${variant.revision}) · ${items.length} items · ~${variant.readingMinutes} min. Sources are not recollected.`,
          2900,
        ),
      },
    },
    {
      type: "input",
      block_id: "change_type",
      label: { type: "plain_text", text: "Change type" },
      element: {
        type: "static_select",
        action_id: "change_type_select",
        placeholder: { type: "plain_text", text: "Choose a change" },
        options: [
          ["shorter", "Make it shorter"],
          ["remove_item", "Remove an item"],
          ["different_lead", "Different lead story"],
          ["warmer", "Warmer tone"],
          ["more_founder", "More founder-focused"],
          ["more_builder", "More builder-focused"],
          ["custom", "Custom (see note)"],
        ].map(([value, label]) => ({
          text: { type: "plain_text", text: label! },
          value: value!,
        })),
      },
    },
  ];

  if (dropOptions.length > 0) {
    blocks.push({
      type: "input",
      block_id: "drop_item",
      optional: true,
      label: { type: "plain_text", text: "Item to remove (if cutting one)" },
      element: {
        type: "static_select",
        action_id: "drop_item_select",
        placeholder: { type: "plain_text", text: "Pick the story to drop" },
        options: dropOptions,
      },
    });
  }

  blocks.push({
    type: "input",
    block_id: "note",
    optional: true,
    label: { type: "plain_text", text: "Note" },
    hint: {
      type: "plain_text",
      text: "Required for Custom. For Remove, pick the item above or name it here.",
    },
    element: { type: "plain_text_input", action_id: "note_input", multiline: true },
  });

  return {
    type: "modal",
    callback_id: CALLBACK.revision,
    private_metadata: variant.id,
    title: { type: "plain_text", text: "Request a change" },
    submit: { type: "plain_text", text: "Regenerate" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

export function buildApprovalModal(input: {
  variant: VariantRecord;
  audienceName: string;
  audienceCount: number | null;
  fromName: string;
  warnings: CheckFinding[];
  checksum: string;
}): Block {
  const warningText =
    input.warnings.length === 0
      ? "No warnings."
      : input.warnings.map((finding) => `• ${finding.message}`).join("\n");

  return {
    type: "modal",
    callback_id: CALLBACK.approval,
    private_metadata: input.variant.id,
    title: { type: "plain_text", text: "Approve and send" },
    submit: { type: "plain_text", text: "Send now" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      section(
        [
          `*Variant:* ${input.variant.kind.replace("_", " ")} (rev ${input.variant.revision})`,
          `*Subject:* ${input.variant.subject}`,
          `*Audience:* ${input.audienceName}${input.audienceCount === null ? "" : ` · ${input.audienceCount} recipients`}`,
          `*From:* ${input.fromName}`,
        ].join("\n"),
      ),
      section(`*Warnings*\n${warningText}`),
      context(`Checksum \`${input.checksum.slice(0, 16)}\` · this action sends immediately.`),
    ],
  };
}

export function ephemeral(text: string): Response {
  return new Response(JSON.stringify({ response_type: "ephemeral", text }), {
    headers: { "content-type": "application/json" },
  });
}
