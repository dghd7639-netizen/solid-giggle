# ChatGPT Batch Image Generator

一个基于 Chrome Manifest V3 的 ChatGPT 网页端批量生图插件。

## 已实现能力

- popup 多行输入导入 prompt
- txt / csv 文件导入
- 后台任务队列与串行执行
- 每次批量导入会形成一个独立批次队列
- 后导入的批次会等待前一批次全部完成后再执行
- 固定间隔 / 随机间隔
- 图片检测
- 自动下载到浏览器下载目录下的指定子目录
- 仅在图片下载完成后才开始计算下一条任务的间隔
- 失败重试
- 失败或手动重跑时保持原始序号文件名
- 暂停 / 继续 / 停止
- 日志记录
- 本地 CLI 控制入口，可由 Codex 调用插件执行导入、启动、暂停、继续、停止和状态查询
- CLI 也可清空 popup 草稿、更新插件设置，并配合撤回恢复这些本地操作
- CLI 导入新提示词时可显式选择保留还是替换 popup 输入框里的旧草稿
- 默认 5 分钟总超时自动暂停，2 小时后自动恢复到下一条待处理任务
- CLI 启动时也可额外设置总耗时 / 页面持续生成中超时
- 文件导入在替换输入框里的旧提示词草稿前会先确认，不影响已入队任务

## 文件结构

- `manifest.json`: 扩展清单
- `background.js`: 队列调度、存储、下载、日志
- `content.js`: ChatGPT 页面自动化与图片检测
- `popup.html` / `popup.css` / `popup.js`: 控制面板
- `shared.js`: 共享常量与工具方法
- `cli.js`: 本地命令行入口
- `native-host/`: Chrome Native Messaging host 与安装脚本

## 使用方式

1. 打开 Chrome 扩展管理页 `chrome://extensions/`
2. 启用开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择当前目录
5. 打开并登录 ChatGPT 网页端
6. 在插件 popup 中导入 prompt，配置参数后开始执行

导入规则补充：

- popup 文本框仍然按“每个非空行 = 一条提示词”解析
- 每次点击导入或通过文件导入的一批提示词，会形成一个独立批次
- 后导入的批次会等待前一批次全部完成后再开始执行
- 通过文件导入新提示词时，如果输入框里还有不同的旧草稿，会先提示确认；确认只影响输入框草稿，不会删除已经加入队列的任务

## CLI 使用方式

CLI 适合让 Codex 在本机直接控制已加载的扩展。前提：

1. Chrome 已打开
2. ChatGPT 网页端已登录
3. 当前扩展已作为已解压扩展加载
4. 已安装 Native Messaging host

先在 `chrome://extensions/` 打开当前扩展详情，复制扩展 ID，然后运行：

```bash
node native-host/install.js --extension-id <扩展ID>
```

重新加载扩展后，可以运行：

```bash
node cli.js status
node cli.js import --prompt "一只未来感玻璃猫坐在月球温室里"
node cli.js import --prompt "一只未来感玻璃猫坐在月球温室里" --replace-draft
node cli.js import --prompt "一只未来感玻璃猫坐在月球温室里" --keep-draft
node cli.js import --file prompts.txt
node cli.js import --file prompts.txt --replace-draft
node cli.js import --file prompts.txt --keep-draft
node cli.js start
node cli.js start --timeout-total 300
node cli.js start --timeout-total 300 --timeout-busy 90
node cli.js delete --task-id task_123
node cli.js clear-completed
node cli.js clear-failed
node cli.js clear-all
node cli.js clear-logs
node cli.js clear-draft
node cli.js undo
node cli.js update-settings --json '{"debugMode":true}'
node cli.js pause
node cli.js resume
node cli.js stop
```

`start` 默认会使用 300 秒总超时。超时后会停止当前生成、暂停队列，并在 2 小时后自动恢复到下一条待处理任务。`--timeout-total` 可以覆盖总超时秒数；`--timeout-busy` 仍可额外监控页面连续处于生成中的时长。

任务管理命令说明：

- `delete --task-id ...`: 删除指定任务
- `clear-completed`: 清空已完成任务
- `clear-failed`: 清空失败任务
- `clear-all`: 清空整个队列
- `clear-logs`: 清空日志
- `clear-draft`: 清空 popup 输入框草稿
- `undo`: 撤回上一步本地插件操作
- `update-settings --json ...`: 通过 CLI 更新设置，并创建可撤回快照

草稿处理说明：

- `status` 会返回 popup 输入框草稿状态，方便 Codex 在导入前先检查
- 如果 popup 输入框里已有不同的旧提示词草稿，CLI 导入必须显式选择：
  - `--replace-draft`: 用这次导入的提示词替换输入框草稿，同时加入队列
  - `--keep-draft`: 保留输入框里的旧草稿，只把新提示词加入队列
- 如果存在冲突草稿但没有带这两个参数之一，CLI 会直接报错，避免误覆盖

## 说明

- 当前实现只适配 ChatGPT 网页端，不包含视频和 Sora。
- ChatGPT 页面 DOM 可能调整，因此 `content.js` 中选择器使用了多候选和容错策略；若页面结构变动较大，后续可能需要微调选择器。
