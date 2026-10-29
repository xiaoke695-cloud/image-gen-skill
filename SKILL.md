---
name: relaycore-image
description: "用 RelayCore 网关生成或编辑图片（OpenAI Images 兼容）：文生图、图片编辑、异步长任务、查余额与模型。模型涵盖 gpt-image-2 / 2.5 / sunburst、nano-banana、gemini 生图、grok-imagine。当用户要生图、画图、出图、做配图、改图、换背景、批量出图，或提到 RelayCore / relaycore.cn / gpt-image / nano-banana 时使用。该网关不支持聊天模型。"
---

# RelayCore 生图

把「一句话需求」变成磁盘上的一张图：调 `POST {BASE}/images/generations`，处理 `data[0].url` 或 `data[0].b64_json`，落盘，再把图给用户看。

## 0. 硬事实（别猜）

| 项 | 值 |
| --- | --- |
| Base URL | `https://api.relaycore.cn/v1` |
| 鉴权 | `Authorization: Bearer <key>` |
| Key 位置 | ① 环境变量 `RELAYCORE_API_KEY` ② 从当前目录向上找 `.relaycore/key` ③ `~/.relaycore/key`（已配好） |
| 安装位置 | 全局：`D:\dsh_data\skills\relaycore-image`（所有工作区可见）；项目里 `E:\dsh1\.agents\skills\relaycore-image` 是指向它的目录联接 |
| 端点 | `GET /models`、`GET /usage`、`POST /images/generations`、`POST /images/edits`、`POST /images/generations/async`、`GET /images/tasks/{id}` |
| 不支持 | `/chat/completions`、`/responses`——这个 Key 没有聊天模型 |
| 单张耗时 | 30–60 秒（同步接口），客户端超时 ≥ 300 秒 |

## 1. 标准流程

```powershell
cd D:\dsh_data\skills\relaycore-image

node scripts\relaycore.mjs balance                     # ① 先看余额，< $0.05 就别批量跑
node scripts\relaycore.mjs gen --prompt "..." --model gpt-image-2.5-sunburst --size 1024x1024 --out out\x.png   # ② 出图
```

③ 用 `read_image` 打开产物，确认不是空白/糊图/文字错乱，再交给用户。
④ 汇报三件事：**保存路径、用的模型、这次花费**（`balance` 前后差值，或 `usage` 里的 token 数）。

批量（>3 张）前先跟用户确认数量和预算；一张 1k 图约 **$0.05–0.10**。

产物默认落在**当前工作目录**的 `out/` 下；要放到用户项目里，用 `--out` 指定绝对路径或相对路径。

## 2. 命令速查

在 skill 目录下执行（或写全 `node <skill>\scripts\relaycore.mjs`）：

| 目的 | 命令 |
| --- | --- |
| 列模型 | `node scripts\relaycore.mjs models` |
| 查余额/今日花费 | `node scripts\relaycore.mjs balance` |
| 文生图 | `node scripts\relaycore.mjs gen --prompt "..." [--model M] [--size 1024x1024] [--quality high] [--out out\a.png]` |
| 改图/换背景 | `node scripts\relaycore.mjs edit --prompt "..." --image in.png [--mask m.png] [--out out\b.png]` |
| 异步生图（长任务） | `node scripts\relaycore.mjs async-gen --prompt "..." [--out out\c.png]`，再 `node scripts\relaycore.mjs task --id imgtask_xxx` |
| 只想看请求不花钱 | 任何命令加 `--dry-run` |

脚本只用 Node 原生 `fetch`/`FormData`，无依赖；Node ≥ 18。

## 3. 选模型

本 Key 的 18 个模型（`models` 输出为准，会变）：

- **便宜快**：`gpt-image-2.5-sunburst`（实测 $0.055/张）、`gpt-image-1k-th`、`nano-banana2-1k`
- **质量/文字**：`gpt-image-2`、`gpt-image-2.5`、`gpt-image-2.5-flare`、`gemini-3-pro-image-preview`
- **高清/大图**：`nano-banana-pro-2k` / `-4k`、`nano-banana2-2k` / `-4k`、`gpt-image-2-exact`
- **风格化**：`grok-imagine-image-quality`、`grok-imagine-image-2.0`
- 视频模型（`grok-imagine-video*`）不在本 skill 范围，走 `relaycore-video` 思路或单独脚本

没指定模型时默认 `gpt-image-2.5-sunburst`；用户要「更精细/带文字」就换 `gpt-image-2`；要 2K/4K 换 `nano-banana*`。

## 4. 提示词写法

一句中文需求 → 结构化英文 prompt 效果好得多：

`主体 + 动作/构图 + 环境 + 光线 + 镜头/材质 + 风格`

> 例：「小狗」→ `A fluffy cream-colored puppy sitting on a soft knit blanket, warm morning window light, shallow depth of field, 50mm photo, high detail`

- 要文字：明确写 `with the text "XXX"`，gpt-image 系列最稳
- 要透明底/去背景：先用 `gen` 出图，再 `edit` 换背景更可控
- 尺寸：`1024x1024`（头像/方图）、`1536x1024`（横版）、`1024x1536`（竖版）；不确定就用 1024×1024

## 5. 出问题怎么查

| 现象 | 处理 |
| --- | --- |
| `401` | Key 错/被禁用；确认是 `Bearer` + 正确域名 |
| `403` | Key 所属分组没开图片生成 |
| `404 page not found` | 路径少了 `/v1` |
| `404 async image tasks are not enabled` | 站点没启用异步，改用同步 `gen` |
| `400` invalid_request | 模型名不在 `/models` 里、size 不被该模型支持、prompt 为空 |
| `429` | 按 `Retry-After` 重试；不要并发猛打 |
| `5xx` | 同请求最多重试 2 次，别改路径 |
| 请求 30s 就断 | 客户端超时太短，设 ≥ 300s，或改用 `async-gen` |
| 返回有 `url` 也有 `b64_json` | 脚本已兼容两种，别只读一种 |

## 6. 安全

- Key 只读环境变量或 `.relaycore/key`，**不要**打印完整 Key、不要写进 prompt/前端/公开仓库
- 生成内容涉及真人、商标、敏感题材时先跟用户确认合规
- 交付前用 `read_image` 验图，别把失败响应当图片交给用户
