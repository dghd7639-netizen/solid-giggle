---
name: gpt-image-plugin
description: Control the local ChatGPT image-generation extension when the user invokes @gpt生图插件. Import prompts only from an explicit prompt block, treat each non-empty line as one prompt, wait for confirmation before starting generation, and handle queue-management requests like status, delete, and clear actions through the local CLI.
---

# gpt生图插件

## When to use

Use this skill when the user invokes `@gpt生图插件` or clearly asks to use the local image-generation plugin in this workspace.

This skill controls the existing local pipeline at:

- `/Users/hanbala/Desktop/gpt生图插件/cli.js`
- Chrome extension + native host already wired to that CLI

## Supported requests

This skill supports two families of actions:

1. Prompt import and generation control
2. Queue management and cleanup

For queue management, map natural-language requests to the local CLI:

- `查看状态` / `队列状态` / `现在跑到哪了` -> `node /Users/hanbala/Desktop/gpt生图插件/cli.js status`
- `暂停` -> `node /Users/hanbala/Desktop/gpt生图插件/cli.js pause`
- `继续` / `恢复` -> `node /Users/hanbala/Desktop/gpt生图插件/cli.js resume`
- `停止` -> `node /Users/hanbala/Desktop/gpt生图插件/cli.js stop`
- `撤回` / `撤回上一步` -> `node /Users/hanbala/Desktop/gpt生图插件/cli.js undo`
- `清空草稿` -> `node /Users/hanbala/Desktop/gpt生图插件/cli.js clear-draft`
- `清空队列` -> `node /Users/hanbala/Desktop/gpt生图插件/cli.js clear-all`
- `清空失败任务` -> `node /Users/hanbala/Desktop/gpt生图插件/cli.js clear-failed`
- `清空已完成任务` -> `node /Users/hanbala/Desktop/gpt生图插件/cli.js clear-completed`
- `清空日志` -> `node /Users/hanbala/Desktop/gpt生图插件/cli.js clear-logs`
- `修改设置` / `更新设置` -> `node /Users/hanbala/Desktop/gpt生图插件/cli.js update-settings --json '{...}'`

If the user asks to delete a specific task:

- First inspect queue state with `status`
- Resolve the target by explicit task id, exact filename, or the current displayed order if the user says things like `删除第 3 条`
- Then call `node /Users/hanbala/Desktop/gpt生图插件/cli.js delete --task-id "<resolved-id>"`
- If the target is ambiguous, ask a short clarifying question instead of guessing

## Prompt parsing rules

Only import prompts from an explicit prompt section. Never guess prompts from surrounding prose.

Accepted prompt section formats:

1. A `提示词：` line followed by one prompt per non-empty line.
2. A fenced code block tagged `prompts`, with one prompt per non-empty line.

Everything outside the prompt section is instruction text, not prompt content.

Examples:

```text
@gpt生图插件
提示词：
一只小猫
一只小狗
```

~~~text
@gpt生图插件
```prompts
一只小猫
一只小狗
```
~~~

## Required workflow

1. Extract prompts only from the explicit prompt section.
2. Keep one non-empty line as one prompt. Do not split a single line into multiple prompts.
3. Import prompts through the local CLI with repeated `--prompt` flags:

```bash
node /Users/hanbala/Desktop/gpt生图插件/cli.js import --prompt "一只小猫" --prompt "一只小狗"
```

4. Before importing, inspect the popup draft through `status`.
5. If `status.draft.hasPrompt` is `true` and `status.draft.promptText` is different from the new prompt block, do not import yet. Ask the user whether to:
   - `清空旧草稿` -> re-run import with `--replace-draft`
   - `保留旧草稿` -> re-run import with `--keep-draft`
6. If there is no conflicting popup draft, import normally. When importing from Codex after the user chooses:

```bash
node /Users/hanbala/Desktop/gpt生图插件/cli.js import --prompt "一只小猫" --prompt "一只小狗" --replace-draft
node /Users/hanbala/Desktop/gpt生图插件/cli.js import --prompt "一只小猫" --prompt "一只小狗" --keep-draft
```

7. After import, report the imported prompts back to the user and ask for confirmation.
8. Do not start generation until the user explicitly confirms with language such as `开始`, `执行`, `开始生成`, or equivalent.
9. Once confirmed, start the queue with:

```bash
node /Users/hanbala/Desktop/gpt生图插件/cli.js start --timeout-total 300
```

10. When the user asks for progress, use:

```bash
node /Users/hanbala/Desktop/gpt生图插件/cli.js status
```

11. When the user asks to pause or stop, use:

```bash
node /Users/hanbala/Desktop/gpt生图插件/cli.js pause
node /Users/hanbala/Desktop/gpt生图插件/cli.js stop
```

12. When the user asks for queue cleanup or deletion, use:

```bash
node /Users/hanbala/Desktop/gpt生图插件/cli.js clear-completed
node /Users/hanbala/Desktop/gpt生图插件/cli.js clear-failed
node /Users/hanbala/Desktop/gpt生图插件/cli.js clear-all
node /Users/hanbala/Desktop/gpt生图插件/cli.js clear-logs
node /Users/hanbala/Desktop/gpt生图插件/cli.js delete --task-id "task_123"
```

## Guardrails

- If no valid prompt section exists, do not import anything. Tell the user to provide a `提示词：` block or a `prompts` fenced block.
- If the extracted prompt list is empty after trimming blank lines, do not call the CLI.
- Preserve the prompt text exactly after trimming leading and trailing whitespace.
- Do not auto-confirm on the user's behalf.
- Popup draft replacement only affects the popup input text, never already queued tasks.
- After each prompt is sent, wait until image detection succeeds and downloads finish before the interval for the next task starts.
- Keep the original numbered filename when a task is retried.
- Default timeout behavior is a `300` second total runtime limit. If that limit is hit, pause the queue, wait `2` hours, then resume automatically with the next waiting task unless the user gives different thresholds.

## Response expectations

- After import, reply in Chinese with a short confirmation like:
  `已导入 2 条提示词：一只小猫；一只小狗。回复“开始”后执行。`
- If a conflicting popup draft exists, reply in Chinese with a short choice prompt like:
  `检测到输入框里还有旧提示词草稿。要清空旧草稿并导入新提示词，还是保留旧草稿只导入队列？`
- After start, give a short status update and keep monitoring as needed.
