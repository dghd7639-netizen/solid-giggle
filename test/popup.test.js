const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDraftReplaceMessage,
  shouldConfirmDraftReplacement
} = require("../popup");

test("requires confirmation when replacing a non-empty draft with different prompts", () => {
  assert.equal(shouldConfirmDraftReplacement("一只小猫", "一只小狗"), true);
});

test("does not require confirmation when the draft is empty", () => {
  assert.equal(shouldConfirmDraftReplacement("   ", "一只小狗"), false);
});

test("does not require confirmation when normalized prompt text is unchanged", () => {
  assert.equal(
    shouldConfirmDraftReplacement("一只小猫\n\n一只小狗", " 一只小猫 \n一只小狗 "),
    false
  );
});

test("draft replace message clarifies only the draft is affected", () => {
  const message = buildDraftReplaceMessage();

  assert.match(message, /草稿/);
  assert.match(message, /不会影响.*队列/i);
});
