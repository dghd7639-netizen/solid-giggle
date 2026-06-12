# Batch Queue Groups Design

**Date:** 2026-06-04

## Goal

让插件把“一次批量导入”视为一个独立批次队列，并保证多个批次按导入顺序串行执行。同时，当用户准备导入新提示词时，只对输入框里的旧草稿做提醒，不影响已经进入任务列表的旧任务。

## Current State

- 当前系统只有一张扁平的 `tasks` 列表，没有“批次”或“队列组”的概念。
- `importPrompts()` 会把本次导入的提示词直接追加成多个任务。
- `runNextTask()` 会在所有可执行任务里选下一个任务，不区分导入来源。
- popup 有草稿概念，但草稿和已导入任务之间没有明确边界提示。

这意味着：

- 第二次导入的任务会和第一次导入的任务混在一起；
- 调度器无法保证“第二批等第一批完成后再执行”；
- 用户不容易分清“输入框里的旧文本”和“已经导入的旧任务”。

## Requirements

### Functional

1. 一次批量导入的提示词必须形成一个独立批次。
2. 同一批次内的任务继续按现有顺序执行。
3. 后导入的批次必须等待前一批次全部完成后才开始执行。
4. 当用户准备导入新提示词时，如果输入框中还有旧草稿，需要提醒是否清空输入框。
5. 这个提醒只影响输入框草稿，不影响已经导入进任务列表的任务。
6. 新导入的提示词必须创建新的批次，而不是并入前一个未完成批次。
7. CLI 导入和 popup 导入必须遵循同一套批次规则。

### Non-Functional

1. 保持现有任务状态模型可用：`pending / waiting / running / downloading / downloaded / failed / stopped`。
2. 不重做整套 UI；第一版先把批次执行语义做稳。
3. 尽量沿用现有存储结构和调度流程，避免大范围重构。

## Recommended Approach

推荐在现有 `tasks` 模型上增加轻量批次字段，而不是单独再维护一份新的“队列表”。

### Why

- 现有逻辑几乎都围绕任务列表展开，轻量加字段改动最小。
- 调度器只需要多一层“先找当前开放批次，再找该批次下一个任务”的规则。
- 删除、重跑、清空等已有能力仍然作用于任务，不需要重写控制面。

## Alternatives Considered

### Option A: 任务加 `batchId`，调度器按批次串行

**Pros**

- 改动最集中
- 与现有 `tasks` 存储兼容
- CLI、popup、日志、状态汇总都容易渐进适配

**Cons**

- 任务列表展示层如果想明显分组，后续还需要补 UI

### Option B: 新建顶层 `batches` 结构，任务挂在批次下

**Pros**

- 模型语义更强
- 后续做分组 UI 更自然

**Cons**

- 需要重写导入、汇总、调度、删除、重跑、导出等多处逻辑
- 对当前需求来说过重

### Option C: 不加批次字段，只用时间窗口推断“上一批/下一批”

**Pros**

- 初期代码最少

**Cons**

- 非常脆弱
- 删除/重跑/恢复后批次边界会变模糊
- 不适合长期维护

## Chosen Design

采用 **Option A**。

## Data Model

### Task

在每个任务对象上新增：

- `batchId: string`  
  同一次导入的所有任务共享同一个批次 ID。

- `batchCreatedAt: number`  
  记录该批次导入时间，方便稳定排序和后续 UI 展示。

可选附加字段：

- `batchLabel: string`  
  第一版不是必须。如果后面 UI 需要显示“批次 1 / 批次 2”，可以再补。

### Runtime

第一版不强制新增 `activeBatchId`。  
调度时可以从 `tasks` 动态计算“当前最早未完成批次”，避免 runtime 状态再膨胀一层。

如果实现时发现反复扫描任务列表导致逻辑过绕，再考虑新增：

- `activeBatchId: string | null`

## Import Flow

### Popup Import

1. 用户在输入框中填写多行提示词。
2. 点击导入时，先判断输入框里是否存在旧草稿内容。
3. 如果用户此刻是在“替换输入框内容再导入”的路径下，弹出确认：
   - 清空输入框旧草稿并继续
   - 保留旧草稿并取消这次导入
4. 真正导入时，为本次导入生成一个新的 `batchId`。
5. 把本次所有提示词转成任务，并统一写入该 `batchId`。
6. 导入成功后，这一批任务追加到任务列表末尾。

注意：这里的提醒只针对输入框草稿，不删除任何已经在 `tasks` 里的项目。

### CLI Import

