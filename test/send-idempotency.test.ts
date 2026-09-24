import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { loadConfig, type Config, type Env } from "../src/config.ts";
import { getIssue, insertVariant, setIssueFactsPack, transitionIssue, upsertIssue } from "../src/db.ts";
import { approveAndSend, sendIdempotencyKey, variantChecksum } from "../src/pipeline.ts";
import { renderVariant } from "../src/render.ts";
import type { FactsPack, GeneratedVariant, VariantRecord } from "../src/types.ts";
import { nowIso } from "../src/util.ts";
import { createTestDb, type TestDatabase } from "./helpers/d1.ts";

const MONTH_KEY = "2026-09";
const ISSUE_ID = "2026-M09";
const VARIANT_ID = "var_test_founder";
const AUDIENCE_ID = "aud_live";

type FetchCall = { url: string; method: string };

let db: TestDatabase;
let calls: FetchCall[];
let originalFetch: typeof fetch;

function futureIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function testConfig(overrides: Partial<Env> = {}): Config {
  return loadConfig({
    ENVIRONMENT: "test",
    TIMEZONE: "America/Halifax",
    LIVE_SEND_ENABLED: "true",
    SLACK_APPROVER_IDS: "U_APPROVER",
    ESP_API_KEY: "key-us21",
    ESP_AUDIENCE_ID: AUDIENCE_ID,
    ESP_TEST_AUDIENCE_ID: "aud_test",
    ESP_REPLY_TO: "hello@voltaeffect.com",
    ESP_FROM_NAME: "Volta",
    LLM_API_KEY: "unused-in-this-test",
    ...overrides,
  } as unknown as Env);
}

function factsPack(): FactsPack {
  return {
    issue_id: ISSUE_ID,
    month_key: MONTH_KEY,
    cadence: "monthly",
    generated_at: nowIso(),
    timezone: "America/Halifax",
    primary_cta: "Register for the showcase",
    items: [
      {
        source_item_id: "src_showcase",
        title: "AI Residency Showcase",
        evidence: "Residency teams demo what they built this cohort.",
        url: "https://voltaeffect.com/events/ai-residency-showcase",
        event_start_at: futureIso(14),
        audiences: ["founder", "builder"],
        source_authority: "volta",
        allowed_claims: ["Volta's source describes it as: AI Residency Showcase"],
      },
      {
        source_item_id: "src_cohort",
        title: "AI Residency opens applications for cohort four",
        evidence: "Applications close at the end of the month.",
        url: "https://voltaeffect.com/news/ai-residency-cohort-four",
        published_at: nowIso(),
        audiences: ["founder"],
        source_authority: "volta",
        allowed_claims: ["Volta's source describes it as: cohort four applications"],
      },
    ],
  };
}

function generatedVariant(): GeneratedVariant {
  return {
    kind: "founder_signal",
    subject: "Volta this month: showcase and cohort four",
    preheader: "What founders should act on this month.",
    intro: "Two things are worth your attention this month.",
    primaryCta: {
      label: "Register for the showcase",
      url: "https://voltaeffect.com/events/ai-residency-showcase",
    },
    sections: [
      {
        heading: "Coming up",
        items: [
          {
            sourceItemIds: ["src_showcase"],
            headline: "Residency teams demo their work",
            copy: "Residency teams demo what they built this cohort.",
          },
        ],
      },
      {
        heading: "Deadlines",
        items: [
          {
            sourceItemIds: ["src_cohort"],
            headline: "Cohort four applications are open",
            copy: "Applications close at the end of the month.",
          },
        ],
      },
    ],
    rationale: "Leads with the deadline founders can act on.",
  };
}

async function seedIssue(config: Config): Promise<void> {
  const pack = factsPack();
  const generated = generatedVariant();

  await upsertIssue(db as never, {
    id: ISSUE_ID,
    monthKey: MONTH_KEY,
    status: "collecting",
    primaryCta: pack.primary_cta,
  });
  await setIssueFactsPack(db as never, ISSUE_ID, pack, []);
  await transitionIssue(db as never, ISSUE_ID, ["collecting"], "review");

  const rendered = renderVariant(generated, {
    monthKey: MONTH_KEY,
    timezone: config.timezone,
    factsPack: pack,
  });

  const record: VariantRecord = {
    id: VARIANT_ID,
    issueId: ISSUE_ID,
    kind: "founder_signal",
    subject: generated.subject,
    preheader: generated.preheader,
    structured: generated,
    htmlBody: rendered.html,
    textBody: rendered.text,
    checksum: await variantChecksum(generated),
    qualityScore: 88,
    readingMinutes: rendered.readingMinutes,
    warnings: [],
    revision: 1,
    createdAt: nowIso(),
  };
  await insertVariant(db as never, record);
}

/** Records every outbound request and answers as the ESP and Volta's site. */
function installFetchStub(options: { sendBehaviour?: "ok" | "timeout" | "error" } = {}) {
  const behaviour = options.sendBehaviour ?? "ok";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });

    if (url.includes("voltaeffect.com")) return new Response(null, { status: 200 });

    if (url.endsWith("/campaigns") && method === "POST") {
      return new Response(JSON.stringify({ id: "camp_1" }), { status: 200 });
    }
    if (url.endsWith("/campaigns/camp_1/content") && method === "PUT") {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (url.endsWith("/campaigns/camp_1/actions/send") && method === "POST") {
      if (behaviour === "timeout") throw new TypeError("network timeout");
      if (behaviour === "error") return new Response(JSON.stringify({ detail: "bad" }), { status: 400 });
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/campaigns/camp_1") && method === "GET") {
      return new Response(JSON.stringify({ status: "sent" }), { status: 200 });
    }
    if (url.includes("/lists/")) {
      return new Response(JSON.stringify({ name: "Volta founders", stats: { member_count: 900 } }), { status: 200 });
    }

    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
}

