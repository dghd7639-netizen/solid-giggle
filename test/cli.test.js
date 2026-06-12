const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseArgs } = require("../cli");

test("parses status command", () => {
  assert.deepEqual(parseArgs(["status"]), {
    command: "status",
    payload: {}
  });
});

test("parses import prompt command", () => {
  assert.deepEqual(parseArgs(["import", "--prompt", "a calm lake at dawn"]), {
    command: "import-prompts",
    payload: {
      prompts: ["a calm lake at dawn"]
    }
  });
});

test("parses import prompt command with replace-draft policy", () => {
  assert.deepEqual(parseArgs(["import", "--prompt", "a calm lake at dawn", "--replace-draft"]), {
    command: "import-prompts",
    payload: {
      prompts: ["a calm lake at dawn"],
      draftPolicy: "replace"
    }
  });
});

test("parses import prompt command with keep-draft policy", () => {
  assert.deepEqual(parseArgs(["import", "--prompt", "a calm lake at dawn", "--keep-draft"]), {
    command: "import-prompts",
    payload: {
      prompts: ["a calm lake at dawn"],
      draftPolicy: "keep"
    }
  });
});

test("parses JSON task import file", () => {
  const file = path.join(os.tmpdir(), `gpt-image-plugin-import-${Date.now()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify([{ prompt: "a calm lake at dawn", filename: "image_custom_042" }]),
    "utf8"
  );

  try {
    assert.deepEqual(parseArgs(["import", "--file", file]), {
      command: "import-prompts",
      payload: {
        prompts: [{ prompt: "a calm lake at dawn", filename: "image_custom_042" }]
      }
    });
  } finally {
    fs.unlinkSync(file);
  }
});

test("parses delete command with task id", () => {
  assert.deepEqual(parseArgs(["delete", "--task-id", "task_123"]), {
    command: "delete-task",
    payload: {
      taskId: "task_123"
    }
  });
});

test("parses clear-all command", () => {
  assert.deepEqual(parseArgs(["clear-all"]), {
    command: "clear-all",
    payload: {}
  });
});

test("parses clear-draft command", () => {
  assert.deepEqual(parseArgs(["clear-draft"]), {
    command: "clear-draft",
    payload: {}
  });
});

test("parses clear-failed command", () => {
  assert.deepEqual(parseArgs(["clear-failed"]), {
    command: "clear-failed",
    payload: {}
  });
});

test("parses undo command", () => {
  assert.deepEqual(parseArgs(["undo"]), {
    command: "undo",
    payload: {}
  });
});

test("rejects delete without task id", () => {
  assert.throws(
    () => parseArgs(["delete"]),
    /--task-id requires a value/
  );
});

test("parses start timeouts", () => {
  assert.deepEqual(parseArgs(["start", "--timeout-total", "180", "--timeout-busy", "60"]), {
    command: "start",
    payload: {
      timeoutTotalSec: 180,
      timeoutBusySec: 60
    }
  });
});

test("allows disabling busy timeout with zero", () => {
  assert.deepEqual(parseArgs(["start", "--timeout-total", "180", "--timeout-busy", "0"]), {
    command: "start",
    payload: {
      timeoutTotalSec: 180,
      timeoutBusySec: 0
    }
  });
});

test("rejects invalid timeout", () => {
  assert.throws(
    () => parseArgs(["start", "--timeout-total", "abc"]),
    /Invalid number/
  );
});

test("parses update-settings JSON payload", () => {
  assert.deepEqual(parseArgs(["update-settings", "--json", "{\"debugMode\":true}"]), {
    command: "update-settings",
    payload: {
      settings: {
        debugMode: true
      }
    }
  });
});

test("rejects update-settings without payload", () => {
  assert.throws(
    () => parseArgs(["update-settings"]),
    /update-settings requires --json or --file/
  );
});

test("rejects update-settings array payload", () => {
  assert.throws(
    () => parseArgs(["update-settings", "--json", "[]"]),
    /must describe a JSON object/
  );
});

test("rejects import with both draft policies", () => {
  assert.throws(
    () => parseArgs(["import", "--prompt", "a calm lake at dawn", "--replace-draft", "--keep-draft"]),
    /Choose only one draft policy/
  );
});
