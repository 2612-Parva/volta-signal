import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig, type Config, type Env } from "../src/config.ts";
import {
  collectStageEnabled,
  dueStages,
  issueIdForMonth,
  jobKey,
  monthKeyOf,
  monthLabel,
  resolveDayOfMonth,
  stageWindow,
  tzOffsetMs,
  zonedParts,
  zonedTimeToUtc,
} from "../src/schedule.ts";

const TZ = "America/Halifax";

function config(overrides: Partial<Env> = {}): Config {
  return loadConfig({
    TIMEZONE: TZ,
    PUBLISH_DAY: "first-monday",
    PUBLISH_LOCAL_TIME: "07:30",
    COLLECT_DAY: "1",
    COLLECT_LOCAL_TIME: "16:00",
    ...overrides,
  } as unknown as Env);
}

/* 15. Convert the schedule correctly across Halifax DST boundaries. */

test("the same local publish time maps to different UTC instants across DST", () => {
  const cfg = config();

  // March 2026: first Monday is the 2nd, still Atlantic Standard Time (UTC-4).
  assert.equal(resolveDayOfMonth(cfg.publishDay, 2026, 3), 2);
  assert.deepEqual(dueStages(new Date("2026-03-02T11:29:00Z"), cfg), []);
  assert.deepEqual(dueStages(new Date("2026-03-02T11:30:00Z"), cfg), ["publish"]);

  // September 2026: first Monday is the 7th, Atlantic Daylight Time (UTC-3).
  assert.equal(resolveDayOfMonth(cfg.publishDay, 2026, 9), 7);
  assert.deepEqual(dueStages(new Date("2026-09-07T10:29:00Z"), cfg), []);
  assert.deepEqual(dueStages(new Date("2026-09-07T10:30:00Z"), cfg), ["publish"]);
});

test("offsets and wall-clock conversion follow the DST transition", () => {
  assert.equal(tzOffsetMs(new Date("2026-01-15T12:00:00Z"), TZ), -4 * 3_600_000);
  assert.equal(tzOffsetMs(new Date("2026-07-15T12:00:00Z"), TZ), -3 * 3_600_000);

  // 13:00 Halifax on a summer date is 16:00 UTC.
  assert.equal(
    zonedTimeToUtc({ year: 2026, month: 9, day: 10, hour: 13 }, TZ).toISOString(),
    "2026-09-10T16:00:00.000Z",
  );
  // The same wall clock in winter is 17:00 UTC.
  assert.equal(
    zonedTimeToUtc({ year: 2026, month: 1, day: 10, hour: 13 }, TZ).toISOString(),
    "2026-01-10T17:00:00.000Z",
  );
});

test("month keys follow Halifax local time, not UTC", () => {
  // 02:00 UTC on October 1 is still 23:00 on September 30 in Halifax.
  assert.equal(monthKeyOf(new Date("2026-10-01T02:00:00Z"), TZ), "2026-09");
  assert.equal(monthKeyOf(new Date("2026-10-01T04:00:00Z"), TZ), "2026-10");
  assert.equal(issueIdForMonth("2026-09"), "2026-M09");
  assert.equal(monthLabel("2026-09"), "September 2026");
  assert.equal(jobKey("2026-09", "publish"), "2026-09:publish");
});

test("resolves day specs, including clamping and weekday lookup", () => {
  assert.equal(resolveDayOfMonth("2", 2026, 9), 2);
  assert.equal(resolveDayOfMonth("31", 2026, 2), 28);
  assert.equal(resolveDayOfMonth("first-tuesday", 2026, 9), 1);
  assert.equal(resolveDayOfMonth("first-sunday", 2026, 3), 1);
  assert.throws(() => resolveDayOfMonth("first-caturday", 2026, 9), /Invalid day spec/);
});

test("a stage stays eligible later the same day so a missed tick still ships", () => {
  const cfg = config();
  assert.deepEqual(dueStages(new Date("2026-09-07T16:00:00Z"), cfg), ["publish"]);
  assert.deepEqual(dueStages(new Date("2026-09-08T10:30:00Z"), cfg), []);
});

test("the collect stage is skipped when it would land after publishing", () => {
  const cfg = config();
  // September: collect on the 1st, publish on the 7th.
  assert.equal(collectStageEnabled(cfg, 2026, 9), true);
  assert.deepEqual(dueStages(new Date("2026-09-01T19:00:00Z"), cfg), ["collect"]);

  // June 2026 begins on a Monday, so publishing would precede collection.
  assert.equal(stageWindow("publish", cfg, 2026, 6).dayOfMonth, 1);
  assert.equal(collectStageEnabled(cfg, 2026, 6), false);
  assert.deepEqual(dueStages(new Date("2026-06-01T19:00:00Z"), cfg), ["publish"]);
});

test("zonedParts reports Halifax wall-clock fields", () => {
  const parts = zonedParts(new Date("2026-09-07T10:30:00Z"), TZ);
  assert.deepEqual(
    { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, weekday: parts.weekday },
    { year: 2026, month: 9, day: 7, hour: 7, minute: 30, weekday: 1 },
  );
});
