/**
 * 客户端 · HTTP 传输。
 *
 * 和 client.ts 对照着看：**发出去的 JSON 一模一样**，
 * 变的只有外面那层 HTTP 信封，以及由此带来的三个差异：
 *   · 通知不再是「静默」，而是一个 204 空响应
 *   · 批量调用省掉的是实打实的往返次数
 *   · 服务端推不动东西过来 —— 没有反向通道
 *
 * 跑法：pnpm http      （会自己把 server-http.ts 拉起来）
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as wire from "./wire.ts";
import { makeRequest, makeNotification, type Params } from "./jsonrpc.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let URL_ = "";

/** 把服务端拉起来，从它 stderr 的第一行读出系统分配的端口。 */
function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  const proc = spawn(process.execPath, ["--import", "tsx", path.join(HERE, "server-http.ts"), "0"],
    { stdio: ["ignore", "ignore", "pipe"], cwd: HERE });
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: proc.stderr!, crlfDelay: Infinity });
    const timer = setTimeout(() => reject(new Error("服务端没在 10s 内报出端口")), 10_000);
    rl.on("line", (line) => {
      if (!line.startsWith("PORT=")) return;      // 其余 stderr 行读掉即可，防止管道写满
      clearTimeout(timer);
      resolve({ proc, port: Number(line.slice(5)) });
    });
  });
}

async function post(payload: unknown, raw?: string): Promise<{ status: number; text: string }> {
  const body = raw ?? wire.compact(payload);
  wire.out(body);
  const res = await fetch(URL_, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  return { status: res.status, text: await res.text() };
}

function show(r: { status: number; text: string }): string {
  if (r.status === 204 || !r.text) wire.silence(`HTTP ${r.status}，响应体为空`);
  else wire.inp(`HTTP ${r.status}  ${r.text}`);
  return r.text;
}

async function main(): Promise<void> {
  const { proc, port } = await startServer();
  process.on("exit", () => proc.kill());          // 中途抛异常也要收尸
  URL_ = `http://127.0.0.1:${port}/`;

  console.log();
  console.log(wire.bold("  同一套协议，换个信封：JSON-RPC over HTTP · TypeScript 版"));
  console.log(wire.dim("  业务方法一行没改（都来自 methods.ts），变的只有传输层"));
  console.log(wire.dim(`  服务端监听 ${URL_}`));

  wire.scene("H1", "普通调用：HTTP 200 + 响应体", `
    请求体就是那一行 JSON，和 stdio 版完全一致。
    URL 只有一个、方法名写在报文里 —— 这是 RPC 风格，不是 REST 风格。
  `);
  show(await post(makeRequest("subtract", { minuend: 42, subtrahend: 23 }, 1)));

  wire.scene("H2", "★ 通知在 HTTP 上长什么样：204 No Content", `
    规范说「服务端 MUST NOT 回复通知」，但 HTTP 这层总得回点什么。
    正确做法是 204 + 空体。常见错误是回「200 + 空字符串」或「200 + null」，
    那会让客户端在 JSON.parse('') 上直接抛异常。
  `);
  show(await post(makeNotification("log_event", { level: "warn", message: "磁盘快满了" })));
  wire.ok("状态码 204，响应体 0 字节 —— 客户端不该去解析它。");
  wire.note("顺带：MCP 自己规定的是 202 Accepted，也是空 body。");
  wire.note("选哪个取决于你在写通用 JSON-RPC 服务还是 MCP 服务。");

  wire.scene("H3", "★ JSON-RPC 错误 ≠ HTTP 错误", `
    方法不存在，JSON-RPC 层报 -32601；但 HTTP 层这次传输是成功的，
    所以状态码是 200。别拿 404 去表达「方法不存在」，那是两层语义打架。
  `);
  show(await post(makeRequest("foo.get", { name: "myself" }, 2)));
  wire.note("HTTP 状态码描述「信送到了没」，JSON-RPC 错误码描述「事办成了没」。");

  wire.scene("H4", "解析失败也照样 200", `
    请求体不是合法 JSON → -32700，id 为 null，HTTP 仍是 200。
  `);
  show(await post(null, '{"jsonrpc": "2.0", "method": "foobar, "params": "bar", "baz]'));

  wire.scene("H5", "批量调用：HTTP 下省掉的是「往返次数」", `
    stdio 是常开管道，批量省的只是几行文本；
    HTTP 每次往返都有连接、头部、鉴权的固定开销，批量的收益要大得多。
    这也是规范 §6 存在的主要动机。
  `);
  let t0 = Date.now();
  for (let i = 0; i < 3; i++) await post(makeRequest("get_user", { id: 40 + i }, 100 + i));
  wire.note(`上面是 3 次独立 POST，耗时 ${Date.now() - t0} ms`);

  t0 = Date.now();
  const batch = [0, 1, 2].map((i) => makeRequest("get_user", { id: 40 + i }, 200 + i));
  const r = await post(batch as unknown as Params);
  const ms = Date.now() - t0;
  show(r);
  wire.ok(`一次 POST 拿回 ${JSON.parse(r.text).length} 条结果，耗时 ${ms} ms`);
  wire.note("本机回环差距还不明显；跨公网时，这就是 3 个 RTT 和 1 个 RTT 的差别。");

  wire.scene("H6", "整批都是通知 → 依然是 204", `
    规范 §6 要求此时不返回任何报文，映射到 HTTP 就是 204。
  `);
  show(await post([makeNotification("notify_hello", [7]), makeNotification("update", [1, 2])] as unknown as Params));

  wire.scene("H7", "HTTP 传输缺了什么：服务端没法主动说话", `
    同一个 long_task 方法，在 stdio 上推了 3 条进度通知；
    在这里一条也推不出来 —— 因为 HTTP 没有常开的反向通道。
  `);
  const text = show(await post(makeRequest("long_task", { steps: 3 }, 3)));
  wire.fail(`pushed_notifications = ${JSON.parse(text).result.pushed_notifications}：方法想推，但传输层递不出去。`);
  wire.note("MCP 的 Streamable HTTP 就是为了补这个缺口 ——");
  wire.note("让 POST 的响应可以是一条 SSE 流，服务端就能在同一次响应里陆续吐多帧。");

  wire.scene("H8", "GET 不是 JSON-RPC 的入口", `
    方法名和参数都在请求体里，不该摊到 URL 上。
  `);
  const g = await fetch(URL_);
  wire.inp(`HTTP ${g.status}，Allow: ${g.headers.get("allow")}`);

  console.log();
  console.log(wire.bold("━".repeat(78)));
  console.log(wire.bold("对照结论：报文层一字未改，行为完全一致；"));
  console.log(wire.bold("传输层决定的只有两件事 —— 「无响应」怎么表达，以及「能不能反向推送」。"));
  console.log();
  proc.kill();
}

await main();
process.exit(0);