1. CLI 导入请求进入 `background.js`。
2. `importPrompts()` 为本次导入生成新的 `batchId`。
3. 这一批的所有任务写入同一个 `batchId`。
4. 任务追加到现有列表末尾。

CLI 不涉及 popup 输入框，因此不会出现“清空草稿提醒”。

## Scheduling Flow

### Batch Selection Rule

`runNextTask()` 改成两段筛选：

1. 先找出所有“未终结”的批次  
   批次中只要还有 `pending / waiting / running / downloading`，或者还有未处理任务，就视为未终结。

2. 选择最早导入、且尚未终结的那个批次作为当前开放批次

3. 只在这个批次内部选择下一个可执行任务

### Batch Completion Rule

当前批次只有在其全部任务都进入终结态后，才算完成。终结态包括：

- `downloaded`
- `failed`
- `stopped`
- `success`（仅在无下载路径下保留）

只有当前批次完成后，下一批次才有资格进入调度。

### Interaction With Existing Delays

- 同一批次内部仍然保留现有“下载完成后再计算下一条间隔”的规则。
- 批次切换本身不额外引入新冷却时间，直接沿用当前下一任务调度逻辑。

## Draft Warning Behavior

这部分只发生在 popup 侧。

### Trigger

当用户准备导入新的提示词，且输入框中存在旧文本草稿时触发。

### Message

文案方向：

`输入框里还有上一批未清空的提示词草稿。是否先清空输入框，再导入这批新提示词？`

### Buttons

- `清空后继续`
- `取消`

### Guardrail

这一步绝不能删除已经导入到任务列表中的任何任务。

## Delete / Retry / Clear Semantics

### Delete Task

删除单个任务只删除该任务本身，不自动删除同批其他任务。

### Retry Task

重跑任务时保留原 `batchId`，因为它仍然属于原批次。

原因：

- 这是对原任务的补救，不是新的独立导入批次。
- 否则一个旧批次中的失败重跑会错误地跑到新批次后面。

### Clear All / Clear Failed / Clear Completed

这些现有命令继续按任务维度工作，不需要改成按批次操作。  
但实现中要保证批次判断依赖真实剩余任务，而不是依赖一个可能过时的缓存批次列表。

## UI Scope

第一版 UI 不强制做显式分组容器。

保留当前平铺任务列表，只在内部加批次字段和串行调度规则。  
如果后续要增强体验，可以在任务卡片上补一个轻量标记，比如：

- `Batch 1`
- `Batch 2`

但这不属于本轮必须项。

## Testing Strategy

### Shared / Pure Logic

增加纯函数或可独立测试的辅助逻辑，覆盖：

1. 同一批导入生成统一 `batchId`
2. 第二批任务在第一批未完成时不可被调度
3. 第一批完成后，第二批成为开放批次
4. 重跑任务保留原 `batchId`

### Background Behavior

补背景逻辑测试，覆盖：

1. `importPrompts()` 追加新批次，不覆盖旧任务
2. `runNextTask()` 只从当前开放批次取任务
3. 删除某个任务后，批次完成判定仍然正确
4. 清空任务后不会残留错误的当前批次状态

### Popup Behavior

补 popup 交互测试或最小可验证逻辑，覆盖：

1. 输入框存在旧草稿时，导入前会触发确认
2. 取消后不导入
3. 确认清空后才继续导入
4. 已导入任务不会因草稿确认被删除

## Files Likely To Change

- `/Users/hanbala/Desktop/gpt生图插件/shared.js`
- `/Users/hanbala/Desktop/gpt生图插件/background.js`
- `/Users/hanbala/Desktop/gpt生图插件/popup.js`
- `/Users/hanbala/Desktop/gpt生图插件/README.md`
- `/Users/hanbala/Desktop/gpt生图插件/test/shared.test.js`
- 可能新增一个 background 相关测试文件

## Risks

1. 当前任务列表没有批次 UI，用户可能暂时只能从执行顺序而不是界面分组感知批次。
2. 如果批次完成判定漏掉某些终结态，第二批可能被错误阻塞。
3. 删除/重跑如果错误改写了 `batchId`，会破坏串行批次语义。

## Success Criteria

以下都成立时，这次改动算完成：

1. 一次导入生成一个新批次。
2. 第二次导入不会插队执行。
3. 第一批所有任务完成后，第二批自动开始。
4. popup 在导入新文本前能正确提醒清空旧草稿。
5. 草稿提醒不会删除已导入任务。
6. CLI 和 popup 导入行为一致地创建新批次。
