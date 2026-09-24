import type { VariantKind } from "./types.ts";

export type Env = {
  DB: D1Database;

  ENVIRONMENT?: string;
  APP_BASE_URL?: string;
  CADENCE?: string;
  TIMEZONE?: string;
  PUBLISH_DAY?: string;
  PUBLISH_LOCAL_TIME?: string;
  COLLECT_DAY?: string;
  COLLECT_LOCAL_TIME?: string;
  METRICS_EARLY_AFTER_HOURS?: string;
  METRICS_SETTLED_AFTER_HOURS?: string;
  LIVE_SEND_ENABLED?: string;

  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_REVIEW_CHANNEL_ID?: string;
  SLACK_APPROVER_IDS?: string;

  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;

  ESP_API_KEY?: string;
  ESP_AUDIENCE_ID?: string;
  ESP_TEST_AUDIENCE_ID?: string;
  ESP_TEMPLATE_ID?: string;
  ESP_FROM_NAME?: string;
  ESP_REPLY_TO?: string;

  PRIMARY_CTA?: string;
  PREVIEW_SIGNING_SECRET?: string;
  ADMIN_RUN_SECRET?: string;
};

export type Config = {
  environment: string;
  appBaseUrl: string;
  cadence: "monthly";
  timezone: string;
  publishDay: string;
  publishLocalTime: string;
  collectDay: string;
  collectLocalTime: string;
  metricsEarlyAfterHours: number;
  metricsSettledAfterHours: number;
  liveSendEnabled: boolean;
  primaryCta: string;

  slack: {
    botToken?: string;
    signingSecret?: string;
    reviewChannelId?: string;
    approverIds: string[];
  };
  llm: {
    apiKey?: string;
    model: string;
    baseUrl: string;
  };
  esp: {
    apiKey?: string;
    audienceId?: string;
    testAudienceId?: string;
    templateId?: string;
    fromName: string;
    replyTo?: string;
  };
  previewSigningSecret?: string;
  adminRunSecret?: string;
};

/** Execution paths have different credential requirements. */
export type CapabilityPath = "draft" | "slack" | "test_send" | "live_send" | "preview";

export const DEFAULT_SUBJECT_MIN = 30;
export const DEFAULT_SUBJECT_MAX = 60;
export const DEFAULT_PREHEADER_MAX = 110;
export const DEFAULT_MAX_READING_MINUTES = 4;
export const APPROVAL_TTL_MINUTES = 60;
export const PREVIEW_TTL_DAYS = 7;

export const RECOMMENDED_VARIANT_DEFAULT: VariantKind = "founder_signal";

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: Env): Config {
  return {
    environment: env.ENVIRONMENT ?? "development",
    appBaseUrl: (env.APP_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, ""),
    cadence: "monthly",
    timezone: env.TIMEZONE ?? "America/Halifax",
    publishDay: env.PUBLISH_DAY ?? "first-monday",
    publishLocalTime: env.PUBLISH_LOCAL_TIME ?? "07:30",
    collectDay: env.COLLECT_DAY ?? "1",
    collectLocalTime: env.COLLECT_LOCAL_TIME ?? "16:00",
    metricsEarlyAfterHours: num(env.METRICS_EARLY_AFTER_HOURS, 28),
    metricsSettledAfterHours: num(env.METRICS_SETTLED_AFTER_HOURS, 168),
    liveSendEnabled: env.LIVE_SEND_ENABLED === "true",
    primaryCta: env.PRIMARY_CTA ?? "",
    slack: {
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
      reviewChannelId: env.SLACK_REVIEW_CHANNEL_ID,
      approverIds: (env.SLACK_APPROVER_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    },
    llm: {
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL ?? "gpt-4o-mini",
      baseUrl: (env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    },
    esp: {
      apiKey: env.ESP_API_KEY,
      audienceId: env.ESP_AUDIENCE_ID,
      testAudienceId: env.ESP_TEST_AUDIENCE_ID,
      templateId: env.ESP_TEMPLATE_ID,
      fromName: env.ESP_FROM_NAME ?? "Volta",
      replyTo: env.ESP_REPLY_TO,
    },
    previewSigningSecret: env.PREVIEW_SIGNING_SECRET,
    adminRunSecret: env.ADMIN_RUN_SECRET,
  };
}

/**
 * Returns the names of missing values for a given path. A draft-only run must
 * never be blocked by production send credentials.
 */
export function missingFor(config: Config, path: CapabilityPath): string[] {
  const missing: string[] = [];
  const need = (value: unknown, name: string) => {
    if (!value) missing.push(name);
  };

  switch (path) {
    case "draft":
      need(config.llm.apiKey, "LLM_API_KEY");
      break;
    case "slack":
      need(config.slack.botToken, "SLACK_BOT_TOKEN");
      need(config.slack.signingSecret, "SLACK_SIGNING_SECRET");
      need(config.slack.reviewChannelId, "SLACK_REVIEW_CHANNEL_ID");
      if (config.slack.approverIds.length === 0) missing.push("SLACK_APPROVER_IDS");
      break;
    case "preview":
      need(config.previewSigningSecret, "PREVIEW_SIGNING_SECRET");
      break;
    case "test_send":
      need(config.esp.apiKey, "ESP_API_KEY");
      need(config.esp.testAudienceId, "ESP_TEST_AUDIENCE_ID");
      need(config.esp.replyTo, "ESP_REPLY_TO");
      break;
    case "live_send":
      need(config.esp.apiKey, "ESP_API_KEY");
      need(config.esp.audienceId, "ESP_AUDIENCE_ID");
      need(config.esp.replyTo, "ESP_REPLY_TO");
      break;
  }
  return missing;
}

export function assertCapability(config: Config, path: CapabilityPath): void {
  const missing = missingFor(config, path);
  if (missing.length > 0) {
    throw new ConfigError(`Missing configuration for ${path}: ${missing.join(", ")}`, missing);
  }
}

export class ConfigError extends Error {
  readonly missing: string[];
  constructor(message: string, missing: string[]) {
    super(message);
    this.name = "ConfigError";
    this.missing = missing;
  }
}