function sendCallCount(): number {
  return calls.filter((call) => call.url.endsWith("/actions/send") && call.method === "POST").length;
}

beforeEach(() => {
  db = createTestDb();
  calls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  db.close();
});

/* Idempotency key shape. */

test("the live-send key is derived from issue, variant, audience, and mode", async () => {
  const live = await sendIdempotencyKey(ISSUE_ID, VARIANT_ID, AUDIENCE_ID, "live");
  const sameAgain = await sendIdempotencyKey(ISSUE_ID, VARIANT_ID, AUDIENCE_ID, "live");
  const testMode = await sendIdempotencyKey(ISSUE_ID, VARIANT_ID, AUDIENCE_ID, "test");

  assert.equal(live, sameAgain);
  assert.notEqual(live, testMode);
  assert.match(live, /^[0-9a-f]{64}$/);
});

/* 11. Reject a non-approver live-send attempt. */

test("a non-approver cannot trigger a live send", async () => {
  const config = testConfig();
  installFetchStub();
  await seedIssue(config);

  const outcome = await approveAndSend(db as never, config, VARIANT_ID, "U_INTRUDER");

  assert.equal(outcome.status, "blocked");
  assert.match(outcome.message, /allowlist/);
  assert.equal(sendCallCount(), 0);

  const issue = await getIssue(db as never, ISSUE_ID);
  assert.equal(issue?.status, "review");

  const audit = await db
    .prepare("SELECT action FROM audit_events WHERE action = 'unauthorized_send_attempt'")
    .first<{ action: string }>();
  assert.equal(audit?.action, "unauthorized_send_attempt");
});

test("live send stays blocked while LIVE_SEND_ENABLED is false", async () => {
  const config = testConfig({ LIVE_SEND_ENABLED: "false" });
  installFetchStub();
  await seedIssue(config);

  const outcome = await approveAndSend(db as never, config, VARIANT_ID, "U_APPROVER");

  assert.equal(outcome.status, "blocked");
  assert.equal(sendCallCount(), 0);
});

/* 12. Double-click live send and prove one provider call. */

test("repeated approval clicks produce exactly one provider send call", async () => {
  const config = testConfig();
  installFetchStub();
  await seedIssue(config);

  const first = await approveAndSend(db as never, config, VARIANT_ID, "U_APPROVER");
  assert.equal(first.status, "sent");
  assert.equal(first.campaignId, "camp_1");

  const second = await approveAndSend(db as never, config, VARIANT_ID, "U_APPROVER");
  assert.equal(second.status, "duplicate");

  assert.equal(sendCallCount(), 1);

  const issue = await getIssue(db as never, ISSUE_ID);
  assert.equal(issue?.status, "sent");
  assert.ok(issue?.sentAt);

  const attempts = await db
    .prepare("SELECT COUNT(*) AS count FROM send_attempts WHERE mode = 'live'")
    .first<{ count: number }>();
  assert.equal(attempts?.count, 1);
});

test("concurrent approvals still result in a single send", async () => {
  const config = testConfig();
  installFetchStub();
  await seedIssue(config);

  const outcomes = await Promise.all([
    approveAndSend(db as never, config, VARIANT_ID, "U_APPROVER"),
    approveAndSend(db as never, config, VARIANT_ID, "U_APPROVER"),
  ]);

  assert.equal(sendCallCount(), 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "sent").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "sent" || outcome.status === "duplicate" || outcome.status === "blocked").length, 2);
});

/* 13. Handle an ambiguous provider timeout by querying campaign state. */

test("an ambiguous send timeout is resolved by querying campaign status", async () => {
  const config = testConfig();
  installFetchStub({ sendBehaviour: "timeout" });
  await seedIssue(config);

  const outcome = await approveAndSend(db as never, config, VARIANT_ID, "U_APPROVER");

  assert.equal(outcome.status, "sent");
  assert.match(outcome.message, /ambiguous/i);
  // The send endpoint was called once and never retried.
  assert.equal(sendCallCount(), 1);
  assert.equal(
    calls.filter((call) => call.method === "GET" && call.url.endsWith("/campaigns/camp_1")).length,
    1,
  );

  const issue = await getIssue(db as never, ISSUE_ID);
  assert.equal(issue?.status, "sent");
});

test("a hard provider error fails the issue without a second send call", async () => {
  const config = testConfig();
  installFetchStub({ sendBehaviour: "error" });
  await seedIssue(config);

  const outcome = await approveAndSend(db as never, config, VARIANT_ID, "U_APPROVER");

  assert.equal(outcome.status, "failed");
  assert.equal(sendCallCount(), 1);

  const issue = await getIssue(db as never, ISSUE_ID);
  assert.equal(issue?.status, "failed");

  const attempt = await db
    .prepare("SELECT status, error_code FROM send_attempts WHERE mode = 'live'")
    .first<{ status: string; error_code: string }>();
  assert.equal(attempt?.status, "failed");
});

/* Preflight after approval. */

test("a broken primary link after approval blocks the send and returns the issue to review", async () => {
  const config = testConfig();
  installFetchStub();
  const stub = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("ai-residency-showcase")) {
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      return new Response(null, { status: 404 });
    }
    return stub(input, init);
  }) as typeof fetch;

  await seedIssue(config);
  const outcome = await approveAndSend(db as never, config, VARIANT_ID, "U_APPROVER");

  assert.equal(outcome.status, "blocked");
  assert.ok(outcome.findings?.some((finding) => finding.code === "primary_link_broken"));
  assert.equal(sendCallCount(), 0);

  const issue = await getIssue(db as never, ISSUE_ID);
  assert.equal(issue?.status, "review");
});
