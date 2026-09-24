import assert from "node:assert/strict";
import { test } from "node:test";

import {
  revisionInstruction,
  slackSelectLabel,
  slackSelectValue,
  slackTextValue,
  type SlackViewValues,
} from "../src/slack.ts";

test("reads Slack modal select and text by block_id, not action_id shortcuts", () => {
  const values: SlackViewValues = {
    change_type: {
      change_type_select: { selected_option: { value: "shorter", text: { text: "Make it shorter" } } },
    },
    drop_item: {
      drop_item_select: {
        selected_option: { value: "0:src_1", text: { text: "AI Residency deadline" } },
      },
    },
    note: {
      note_input: { value: "Cut the second story" },
    },
  };

  assert.equal(slackSelectValue(values, "change_type"), "shorter");
  assert.equal(slackSelectLabel(values, "drop_item"), "AI Residency deadline");
  assert.equal(slackTextValue(values, "note"), "Cut the second story");
  // Old buggy path used action_id "value" — must not win.
  assert.equal(values.change_type?.value?.selected_option?.value, undefined);
});

test("revisionInstruction embeds change type, drop label, and note", () => {
  const text = revisionInstruction({
    changeType: "remove_item",
    note: "Keep the residency CTA",
    dropLabel: "AI Residency deadline",
    itemCount: 4,
    readingMinutes: 3,
  });
  assert.match(text, /Delete the named item/);
  assert.match(text, /AI Residency deadline/);
  assert.match(text, /Keep the residency CTA/);
  assert.match(text, /4 items/);
});
