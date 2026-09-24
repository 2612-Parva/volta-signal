# Volta Signal

An editorial operations system for Volta's **monthly** founders newsletter.

Every month it collects trustworthy public signals, builds one canonical facts
pack, generates three evidence-backed newsletter variants, runs deterministic
quality checks, posts a review card to a private Slack channel, and lets an
authorized approver send one edition through Mailchimp.

The LLM is replaceable. The durable value is source collection, provenance,
monthly memory, validation, approval, sending, and outcome measurement.

## Monthly cadence

The reference design was weekly; this build ships once a month in the first
week, matching Volta's founders cadence.

| Stage | Default schedule (America/Halifax) | What happens |
|---|---|---|
| `collect` | day 1 at 16:00 | Fetch sources, score, store the canonical facts pack |
| `publish` | first Monday at 07:30 | Refresh, generate three variants, validate, post to Slack |
| approval | on click | Re-run link/date/template preflight, then send exactly once |
| early metrics | 28 h after send | Aggregate campaign metrics |
| settled metrics | 168 h after send | Final metrics for the issue report |

Collection windows widened for the monthly rhythm: news within 31 days,
evergreen opportunities within 90 days, events up to 45 days ahead, and reuse
suppressed for 120 days.

Cloudflare cron is UTC-only, so the worker fires every 30 minutes and
`src/schedule.ts` decides whether the Halifax-local window has arrived. A stage
stays eligible for the rest of its local day, and a unique `job_runs` key makes
sure it still runs only once.

All timings are configuration, not code: `PUBLISH_DAY` accepts `first-monday`
(or any weekday) or a plain day-of-month number.

## Architecture

```text
allowlisted public sources        approved internal signals
            |                                |
            +----------------+---------------+
                             v
                  collect -> normalize -> deduplicate -> score
                             v
                     canonical facts pack  (issues.facts_pack_json)
                             v
              three structured variants from one LLM call
                             v
        deterministic QA: content, links, email, provenance
                             v
                   private Slack review card
                             v
     revision | test send | approve and send | blocked
                             v
                Mailchimp audience + campaign
                             v
              aggregate metrics back onto the issue
```

Subscriber records never leave Mailchimp. This system stores audience IDs,
campaign IDs, and aggregate counts only.

## Layout

```text
migrations/0001_init.sql   schema: issues, source_items, variants, send_attempts, audit_events, job_runs, issue_metrics
src/index.ts               worker routes + scheduled entry point
src/config.ts              env parsing, per-path capability checks
src/schedule.ts            Halifax-local monthly guard, DST-safe conversion
src/sources.ts             allowlisted source registry
src/net.ts                 SSRF-guarded fetch, URL canonicalization, UTM
src/parse.ts               ICS, RSS/Atom, JSON-LD, HTML, sitemap parsers
src/score.ts               deterministic scoring and inclusion rules
src/collect.ts             normalization, dedupe, storage, selection
src/generate.ts            facts pack, prompt, LLM output contract
src/validate.ts            content/link/email checks and release policy
src/render.ts              table-based HTML + plain text
src/slack.ts               signature verification, blocks, modals
src/email.ts               Mailchimp campaign/test/status/report calls
src/preview.ts             signed, expiring preview links
src/pipeline.ts            stage orchestration and the send state machine
src/db.ts                  explicit SQL helpers
test/                      node:test suite with saved fixtures
```

## Setup

Local development needs no Cloudflare account. The placeholder `database_id` in
`wrangler.toml` is fine until you deploy; local D1 lives in `.wrangler/state`.

```bash
npm install
npm run migrate:local
cp .dev.vars.example .dev.vars             # fill in what you have
npm run dev
```

Only when you are ready to deploy do you need to authenticate and create the
remote database:

```bash
npx wrangler login                          # or set CLOUDFLARE_API_TOKEN
npx wrangler d1 create volta_signal         # paste the id into wrangler.toml
npm run migrate:remote
```

Missing credentials never block the draft path. `GET /health` lists which
environment variable *names* are still missing per path (never values).

## Endpoints

| Route | Purpose |
|---|---|
| `GET /architecture` | public map of CLAUDE.md, skills, memory, logs, Worker |
| `POST /slack/commands` | Slack `/volta publish` · `card` · `status` |
| `GET /health` | version, environment, schedule, DB reachability, missing config names |
| `GET /preview/:variantId?token=` | HMAC-signed, 7-day, `noindex` draft preview |
| `POST /slack/actions` | Slack interactivity (signature-verified) |
| `POST /admin/run` | manual stage run, staging only, bearer `ADMIN_RUN_SECRET` |
| `POST /admin/signal` | store an approved internal signal with consent |
| `GET /admin/status` | current month's issue status |

First safe manual run, once `LLM_API_KEY` is set:

```bash
curl -X POST http://localhost:8787/admin/run \
  -H "authorization: Bearer $ADMIN_RUN_SECRET" \
  -H "content-type: application/json" \
  -d '{"stage":"publish","post":false}'
```

`post:false` generates and validates without touching Slack.

On Windows, `dev.ps1` wraps the same routes and mints preview tokens for you:

```powershell
.\dev.ps1 health
.\dev.ps1 publish -NoPost
.\dev.ps1 status
.\dev.ps1 preview var_abc123
```

## Safety properties

- No send without an explicit authorized approval, and `LIVE_SEND_ENABLED`
  defaults to `false` in every environment.
- One provider send call per `sha256(issue:variant:audience:mode)`; a repeated
  click returns the existing state.
- An ambiguous provider response triggers a campaign-status query, never a
  blind retry.
- Every factual block cites stored source item IDs; unknown IDs, out-of-pack
  URLs, and unsupported numbers or dates are rejected before rendering.
- Fetched text is treated as untrusted data, delimited in the prompt, and can
  never introduce a URL.
- Source fetches block loopback, link-local, private, and metadata hosts, cap
  size and duration, and re-validate every redirect hop.
- Overrides and approvals are written to `audit_events`.

## Tests

```bash
npm run check    # typecheck (src + test) and the full suite
```

Tests use saved fixtures and a SQLite-backed D1 shim, so nothing touches the
live network. They cover URL canonicalization, the Volta ICS/blog/sitemap/
JSON-LD parsers, dedupe, expired events, unapproved internal signals, unknown
source IDs, unsupported facts, missing unsubscribe placeholders, Slack
signature verification, the approver allowlist, duplicate-click sends, ambiguous
timeouts, prompt-injection resistance, and Halifax DST boundaries.

## Not built yet

Deliberately out of scope until pilot evidence asks for it: a custom editor, an
admin dashboard, a subscriber database, three permanent segments, autonomous
sending, browser automation, multi-provider abstractions, and vector search.

See `RUNBOOK.md` for operations, missing inputs, and recovery.
