import type { Config } from "./config.ts";
import { truncate } from "./util.ts";

/**
 * Mailchimp Marketing API, called directly over HTTP. The subscriber list never
 * leaves the provider: this client only exchanges audience IDs, campaign IDs,
 * and aggregate metrics.
 */

export class EspError extends Error {
  readonly status: number;
  readonly ambiguous: boolean;
  constructor(message: string, status: number, ambiguous = false) {
    super(message);
    this.name = "EspError";
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

export function espBaseUrl(apiKey: string): string {
  const datacenter = apiKey.split("-")[1];
  if (!datacenter) throw new EspError("ESP_API_KEY is missing its datacenter suffix", 0);
  return `https://${datacenter}.api.mailchimp.com/3.0`;
}

async function espRequest<T>(
  config: Config,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const apiKey = config.esp.apiKey;
  if (!apiKey) throw new EspError("ESP_API_KEY is not configured", 0);

  let response: Response;
  try {
    response = await fetch(`${espBaseUrl(apiKey)}${path}`, {
      method,
      headers: {
        authorization: `Basic ${btoa(`anystring:${apiKey}`)}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(20_000),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // A network timeout leaves the provider state unknown; callers must query
    // campaign status instead of retrying the send.
    throw new EspError(
      `ESP request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      0,
      true,
    );
  }

  if (response.status === 204) return {} as T;

  const text = await response.text();
  if (!response.ok) {
    throw new EspError(`ESP HTTP ${response.status}: ${truncate(text, 300)}`, response.status, response.status >= 500);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

export function campaignEditUrl(apiKey: string, webId: number | string): string {
  const datacenter = apiKey.split("-")[1];
  if (!datacenter) throw new EspError("ESP_API_KEY is missing its datacenter suffix", 0);
  return `https://${datacenter}.admin.mailchimp.com/campaigns/edit?id=${webId}`;
}

export type CampaignInput = {
  audienceId: string;
  subject: string;
  preheader: string;
  title: string;
};

export type DraftCampaign = {
  id: string;
  webId?: number;
  editUrl: string;
};

export async function createDraftCampaign(
  config: Config,
  input: CampaignInput,
  content?: { html: string; text: string },
): Promise<DraftCampaign> {
  const apiKey = config.esp.apiKey;
  if (!apiKey) throw new EspError("ESP_API_KEY is not configured", 0);

  const payload = await espRequest<{ id?: string; web_id?: number }>(config, "POST", "/campaigns", {
    type: "regular",
    recipients: { list_id: input.audienceId },
    settings: {
      subject_line: input.subject,
      preview_text: input.preheader,
      title: input.title,
      from_name: config.esp.fromName,
      reply_to: config.esp.replyTo,
      auto_footer: false,
      inline_css: true,
    },
  });
  if (!payload.id) throw new EspError("ESP did not return a campaign id", 0);

  if (content) {
    await setCampaignContent(config, payload.id, content);
  }

  return {
    id: payload.id,
    webId: payload.web_id,
    editUrl: payload.web_id
      ? campaignEditUrl(apiKey, payload.web_id)
      : `https://admin.mailchimp.com/campaigns/`,
  };
}

export async function createCampaign(config: Config, input: CampaignInput): Promise<string> {
  const draft = await createDraftCampaign(config, input);
  return draft.id;
}

export async function setCampaignContent(
  config: Config,
  campaignId: string,
  content: { html: string; text: string; templateSections?: Record<string, string> },
): Promise<void> {
  // Prefer the provider template so Volta keeps ownership of brand, footer,
  // and deliverability markup.
  const body =
    config.esp.templateId && content.templateSections
      ? {
          template: { id: Number(config.esp.templateId), sections: content.templateSections },
          plain_text: content.text,
        }
      : { html: content.html, plain_text: content.text };

  await espRequest(config, "PUT", `/campaigns/${campaignId}/content`, body);
}

export type CampaignStatus = "save" | "paused" | "schedule" | "sending" | "sent" | "canceled" | string;

export async function getCampaignStatus(config: Config, campaignId: string): Promise<CampaignStatus> {
  const payload = await espRequest<{ status?: string }>(config, "GET", `/campaigns/${campaignId}`);
  return payload.status ?? "unknown";
}

export async function sendCampaign(config: Config, campaignId: string): Promise<void> {
  await espRequest(config, "POST", `/campaigns/${campaignId}/actions/send`);
}

/** Mailchimp preview send to specific inboxes. Does not deliver to the audience. */
export async function sendCampaignTest(
  config: Config,
  campaignId: string,
  emails: string[],
): Promise<void> {
  const testEmails = emails.map((email) => email.trim()).filter(Boolean).slice(0, 6);
  if (testEmails.length === 0) throw new EspError("No test email addresses configured", 0);
  await espRequest(config, "POST", `/campaigns/${campaignId}/actions/test`, {
    test_emails: testEmails,
    send_type: "html",
  });
}

/**
 * Resolves an ambiguous send. Never repeats the send call blindly.
 */
export async function reconcileSend(config: Config, campaignId: string): Promise<"sent" | "not_sent"> {
  const status = await getCampaignStatus(config, campaignId);
  return status === "sent" || status === "sending" || status === "schedule" ? "sent" : "not_sent";
}

export type CampaignReport = {
  emailsSent: number;
  uniqueOpens: number;
  uniqueClicks: number;
  unsubscribes: number;
  bounces: number;
  complaints: number;
  raw: unknown;
};

export async function getCampaignReport(config: Config, campaignId: string): Promise<CampaignReport> {
  const payload = await espRequest<{
    emails_sent?: number;
    opens?: { unique_opens?: number };
    clicks?: { unique_clicks?: number };
    unsubscribed?: number;
    bounces?: { hard_bounces?: number; soft_bounces?: number };
    abuse_reports?: number;
  }>(config, "GET", `/reports/${campaignId}`);

  return {
    emailsSent: payload.emails_sent ?? 0,
    uniqueOpens: payload.opens?.unique_opens ?? 0,
    uniqueClicks: payload.clicks?.unique_clicks ?? 0,
    unsubscribes: payload.unsubscribed ?? 0,
    bounces: (payload.bounces?.hard_bounces ?? 0) + (payload.bounces?.soft_bounces ?? 0),
    complaints: payload.abuse_reports ?? 0,
    raw: payload,
  };
}

/** Aggregate recipient count for the confirmation modal. */
export async function getAudienceSummary(
  config: Config,
  audienceId: string,
): Promise<{ name: string; memberCount: number }> {
  const payload = await espRequest<{ name?: string; stats?: { member_count?: number } }>(
    config,
    "GET",
    `/lists/${audienceId}`,
  );
  return { name: payload.name ?? audienceId, memberCount: payload.stats?.member_count ?? 0 };
}
