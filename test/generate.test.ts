import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { loadConfig, type Config, type Env } from "../src/config.ts";
import { buildFactsPack, buildUserPrompt, generateIssue, GenerationError } from "../src/generate.ts";
import type { FactsPack, SourceItem } from "../src/types.ts";

let originalFetch: typeof fetch;

function config(): Config {
  return loadConfig({ LLM_API_KEY: "test-key", LLM_MODEL: "test-model", TIMEZONE: "America/Halifax" } as unknown as Env);
}

function sourceItem(overrides: Partial<SourceItem> = {}): SourceItem {
  return {
    id: "src_showcase",
    canonicalUrl: "https://voltaeffect.com/events/ai-residency-showcase",
    sourceDomain: "voltaeffect.com",
    sourceKind: "ics",
    sourceId: "volta_events_ics",
    title: "AI Residency Showcase",
    evidenceText: "Residency teams demo what they built this cohort.",
    eventStartAt: "2026-09-24T20:30:00.000Z",
    audiences: ["founder"],
    consent: "public",
    confidence: 25,
    score: 80,
    contentHash: "hash",
    ...overrides,
  };
}

function pack(): FactsPack {
  return buildFactsPack({
    issueId: "2026-M09",
    monthKey: "2026-09",
    items: [
      sourceItem(),
      sourceItem({
        id: "src_cohort",
        canonicalUrl: "https://voltaeffect.com/news/ai-residency-cohort-four",
        title: "AI Residency opens applications for cohort four",
        evidenceText: "Applications close at the end of the month.",
        eventStartAt: undefined,
        publishedAt: "2026-09-02T00:00:00.000Z",
      }),
    ],
    primaryCta: "Register for the showcase",
    timezone: "America/Halifax",
    generatedAt: "2026-09-07T10:00:00Z",
  });
}

function validResponse(kind = "founder_signal") {
  return {
    variants: [
      {
        kind,
        subject: "Volta this month: showcase and cohort four",
        preheader: "What founders should act on this month.",
        intro: "Two things are worth your attention.",
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
        ],
        rationale: "Leads with the most actionable item.",
      },
    ],
  };
}

function stubLlm(responses: unknown[]): { prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ role: string; content: string }>;
    };
    prompts.push(body.messages?.[1]?.content ?? "");
    const payload = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      { status: 200 },
    );
  }) as typeof fetch;

  return { prompts };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("the facts pack contains only eligible records and their allowed claims", () => {
  const factsPack = pack();
  assert.equal(factsPack.cadence, "monthly");
  assert.equal(factsPack.items.length, 2);
  assert.equal(factsPack.items[0]!.source_item_id, "src_showcase");
  assert.ok(factsPack.items[0]!.allowed_claims.length > 0);
});

test("the prompt delimits the facts pack as untrusted data", () => {
  const prompt = buildUserPrompt(pack(), config());
  assert.match(prompt, /<FACTS_PACK_UNTRUSTED_DATA>/);
  assert.match(prompt, /<\/FACTS_PACK_UNTRUSTED_DATA>/);
  assert.match(prompt, /monthly, first week/);
});

test("a valid single-variant revision is accepted on the first attempt", async () => {
  const { prompts } = stubLlm([validResponse()]);
  const result = await generateIssue(config(), pack(), { onlyKind: "founder_signal", revisionNote: "shorter" });

  assert.equal(result.attempts, 1);
  assert.equal(result.issue.variants.length, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Revision requested by the reviewer/);
  assert.match(prompts[0]!, /exactly one object/);
});

test("revision ignores extra variant kinds instead of failing", async () => {
  const noisy = {
    variants: [
      validResponse("founder_signal").variants[0],
      validResponse("builder_dispatch").variants[0],
      validResponse("community_pulse").variants[0],
    ],
  };
  stubLlm([noisy]);
  const result = await generateIssue(config(), pack(), {
    onlyKind: "founder_signal",
    revisionNote: "more founder-focused",
  });
  assert.equal(result.attempts, 1);
  assert.equal(result.issue.variants.length, 1);
  assert.equal(result.issue.variants[0]!.kind, "founder_signal");
});

test("invalid model output is retried exactly once with the validation errors", async () => {
  const invalid = {
    variants: [
      {
        ...validResponse().variants[0],
        sections: [
          {
            heading: "Coming up",
            items: [{ sourceItemIds: ["src_hallucinated"], headline: "Mystery", copy: "Something." }],
          },
        ],
      },
    ],
  };

  const { prompts } = stubLlm([invalid, validResponse()]);
  const result = await generateIssue(config(), pack(), { onlyKind: "founder_signal" });

  assert.equal(result.attempts, 2);
  assert.match(prompts[1]!, /unknown_source_id/);
});

test("generation stops after one failed retry instead of looping", async () => {
  const invalid = { variants: [] };
  const { prompts } = stubLlm([invalid, invalid, invalid]);

  await assert.rejects(
    () => generateIssue(config(), pack(), { onlyKind: "founder_signal" }),
    (error: unknown) => error instanceof GenerationError && error.errors.length > 0,
  );
  assert.equal(prompts.length, 2);
});
