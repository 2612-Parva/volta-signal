# Pipeline log — 2026-09

What actually ran on staging, not the design doc.

| When (UTC) | What | Result |
|---|---|---|
| 2026-09-22 02:13 | First staging deploy | workers.dev subdomain `volta-signal` registered; `/slack/actions` GET was 404 until ssl_check handler |
| 2026-09-22 02:14 | Slack Request URL | Verified after GET/POST probe handlers |
| 2026-09-22 02:16 | Publish `2026-M09` | Groq rejected empty rationale + blank variant slots; parser now skips empties |
| 2026-09-22 02:16 | Slack card posted | Three variants, recommended `founder_signal` |
| 2026-09-22 02:18 | Mailchimp drafts | Campaigns 10349289 / 90 / 91 created as status `save` |
| 2026-09-22 02:39–02:41 | Send test (list send) | Campaigns `a0e9236654`, `d14ea046a0` status `sent`, 1 recipient, opened |
| 2026-09-22 03:06 | Black theme | HTML restyled; drafts refreshed |
| 2026-09-22 03:13 | Send test API | Switched to `/actions/test` targeting `ESP_REPLY_TO` |
| 2026-09-22 03:27 | Approve and send | Live campaign `dc4a31c00a` status `sent`, 1 recipient, opened ~30s later — inbox is the Mailchimp subscriber Gmail, not Slack |
| 2026-09-22 03:38 | Architecture map | `GET /architecture` — CLAUDE.md, skills, memory, logs, Worker graph (no secrets) |
| 2026-09-22 03:50 | Harness trim | Skills/rules/hooks rewritten to Cursor docs; architecture detail no longer dumps source |
| 2026-09-22 13:41 | `/volta` slash | Manual publish via Slack; no ADMIN_RUN_SECRET needed |
| 2026-09-22 14:00 | Request change | Unique action_ids per variant; modal submit reads select fields; refresh card after revision |

Sources used for `2026-M09`: Volta ICS, blog/news, events JSON-LD, AI Residency evergreen page (12 eligible items).
