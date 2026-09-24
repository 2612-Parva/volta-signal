---
name: volta-signal-publish
description: Collect Volta sources, generate three newsletter variants, and post the Slack review card. Use when the user asks to publish, generate, gather, or post the review card.
paths: volta-signal/**
---

# Publish

Work in `volta-signal/`. Never print secrets.

Default: in Slack, an approver types `/volta publish`. That posts the review card. Send test and Approve stay on the card.

`/volta card` refreshes drafts without Groq. `/volta status` shows this month.

Do not start a second overlapping publish. Live send is the `volta-signal-send` skill.
