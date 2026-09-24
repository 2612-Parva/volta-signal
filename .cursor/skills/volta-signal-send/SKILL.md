---
name: volta-signal-send
description: Explain or run Mailchimp Send test versus Approve and send. Use when the user did not get email, asks to enable live send, or clicks Slack send buttons.
paths: volta-signal/**
---

# Send

Send test and Approve and send are different paths.

- Send test goes only to the reply-to address. Subject is prefixed `[TEST]`. It does not send the list.
- Approve and send needs `LIVE_SEND_ENABLED`, a confirmation modal, and then sends the audience.
- Slack SENT means the Worker finished, not that Gmail was opened.

If they did not get it, check D1 `send_attempts`, then the Mailchimp report, then Gmail `in:anywhere`. Mask addresses.
