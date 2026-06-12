function encodeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function decodeNativeMessages(buffer) {
  const messages = [];
  let offset = 0;

  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    const start = offset + 4;
    const end = start + length;

    if (buffer.length < end) {
      break;
    }

    messages.push(JSON.parse(buffer.subarray(start, end).toString("utf8")));
    offset = end;
  }

  return {
    messages,
    remainder: buffer.subarray(offset)
  };
}

module.exports = {
  decodeNativeMessages,
  encodeNativeMessage
};
