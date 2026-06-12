const assert = require("node:assert/strict");
const test = require("node:test");

const {
  prepareContentBootstrap,
  shouldTreatNodeAsNearComposer,
  isStrongToolButtonText
} = require("../content");

test("does not mark content as injected when shared helpers are missing", () => {
  const scope = {};

  const result = prepareContentBootstrap(scope);

  assert.equal(result.shouldRun, false);
  assert.equal(result.shared, null);
  assert.equal(scope.__batchImageContentInjected, undefined);
});

test("marks content as injected only after shared helpers are available", () => {
  const shared = { MESSAGE_TYPES: {}, sleep: async () => {} };
  const scope = { BatchImageShared: shared };

  const result = prepareContentBootstrap(scope);

  assert.equal(result.shouldRun, true);
  assert.equal(result.shared, shared);
  assert.equal(scope.__batchImageContentInjected, true);
});

test("skips re-initialization when content was already injected", () => {
  const shared = { MESSAGE_TYPES: {}, sleep: async () => {} };
  const scope = {
    BatchImageShared: shared,
    __batchImageContentInjected: true
  };

  const result = prepareContentBootstrap(scope);

  assert.equal(result.shouldRun, false);
  assert.equal(result.shared, shared);
});

test("treats controls in the same composer container as near the composer", () => {
  assert.equal(
    shouldTreatNodeAsNearComposer({
      nodeRect: { top: 760, bottom: 800, left: 840, right: 920 },
      composerRect: { top: 740, bottom: 820, left: 280, right: 980 },
      sharesFormContainer: true,
      sharesFooterContainer: false,
      viewportHeight: 900
    }),
    true
  );
});

test("rejects low-page controls that are far from the composer and not in the same container", () => {
  assert.equal(
    shouldTreatNodeAsNearComposer({
      nodeRect: { top: 300, bottom: 340, left: 60, right: 180 },
      composerRect: { top: 740, bottom: 820, left: 280, right: 980 },
      sharesFormContainer: false,
      sharesFooterContainer: false,
      viewportHeight: 900
    }),
    false
  );
});

test("accepts the primary ChatGPT composer when it is centered on the home page", () => {
  assert.equal(
    shouldTreatNodeAsNearComposer({
      nodeRect: { top: 289, bottom: 329, left: 492, right: 904 },
      composerRect: null,
      sharesFormContainer: false,
      sharesFooterContainer: false,
      primaryComposerInForm: true,
      viewportHeight: 655
    }),
    true
  );
});

test("keeps unrelated mid-page controls rejected without primary composer identity", () => {
  assert.equal(
    shouldTreatNodeAsNearComposer({
      nodeRect: { top: 289, bottom: 329, left: 492, right: 904 },
      composerRect: null,
      sharesFormContainer: false,
      sharesFooterContainer: false,
      primaryComposerInForm: false,
      viewportHeight: 655
    }),
    false
  );
});

test("accepts explicit tools labels for the composer toolbar", () => {
  assert.equal(isStrongToolButtonText("Tools"), true);
  assert.equal(isStrongToolButtonText("更多工具"), true);
});

test("rejects unrelated labels that merely contain the word tool", () => {
  assert.equal(isStrongToolButtonText("置顶 开源日历工具推荐"), false);
  assert.equal(isStrongToolButtonText("打开 开源日历工具推荐 的项目选项"), false);
});
