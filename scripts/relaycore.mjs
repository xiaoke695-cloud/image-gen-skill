#!/usr/bin/env node
// RelayCore 图片/视频命令行工具（Skill 内置脚本）
//
//   node relaycore.mjs models
//   node relaycore.mjs balance
//   node relaycore.mjs gen   --prompt "..." [--model gpt-image-2.5-sunburst] [--size 1024x1024] [--quality high] [--out out/a.png]
//   node relaycore.mjs edit  --prompt "..." --image in.png [--mask m.png] [--model ...] [--size ...] [--out out/a.png]
//   node relaycore.mjs async-gen --prompt "..." [--model ...] [--size ...] [--out out/a.png]
//   node relaycore.mjs task  --id imgtask_xxx [--out out/a.png]
//
// 任何命令都可以加 --dry-run：只打印将要发送的请求，不真正调用（不花钱）。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_BASE = "https://api.relaycore.cn/v1";
const DEFAULT_MODEL = "gpt-image-2.5-sunburst";

/* ------------------------------ 参数与鉴权 ------------------------------ */

const argv = process.argv.slice(2);
const command = argv[0];
const flags = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) flags[key] = true;
  else {
    flags[key] = next;
    i++;
  }
}

/* ------------------------------ .env 加载 ------------------------------ */
// 读取项目根目录 / 当前目录的 .env（不覆盖已存在的环境变量）
// 这样 Key 可以只放在本地 .env 里，由 .gitignore 保证永不提交
function loadDotEnv() {
  for (const file of [path.join(import.meta.dirname, "..", ".env"), path.join(process.cwd(), ".env")]) {
    if (!existsSync(file)) continue;
    for (const line of fsReadFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
    break;
  }
}
loadDotEnv();
function findKey() {
  if (process.env.RELAYCORE_API_KEY) return { key: process.env.RELAYCORE_API_KEY.trim(), from: "env RELAYCORE_API_KEY" };

  // 从脚本目录和 cwd 向上找 .relaycore/key
  for (const start of [process.cwd(), import.meta.dirname]) {
    let dir = path.resolve(start);
    for (;;) {
      const candidate = path.join(dir, ".relaycore", "key");
      if (existsSync(candidate)) return { key: readFileSyncTrim(candidate), from: candidate };
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const home = path.join(os.homedir(), ".relaycore", "key");
  if (existsSync(home)) return { key: readFileSyncTrim(home), from: home };

  fail(
    "找不到 API Key。请三选一：\n" +
      "  1) 设置环境变量 RELAYCORE_API_KEY\n" +
      "  2) 在项目根放 .relaycore/key（内容为 sk- 开头的一行）\n" +
      "  3) 放 ~/.relaycore/key",
  );
}

function readFileSyncTrim(p) {
  const raw = fsReadFileSync(p, "utf8").trim();
  if (!raw) fail(`Key 文件为空：${p}`);
  return raw;
}

import { readFileSync as fsReadFileSync } from "node:fs";

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const BASE = (process.env.RELAYCORE_BASE_URL || flags.base || DEFAULT_BASE).replace(/\/+$/, "");
const dryRun = flags["dry-run"] === true;

/* --------------------------------- 输出 --------------------------------- */

const price = (usage) => (usage && Object.keys(usage).length ? JSON.stringify(usage) : "{}");

async function saveImage(item, outFile) {
  await mkdir(path.dirname(outFile), { recursive: true });
  if (item.b64_json) {
    await writeFile(outFile, Buffer.from(item.b64_json, "base64"));
  } else if (item.url) {
    const res = await fetch(item.url);
    if (!res.ok) fail(`下载图片失败 HTTP ${res.status}`);
    await writeFile(outFile, Buffer.from(await res.arrayBuffer()));
  } else {
    fail(`响应里既没有 b64_json 也没有 url：${JSON.stringify(item).slice(0, 300)}`);
  }
}

/* --------------------------------- 请求 --------------------------------- */

async function api(pathname, { method = "GET", body, form } = {}) {
  const { key } = findKey();
  const url = `${BASE}${pathname}`;
  if (dryRun) {
    console.log(`[dry-run] ${method} ${url}`);
    console.log(`[dry-run] Authorization: Bearer ${key.slice(0, 7)}…`);
    if (body) console.log(`[dry-run] body: ${JSON.stringify(body)}`);
    if (form) console.log(`[dry-run] multipart fields: ${[...form.keys()].join(", ")}`);
    process.exit(0);
  }
  const headers = { Authorization: `Bearer ${key}` };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: form ?? (body ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(Number(flags.timeout ?? 300_000)),
  });
  const text = await res.text();
  if (!res.ok) fail(`HTTP ${res.status} ${method} ${pathname}\n${text.slice(0, 800)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function downloadTaskImage(task, outFile) {
  const item = task.result?.data?.[0] ?? task.data?.[0] ?? {};
  if (task.image_url) item.url ??= task.image_url;
  await saveImage(item, outFile);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------- 命令 --------------------------------- */

async function cmdModels() {
  const json = await api("/models");
  const ids = (json.data ?? []).map((m) => m.id);
  console.log(`共 ${ids.length} 个模型：`);
  for (const id of ids) console.log(`  ${id}`);
}

async function cmdBalance() {
  const u = await api("/usage");
  console.log(`余额：$${u.balance} ${u.unit ?? "USD"}（${u.planName ?? "-"}）`);
  console.log(`今日：${u.usage?.today?.requests ?? 0} 次请求，花费 $${Number(u.usage?.today?.actual_cost ?? 0).toFixed(4)}`);
  for (const s of u.model_stats ?? []) {
    console.log(`  ${s.model}: ${s.requests} 次，$${Number(s.actual_cost ?? 0).toFixed(4)}`);
  }
  if (Number(u.balance) < 0.05) console.log("⚠️ 余额偏低，批量生图前先充值");
}

async function cmdGen() {
  if (!flags.prompt) fail("缺少 --prompt");
  const payload = {
    model: flags.model || DEFAULT_MODEL,
    prompt: flags.prompt,
    size: flags.size || "1024x1024",
  };
  if (flags.quality) payload.quality = flags.quality;
  if (flags.n) payload.n = Number(flags.n);

  const out = path.resolve(flags.out || `out/${Date.now()}.png`);
  const json = await api("/images/generations", { method: "POST", body: payload });
  const item = json.data?.[0];
  if (!item) fail(`响应没有 data[0]：${JSON.stringify(json).slice(0, 400)}`);
  await saveImage(item, out);
  console.log(`✓ 已保存 ${out}`);
  console.log(`  模型 ${payload.model} / ${payload.size}`);
  console.log(`  用量 ${price(json.usage)}`);
}

async function cmdEdit() {
  if (!flags.prompt) fail("缺少 --prompt");
  if (!flags.image) fail("缺少 --image（源图路径）");
  const form = new FormData();
  form.set("model", flags.model || DEFAULT_MODEL);
  form.set("prompt", flags.prompt);
  if (flags.size) form.set("size", flags.size);
  if (flags.mask) form.set("mask", new Blob([await readFile(path.resolve(flags.mask))]), path.basename(flags.mask));
  form.set("image", new Blob([await readFile(path.resolve(flags.image))]), path.basename(flags.image));

  const out = path.resolve(flags.out || `out/edited-${Date.now()}.png`);
  const json = await api("/images/edits", { method: "POST", form });
  const item = json.data?.[0];
  if (!item) fail(`响应没有 data[0]：${JSON.stringify(json).slice(0, 400)}`);
  await saveImage(item, out);
  console.log(`✓ 已保存 ${out}`);
  console.log(`  用量 ${price(json.usage)}`);
}

async function cmdAsyncGen() {
  if (!flags.prompt) fail("缺少 --prompt");
  const payload = { model: flags.model || DEFAULT_MODEL, prompt: flags.prompt, size: flags.size || "1024x1024" };
  const created = await api("/images/generations/async", { method: "POST", body: payload });
  const id = created.id ?? created.task_id ?? created.data?.id;
  if (!id) fail(`没拿到任务 id：${JSON.stringify(created).slice(0, 300)}`);
  console.log(`任务已提交：${id}（status=${created.status ?? "?"}）`);
  await pollTask(id, flags.out);
}

async function cmdTask() {
  if (!flags.id) fail("缺少 --id");
  await pollTask(flags.id, flags.out);
}

async function pollTask(id, out) {
  for (let i = 0; i < 200; i++) {
    await sleep(3000);
    const t = await api(`/images/tasks/${id}`);
    const status = String(t.status ?? t.data?.status ?? "").toLowerCase();
    const progress = t.progress ?? t.data?.progress;
    console.log(`[${i + 1}] status=${status || "?"} progress=${progress ?? "-"}`);
    if (["completed", "complete", "done", "success", "succeeded"].includes(status)) {
      const file = path.resolve(out || `out/${id}.png`);
      await downloadTaskImage(t, file);
      console.log(`✓ 已保存 ${file}`);
      return;
    }
    if (["failed", "failure", "error", "expired", "cancelled", "canceled"].includes(status)) {
      fail(`任务失败：${t.error?.message ?? t.data?.error?.message ?? JSON.stringify(t).slice(0, 300)}`);
    }
  }
  fail("轮询超时（10 分钟）。任务可能仍在跑，用同一把 Key 执行 task --id " + id);
}

/* -------------------------------- 入口 -------------------------------- */

const commands = { models: cmdModels, balance: cmdBalance, gen: cmdGen, edit: cmdEdit, "async-gen": cmdAsyncGen, task: cmdTask };
if (!command || !commands[command]) {
  console.log("用法：node relaycore.mjs <models|balance|gen|edit|async-gen|task> [--prompt ...]");
  process.exit(command ? 1 : 0);
}
await commands[command]();
