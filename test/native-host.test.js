const assert = require("node:assert/strict");
const test = require("node:test");

const { decodeNativeMessages, encodeNativeMessage } = require("../native-host/protocol");

test("encodes a native message with a little-endian length header", () => {
  const buffer = encodeNativeMessage({ ok: true });

  assert.equal(buffer.readUInt32LE(0), Buffer.byteLength(JSON.stringify({ ok: true })));
  assert.deepEqual(JSON.parse(buffer.subarray(4).toString("utf8")), { ok: true });
});

test("decodes one complete native message and returns no remainder", () => {
  const buffer = encodeNativeMessage({ id: "1", command: "status" });
  const result = decodeNativeMessages(buffer);

  assert.deepEqual(result.messages, [{ id: "1", command: "status" }]);
  assert.equal(result.remainder.length, 0);
});

test("keeps an incomplete native message as remainder", () => {
  const buffer = encodeNativeMessage({ id: "2", command: "pause" });
  const partial = buffer.subarray(0, buffer.length - 2);
  const result = decodeNativeMessages(partial);

  assert.deepEqual(result.messages, []);
  assert.equal(result.remainder.length, partial.length);
});
