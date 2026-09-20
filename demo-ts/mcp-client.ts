/**
 * 迷你 MCP Client —— 扮演 AI Agent 那一端，把 MCP 的一生走一遍。
 *
 * 跑法：pnpm mcp      （或 npx tsx mcp-client.ts）
 *
 * 看完这一场你会明白一件事：
 *     MCP 不是一个「新协议」，它是 JSON-RPC 2.0 加上一份方法命名表和几条加严规定。
 *     你在 client.ts 里学的每一条，在这里原封不动地用。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as wire from "./wire.ts";
import {
  ResponseRouter, Slot, makeRequest, makeNotification, makeResult, makeError,
  METHOD_NOT_FOUND, type Params, type ResponseObject,
} from "./jsonrpc.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "mcp-server.ts");

class McpPeer {
  readonly router = new ResponseRouter();
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly frames: string[] = [];
  private waiters: Array<(l: string | null) => void> = [];

  constructor() {
    this.proc = spawn(process.execPath, ["--import", "tsx", SERVER], { stdio: ["pipe", "pipe", "pipe"], cwd: HERE });
    readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity })
      .on("line", (raw) => {
        const line = raw.trim();
        if (!line) return;
        this.push(line);
        let payload: unknown;
        try { payload = JSON.parse(line); } catch { return; }   // 对端吐了非 JSON，丢掉就好，读循环不能死
        // 一帧可能是批量（场景 M7 会收到一个数组），逐个元素看
        for (const obj of Array.isArray(payload) ? payload : [payload]) {
          if (typeof obj !== "object" || obj === null) continue;
          if ("method" in obj) continue;                        // 服务端主动发来的，交给剧本按顺序处理
          this.router.resolve(obj as ResponseObject);
        }
      })
      .on("close", () => { this.router.failAll("对端已关闭管道"); this.push(null); });
    readline.createInterface({ input: this.proc.stderr, crlfDelay: Infinity }).on("line", () => {});
  }

  private push(line: string | null): void {
    const w = this.waiters.shift();
    if (w) { w(line); return; }
    if (line !== null) this.frames.push(line);
  }

  /** ★ 服务端主动发来的请求，客户端有义务回一个响应 —— 两端在协议上完全对等。 */
  handleServerRequest(req: any): void {
    if (req.method === "sampling/createMessage" && req.id !== undefined) {
      // 真实场景这里会去调大模型。demo 里假装调了一下。
      const fake = "（模拟模型输出）这段话讲的是 JSON-RPC 如何成为 MCP 的地基。";
      this.send(makeResult(req.id, {
        role: "assistant", content: { type: "text", text: fake },
        model: "fake-model-1", stopReason: "endTurn",
      }));
      return;
    }
    if (req.id !== undefined) this.send(makeError(req.id, METHOD_NOT_FOUND, undefined, { method: req.method }));
  }

  send(frame: unknown, show = true): void {
    const line = wire.compact(frame);
    if (show) wire.out(line);
    this.proc.stdin.write(line + "\n");
  }

  call(method: string, params?: Params): Slot {
    const id = this.router.newId();
    const slot = this.router.register(id);
    this.send(makeRequest(method, params, id));
    return slot;
  }

  notify(method: string, params?: Params): void { this.send(makeNotification(method, params)); }

  nextFrame(timeoutMs = 5000): Promise<string | null> {
    const q = this.frames.shift();
    if (q !== undefined) return Promise.resolve(q);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== onLine); resolve(null); }, timeoutMs);
      const onLine = (l: string | null) => { clearTimeout(timer); resolve(l); };
      this.waiters.push(onLine);
    });
  }

  /** 打印途中所有反向流量，直到拿到一条真正的响应。 */
  async drainUntilResponse(timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const line = await this.nextFrame(timeoutMs);
      if (line === null) return;
      const obj = JSON.parse(line);
      if ("method" in obj) { wire.push(line); this.handleServerRequest(obj); continue; }
      wire.inp(line);
      return;
    }
  }

  close(): void { this.proc.stdin.end(); this.proc.kill(); }
}

