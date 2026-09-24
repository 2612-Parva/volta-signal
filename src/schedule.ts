import type { Config } from "./config.ts";

export type Stage = "collect" | "publish";

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
  minutesOfDay: number;
};

const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/**
 * Cloudflare cron fires in UTC and Halifax observes DST, so every schedule
 * decision is made from wall-clock parts in the configured timezone.
 */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);

  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") lookup[part.type] = part.value;
  }

  const year = Number(lookup.year);
  const month = Number(lookup.month);
  const day = Number(lookup.day);
  const hour = Number(lookup.hour);
  const minute = Number(lookup.minute);

  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minutesOfDay: hour * 60 + minute,
  };
}

/** Offset of `timeZone` from UTC at `date`, in milliseconds (minute resolution). */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const truncated = Math.floor(date.getTime() / 60_000) * 60_000;
  return asUtc - truncated;
}

/**
 * Converts a wall-clock time in `timeZone` to a UTC instant. Two passes handle
 * the DST boundary where the first offset guess is wrong.
 */
export function zonedTimeToUtc(
  wall: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour ?? 0,
    wall.minute ?? 0,
    wall.second ?? 0,
  );
  const firstGuess = naive - tzOffsetMs(new Date(naive), timeZone);
  const secondOffset = tzOffsetMs(new Date(firstGuess), timeZone);
  return new Date(naive - secondOffset);
}

/** Issue key for a monthly cadence, e.g. `2026-09`. */
export function monthKeyOf(date: Date, timeZone: string): string {
  const { year, month } = zonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function parseMonthKey(monthKey: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new Error(`Invalid month key: ${monthKey}`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function issueIdForMonth(monthKey: string): string {
  const { year, month } = parseMonthKey(monthKey);
  return `${year}-M${String(month).padStart(2, "0")}`;
}

/** Human label such as `September 2026`. */
export function monthLabel(monthKey: string): string {
  const { year, month } = parseMonthKey(monthKey);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
  return formatter.format(new Date(Date.UTC(year, month - 1, 1)));
}

export function parseLocalTime(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid local time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid local time: ${value}`);
  return hour * 60 + minute;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Resolves a day spec to a day of the month.
 * Accepts `first-monday` ... `first-sunday`, or a plain day number as a string.
 */
export function resolveDayOfMonth(spec: string, year: number, month: number): number {
  const normalized = spec.trim().toLowerCase();
  const weekdayMatch = /^first-([a-z]+)$/.exec(normalized);
  if (weekdayMatch) {
    const target = WEEKDAY_NAMES.indexOf(weekdayMatch[1] ?? "");
    if (target < 0) throw new Error(`Invalid day spec: ${spec}`);
    const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((target - firstWeekday + 7) % 7);
  }

  const day = Number(normalized);
  if (!Number.isInteger(day) || day < 1) throw new Error(`Invalid day spec: ${spec}`);
  return Math.min(day, daysInMonth(year, month));
}

export type StageWindow = {
  stage: Stage;
  dayOfMonth: number;
  minutesOfDay: number;
};

export function stageWindow(stage: Stage, config: Config, year: number, month: number): StageWindow {
  const spec = stage === "collect" ? config.collectDay : config.publishDay;
  const time = stage === "collect" ? config.collectLocalTime : config.publishLocalTime;
  return {
    stage,
    dayOfMonth: resolveDayOfMonth(spec, year, month),
    minutesOfDay: parseLocalTime(time),
  };
}

/**
 * The standalone collect stage is skipped when it would land on or after the
 * publish stage; publishing collects on demand in that case.
 */
export function collectStageEnabled(config: Config, year: number, month: number): boolean {
  const collect = stageWindow("collect", config, year, month);
  const publish = stageWindow("publish", config, year, month);
  if (collect.dayOfMonth < publish.dayOfMonth) return true;
  if (collect.dayOfMonth > publish.dayOfMonth) return false;
  return collect.minutesOfDay < publish.minutesOfDay;
}

/**
 * Which stages are eligible right now. A stage stays eligible until the end of
 * its local day so a missed cron tick still produces the monthly issue; the
 * `job_runs` unique key is what actually prevents a second execution.
 */
export function dueStages(now: Date, config: Config): Stage[] {
  const parts = zonedParts(now, config.timezone);
  const due: Stage[] = [];

  for (const stage of ["collect", "publish"] as Stage[]) {
    if (stage === "collect" && !collectStageEnabled(config, parts.year, parts.month)) continue;
    const window = stageWindow(stage, config, parts.year, parts.month);
    if (parts.day !== window.dayOfMonth) continue;
    if (parts.minutesOfDay < window.minutesOfDay) continue;
    due.push(stage);
  }

  return due;
}

export function jobKey(monthKey: string, stage: string): string {
  return `${monthKey}:${stage}`;
}

export function hoursSince(iso: string, now: Date = new Date()): number {
  return (now.getTime() - Date.parse(iso)) / 3_600_000;
}

/** Next scheduled publish instant, used by `/health` and Slack footers. */
export function describeSchedule(config: Config, now: Date = new Date()): string {
  const parts = zonedParts(now, config.timezone);
  const window = stageWindow("publish", config, parts.year, parts.month);
  return `monthly · day ${window.dayOfMonth} at ${config.publishLocalTime} ${config.timezone}`;
}
