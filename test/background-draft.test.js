const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveImportDraftPlan } = require("../background");

test("uses imported prompts as the new draft when no existing draft is present", () => {
  assert.deepEqual(
    resolveImportDraftPlan("", ["一只小猫"], undefined),
    {
      hasConflict: false,
      requiresChoice: false,
      shouldUpdateDraft: true,
      nextDraftText: "一只小猫"
    }
  );
});

test("requires an explicit choice when the existing draft conflicts", () => {
  assert.deepEqual(
    resolveImportDraftPlan("一只小猫", ["一只小狗"], undefined),
    {
      hasConflict: true,
      requiresChoice: true,
      shouldUpdateDraft: false,
      nextDraftText: "一只小猫"
    }
  );
});

test("keeps the existing draft when keep policy is chosen", () => {
  assert.deepEqual(
    resolveImportDraftPlan("一只小猫", ["一只小狗"], "keep"),
    {
      hasConflict: true,
      requiresChoice: false,
      shouldUpdateDraft: false,
      nextDraftText: "一只小猫"
    }
  );
});

test("replaces the existing draft when replace policy is chosen", () => {
  assert.deepEqual(
    resolveImportDraftPlan("一只小猫", ["一只小狗"], "replace"),
    {
      hasConflict: true,
      requiresChoice: false,
      shouldUpdateDraft: true,
      nextDraftText: "一只小狗"
    }
  );
});
