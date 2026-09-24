# Volta Signal runbook

One page for whoever is on the hook when the monthly edition misbehaves.

## Kill switch

```bash
npx wrangler secret put LIVE_SEND_ENABLED --env production   # value: false
```

`LIVE_SEND_ENABLED=false` blocks every live send while leaving collection,
generation, Slack review, and test sends working. It ships as `false`.

To stop the scheduled run entirely, remove the `crons` entry from
`wrangler.toml` and redeploy, or disable the trigger in the Cloudflare
dashboard.

## Authenticating Wrangler

Local development needs no authentication. For anything remote (`d1 create`,
`--remote` migrations, `secret put`, `deploy`), use an API token rather than the
OAuth browser flow, which fails behind some browsers with a CSRF error:

```powershell
$env:CLOUDFLARE_API_TOKEN = "<token>"
$env:CLOUDFLARE_ACCOUNT_ID = "<account id>"
npx wrangler whoami
```

Create the token at Cloudflare → My Profile → API Tokens → Create Token →
"Edit Cloudflare Workers", and confirm it includes **Account → D1: Edit**.
Use `setx` to persist it for future shells. Treat it like any other secret: it
is account-wide and is not stored in this repository.

## Deploy

```bash
npm run check
npx wrangler d1 migrations apply volta_signal --remote --env production
npx wrangler deploy --env production
curl https://<app-base-url>/health
```

`/health` must report `database: ok` and an empty `missing.draft` list.

## Manual run (preferred)

In `#volta-signal-review`, an approver types:

- `/volta publish` — generate three variants and post the review card
- `/volta card` — refresh Mailchimp drafts and re-post Slack
- `/volta status` — this month’s issue

Send test and Approve and send are buttons on the card. The slash command does not email the list.

## Rerun a stage by hand (API)

Staging only; `/admin/*` refuses to run in production.

```bash
curl -X POST https://<staging-url>/admin/run \
  -H "authorization: Bearer $ADMIN_RUN_SECRET" \
  -H "content-type: application/json" \
  -d '{"stage":"publish"}'          # or {"stage":"collect"}
```

The scheduled path is guarded by a unique key in `job_runs`. To let a stage run
again this month:

```bash
npx wrangler d1 execute volta_signal --remote \
  --command "DELETE FROM job_runs WHERE job_key = '2026-09:publish'"
```

A stage that ended in `failed` is released automatically on the next tick.

## Failure playbook

| Symptom | What the system already did | Your move |
|---|---|---|
| One source failed | Warning in Slack, no substitute content | Check the URL in `src/sources.ts`; disable it if the page moved |
| All first-party sources failed | Blocking finding, no recommendation | Fix the source, then rerun the publish stage |
| Too little content | `thin_issue` warning | Approve a light edition or skip the month |
| LLM invalid JSON | Retried once with the validation errors, then stopped | Rerun the stage; if it repeats, inspect the facts pack in `issues.facts_pack_json` |
| Slack post failed | Bounded backoff, issue still stored | Rerun publish; the issue and variants are reused |
| Test send failed | Attempt marked failed, live eligibility untouched | Fix the ESP credential and retry |
| Live response ambiguous | Queried campaign status before concluding | Nothing; confirm in the Slack thread |
| Link broke after approval | Send blocked, issue returned to `review` | Request a revision, then approve again |
| Repeated approval click | Returned the existing send state | Nothing |
| Approval expired (60 min) | Preflight blocked the send | Approve again from the Slack card |

Nothing critical fails silently: a failed stage posts to the review channel and
writes to `audit_events`.

## Inspect an issue

```bash
npx wrangler d1 execute volta_signal --remote \
  --command "SELECT id, month_key, status, recommended_variant, sent_at FROM issues ORDER BY created_at DESC LIMIT 6"

npx wrangler d1 execute volta_signal --remote \
  --command "SELECT actor, action, created_at FROM audit_events WHERE issue_id = '2026-M09' ORDER BY created_at"
```

## Secret rotation

```bash
npx wrangler secret put <NAME> --env production
```

Rotate on Volta's normal schedule, and immediately when someone with access
leaves: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `LLM_API_KEY`, `ESP_API_KEY`,
`PREVIEW_SIGNING_SECRET`, `ADMIN_RUN_SECRET`.

Rotating `PREVIEW_SIGNING_SECRET` invalidates outstanding preview links; repost
the review card to issue fresh ones. Rotating `SLACK_SIGNING_SECRET` requires
updating it in the Slack app first, or interactions start returning 401.

Secrets never appear in `wrangler.toml`, logs, Slack messages, or previews.

## Inputs still required before live send

These are people decisions, not code. Collect them, then set the secret.

| Input | Owner | Unlocks |
|---|---|---|
| Private review channel ID | Bader | Draft delivery |
| Slack bot token + signing secret | Slack admin | Interactions |
| Authorized Slack user IDs | Bader / Matt | Approval control |
| Mailchimp API key | Bader | Test and live send |
| Production audience ID | Bader | Live send |
| Test audience ID | Bader | Safe testing |
| Mailchimp template ID | Bader | Brand and deliverability |
| Verified sender + reply-to | Bader | Campaign creation |
| Quarterly primary CTA | Matt | Content ranking |
| Approved internal signal workflow | Laura | Member stories |
| Official event feed/API | Amy | Higher-confidence events |

Sources in `src/sources.ts` whose URL is not yet confirmed are shipped
`enabled: false` with a note naming the owner. Do not invent a URL to turn one
on; confirm it, then flip the flag.

## Go-live checklist

1. `npm run check` passes.
2. `/health` shows no missing values for `slack`, `preview`, and `test_send`.
3. A test campaign rendered correctly in the test audience.
4. The approval button was clicked twice in staging and produced exactly one
   provider send call.
5. `SLACK_APPROVER_IDS` contains only people who may send.
6. Only then set `LIVE_SEND_ENABLED=true`.