async function main(): Promise<void> {
  console.log();
  console.log(wire.bold("  迷你 MCP：一套 JSON-RPC 方法名约定而已 · TypeScript 版"));
  console.log(wire.dim("  传输 = stdio 换行分隔 JSON（与 MCP 官方 stdio 传输相同）"));
  console.log(wire.dim("  本场演的是 Legacy 形态（2024-11-05 ~ 2025-11-25 那一代，有握手）"));

  const peer = new McpPeer();
  process.on("exit", () => peer.close());
  await new Promise((r) => setTimeout(r, 600));

  wire.scene("M0", "握手之前什么都不能干", `
    规范里这是 SHOULD 级（客户端在握手完成前 SHOULD NOT 发别的请求），
    本 demo 收严成硬性，好让状态机看得见。
  `);
  peer.call("tools/list");
  wire.inp((await peer.nextFrame())!);

  wire.scene("M1", "握手三步：initialize → result → initialized 通知", `
    注意第三步是**通知**（没有 id），所以服务端一个字都不许回。
    这三帧全都是标准 JSON-RPC 报文，没有任何「MCP 专用语法」。
  `);
  const s = peer.call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {}, sampling: {} },      // 客户端声明：我能帮你跑模型
    clientInfo: { name: "MiniAgent", version: "1.0.0" },
  });
  wire.inp((await peer.nextFrame())!);
  const info = (await s.result()) as any;
  wire.ok(`版本协商结果：${info.protocolVersion}；服务端是 ${info.serverInfo.name}`);

  peer.notify("notifications/initialized");
  const after = await peer.nextFrame(800);
  if (after === null) wire.silence("正确：通知不得有响应");
  else { wire.inp(after); wire.fail("不合规！通知不该有响应"); }
  wire.note('对照：你项目 .venv 里的 claude_agent_sdk 在这里回了 {"jsonrpc":"2.0","result":{}}，');
  wire.note("既违反「通知不得回复」，响应里还缺了必填的 id。详见 ../04-原文勘误.md 第五节。");

  wire.scene("M2", "tools/list：服务端自报家门", `
    inputSchema 就是一份普通的 JSON Schema。
    Agent 拿到它之后，才知道该怎么给这个工具填参数。
  `);
  const sl = peer.call("tools/list");
  wire.inp((await peer.nextFrame())!, 180);
  for (const t of ((await sl.result()) as any).tools) wire.note(`${t.name.padEnd(16)} ${t.description}`);

  wire.scene("M3", "tools/call：一次正常调用", "");
  const s3 = peer.call("tools/call", { name: "get_weather", arguments: { city: "北京" } });
  wire.inp((await peer.nextFrame())!);
  const r3 = (await s3.result()) as any;
  wire.ok(`isError=${r3.isError}，内容：${r3.content[0].text}`);

  wire.scene("M4", "★ MCP 最重要的一条设计：两类失败走两条路", `
    ① 协议级错误  → 标准 JSON-RPC error 对象
       用于「模型多半修不了」的问题：工具不存在、请求结构不合 schema。
    ② 工具执行错误 → 正常的 result，带 isError: true
       用于「模型看了能自己改参数重试」的问题：除零、查不到、外部 API 挂了。
  `);
  wire.note("① 调一个不存在的工具 —— 走 JSON-RPC error：");
  peer.call("tools/call", { name: "no_such_tool", arguments: {} });
  wire.inp((await peer.nextFrame())!);

  wire.note("② 除数为 0 —— 注意它回的是 result，不是 error：");
  const s4 = peer.call("tools/call", { name: "divide", arguments: { a: 1, b: 0 } });
  wire.inp((await peer.nextFrame())!);
  const r4 = (await s4.result()) as any;
  wire.ok(`JSON-RPC 层成功（有 result），业务层失败（isError=${r4.isError}）`);
  wire.note("工程后果：客户端必须写**两段**判断 ——");
  wire.note("  先看有没有 error 成员（协议级），再看 result.isError（工具级）。");
  wire.note("只检查 error 分支的客户端，会把工具失败当成功，然后把错误文本当答案喂给模型。");

  wire.note("③ 参数形状不对（city 不是字符串）—— 又回到协议级：");
  peer.call("tools/call", { name: "get_weather", arguments: { city: 123 } });
  wire.inp((await peer.nextFrame())!);
  wire.note("这条线规范自己也划了两版才划清：2025-06-18 把 Invalid arguments 列在协议错误，");
  wire.note("2025-11-25（SEP-1303）才澄清「输入校验错误」应归工具执行错误，好让模型自纠。");

  wire.scene("M5", "★ Legacy 做法：服务端反过来请求客户端（sampling）", `
    服务端自己没有大模型 API Key，于是它反过来请求客户端：
    「拿你的模型跑一下这段 prompt」。

    看下面的帧：一次 tools/call 还没返回，服务端就先发来了一个带 id 的请求，
    客户端回答之后，服务端才把 tools/call 的结果给出来。
    请求和响应在管道上交错穿行 —— 这就是 JSON-RPC 双向对等的实际用法。
  `);
  const s5 = peer.call("tools/call", { name: "summarize", arguments: { text: "JSON-RPC 是 MCP 的传输层基础。" } });
  await peer.drainUntilResponse();
  wire.ok(((await s5.result()) as any).content[0].text);

  wire.scene("M6", "★ Modern 做法：MRTR —— 同一件事，不再反向发请求", `
    2026-07-28 把 MCP 改成了无状态协议，并明文规定服务端不发起请求。
    于是「我需要客户端帮个忙」不再是一次反向调用，而是一个特殊的 result：
        resultType: "input_required" + inputRequests + requestState

    注意 inputRequests / inputResponses 是 map（对象）不是数组，
    键是服务端自起的标识符，值直接就是请求本体 / 客户端的 result。
  `);
  const s6 = peer.call("tools/call", { name: "summarize_mrtr", arguments: { text: "JSON-RPC 是 MCP 的传输层基础。" } });
  wire.inp((await peer.nextFrame())!);
  const first = (await s6.result()) as any;
  wire.ok(`第一轮 resultType=${first.resultType} —— 这不是错误，是「我还缺东西」`);
  wire.note(`服务端要的是：${first.inputRequests.ir1.method}（键名 ir1 由服务端自己起）`);
  wire.note(`它还给了一个不透明句柄 requestState=${first.requestState}，让客户端替它保管状态。`);

  const s6b = peer.call("tools/call", {
    name: "summarize_mrtr",
    arguments: { text: "JSON-RPC 是 MCP 的传输层基础。" },
    inputResponses: { ir1: { role: "assistant", content: { type: "text", text: "（模拟模型输出）这段话讲的是 JSON-RPC 如何成为 MCP 的地基。" } } },
    requestState: first.requestState,
  });
  wire.inp((await peer.nextFrame())!);
  wire.ok(((await s6b.result()) as any).content[0].text);
  wire.note("对比 M5：管道上再没有出现过「服务端 → 客户端的请求」这种帧。");

  wire.note("顺带验一下句柄真的会被校验（这是无状态设计的命门）：");
  peer.call("tools/call", {
    name: "summarize_mrtr", arguments: { text: "x" },
    inputResponses: { ir1: { content: { type: "text", text: "伪造" } } },
    requestState: "我瞎编的句柄",
  });
  wire.inp((await peer.nextFrame())!);
  wire.ok("被拒了。「不透明」指客户端看不懂，不是服务端不用看。");

  wire.scene("M7", "MCP 对 JSON-RPC 做的三条「减法」", `
    MCP 用了 JSON-RPC，但不是全部的 JSON-RPC。它砍掉了三样东西：
  `);
  wire.note("① 删批量：2025-03-26 还要求必须支持接收 batch，2025-06-18 整条移除，至今未恢复。");
  peer.send([makeRequest("tools/list", {}, 900), makeRequest("tools/list", {}, 901)]);
  const bl = await peer.nextFrame(2000);
  if (bl) wire.inp(bl, 150); else wire.silence();
  wire.note("   本 demo 的协议层是按纯 JSON-RPC 写的，所以它照样处理了 ——");
  wire.note("   但真正的 MCP server 不会接受这一帧。照着 JSON-RPC 规范写 MCP，这里必踩空。");
  wire.note("② 禁 null id：JSON-RPC 允许 id 为 null，MCP 明文「the ID MUST NOT be null」。");
  wire.note("③ 只用具名参数：JSON-RPC 的 params 可以是数组，MCP 的 params 恒为对象。");

  console.log();
  console.log(wire.bold("━".repeat(78)));
  console.log(wire.bold("结论：把 JSON-RPC 的四件套吃透，MCP 就只剩下「查文档看方法名」这点事了。"));
  console.log(wire.dim("现行版本 2026-07-28 的完整差异见 ../03-MCP传输层.md。"));
  console.log();
  peer.close();
}

await main();
process.exit(0);
