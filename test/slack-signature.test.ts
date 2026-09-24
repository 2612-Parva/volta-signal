import assert from "node:assert/strict";
import { test } from "node:test";

import { isApprover, verifySlackSignature } from "../src/slack.ts";
import { hmacSha256Hex } from "../src/util.ts";
import { loadConfig, type Env } from "../src/config.ts";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const RAW_BODY =
  "payload=%7B%22type%22%3A%22block_actions%22%2C%22user%22%3A%7B%22id%22%3A%22U123%22%7D%7D";
const NOW = new Date("2026-09-07T12:00:00Z");

async function sign(timestamp: string, body: string = RAW_BODY): Promise<string> {
  return `v0=${await hmacSha256Hex(SECRET, `v0:${timestamp}:${body}`)}`;
}

/* 9. Verify a valid Slack signature. */

test("accepts a valid signature inside the replay window", async () => {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const signature = await sign(timestamp);

  assert.equal(
    await verifySlackSignature({ signingSecret: SECRET, timestamp, signature, rawBody: RAW_BODY, now: NOW }),
    true,
  );
});

/* 10. Reject an invalid or stale Slack signature. */

test("rejects tampered bodies, wrong secrets, and stale timestamps", async () => {
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const signature = await sign(timestamp);

  // Body changed after signing.
  assert.equal(
    await verifySlackSignature({
      signingSecret: SECRET,
      timestamp,
      signature,
      rawBody: `${RAW_BODY}&extra=1`,
      now: NOW,
    }),
    false,
  );

  // Signed with a different secret.
  assert.equal(
    await verifySlackSignature({
      signingSecret: "another-secret",
      timestamp,
      signature,
      rawBody: RAW_BODY,
      now: NOW,
    }),
    false,
  );

  // Six minutes old: outside the five-minute replay window.
  const staleTimestamp = String(Math.floor(NOW.getTime() / 1000) - 360);
  assert.equal(
    await verifySlackSignature({
      signingSecret: SECRET,
      timestamp: staleTimestamp,
      signature: await sign(staleTimestamp),
      rawBody: RAW_BODY,
      now: NOW,
    }),
    false,
  );

  // Missing headers.
  assert.equal(
    await verifySlackSignature({ signingSecret: SECRET, timestamp: null, signature, rawBody: RAW_BODY, now: NOW }),
    false,
  );
  assert.equal(
    await verifySlackSignature({ signingSecret: SECRET, timestamp, signature: null, rawBody: RAW_BODY, now: NOW }),
    false,
  );
  assert.equal(
    await verifySlackSignature({ signingSecret: SECRET, timestamp, signature: "v0=deadbeef", rawBody: RAW_BODY, now: NOW }),
    false,
  );
});

/* 11a. Approver allowlist. */

test("only allowlisted Slack users are approvers", () => {
  const config = loadConfig({ SLACK_APPROVER_IDS: "U123, U456" } as unknown as Env);
  assert.equal(isApprover(config, "U123"), true);
  assert.equal(isApprover(config, "U456"), true);
  assert.equal(isApprover(config, "U999"), false);
  assert.equal(isApprover(config, undefined), false);
});
