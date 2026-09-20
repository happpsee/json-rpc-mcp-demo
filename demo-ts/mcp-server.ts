/**
 * 迷你 MCP Server —— 在 jsonrpc.ts 这套协议层之上，只加了「方法名的约定」。
 *
 * 看清楚：这个文件没有 import 任何 MCP 库，也没写一行新的协议代码。
 * 所谓 MCP，在传输这一层就是「一套约定好名字的 JSON-RPC 方法」而已：
 *
 *     initialize                 握手，交换协议版本与能力
 *     notifications/initialized  客户端宣布握手完成（通知，无回复）
 *     tools/list                 我这有哪些工具
 *     tools/call                 调用其中一个
 *     sampling/createMessage     ← 方向相反：服务端反过来请求客户端
 *
 * 传输仍是 stdio 上的换行分隔 JSON，与 MCP 官方 stdio 传输相同。
 * 本 demo 演的是 Legacy 形态（2024-11-05 ~ 2025-11-25 那一代，有握手），
 * 并用最后一个工具对照演示 Modern（2026-07-28）的 MRTR。
 */

import * as readline from "node:readline";
import {
  Dispatcher, JsonRpcError, ResponseRouter,
  INVALID_PARAMS, INTERNAL_ERROR, PARSE_ERROR,
  makeRequest, makeError, dumps,
  type JsonId, type ResponseObject,
} from "./jsonrpc.ts";

const PROTOCOL_VERSION = "2025-06-18";
const MRTR_STATE = "opaque-state-token-7f3a";

const rpc = new Dispatcher();
const router = new ResponseRouter("srv-");   // 服务端自己也要发请求，所以它也有一张未决表
const state = { initialized: false };

const log = (m: string) => process.stderr.write(`[mcp-server] ${m}\n`);
const writeFrame = (o: unknown) => process.stdout.write(dumps(o) + "\n");

/**
 * ★ 服务端反过来向客户端发起一次请求，并等它的响应。
 *
 * 这在 HTTP 的世界里是不可想象的，但在 JSON-RPC 里它和正向调用是
 * 同一套报文结构，只是方向反过来。Legacy MCP 的 sampling / roots /
 * elicitation 全靠这个能力。
 */
async function askClient(method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<any> {
  const id = router.newId();
  const slot = router.register(id);
  writeFrame(makeRequest(method, params, id));
  log(`↑ 反向请求 ${method} id=${id}，等客户端回话`);
  try {
    return await slot.result(timeoutMs);
  } finally {
    // 超时也好、对方回了也好，都把槽位摘掉，否则长跑进程每超时一次就漏一个。
    router.discard(id);
  }
}

// ─── MCP 生命周期 ───────────────────────────────────────────────────────────

rpc.register("initialize", ["protocolVersion", "capabilities", "clientInfo"],
  (protocolVersion: string, _caps: unknown, clientInfo: unknown) => {
    log(`握手请求来自 ${JSON.stringify(clientInfo)}，它说协议版本 ${protocolVersion}`);
    // 版本协商：认得就原样回，不认得就回自己支持的版本
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true }, logging: {} },
      serverInfo: { name: "MiniWeatherServer", version: "0.1.0" },
      instructions: "一个只有四个工具的教学用 MCP server。",
    };
  }, 0);

/**
 * 握手第 ③ 步。这是**通知**（客户端发来时不带 id），所以绝不能有响应。
 * 协议层会自动把返回值丢掉 —— 这正是很多手写实现翻车的地方，
 * 包括 Anthropic 官方的 claude_agent_sdk（见 ../04-原文勘误.md 第五节）。
 */
rpc.register("notifications/initialized", [], () => {
  state.initialized = true;
  log("握手完成，可以正常干活了");
});

function requireInit(): void {
  // 规范里这是 SHOULD 级（客户端 SHOULD NOT 在握手前发别的请求），
  // 本 demo 收严成硬性，好让状态机看得见。
  if (!state.initialized) {
    throw new JsonRpcError(-32002, "尚未完成 initialize 握手", { need: "initialize" });
  }
}

// ─── 工具 ───────────────────────────────────────────────────────────────────

const TOOLS = [
  { name: "get_weather", description: "查询某个城市今天的天气",
    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { name: "divide", description: "两数相除（用来演示「工具执行错误」）",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "summarize", description: "概括一段文字（Legacy 做法：服务端反过来请求客户端的大模型）",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "summarize_mrtr", description: "同样是概括，但用 2026-07-28 的 MRTR 做法",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];

const WEATHER: Record<string, string> = { "北京": "晴，25°C，湿度 45%", "上海": "多云，28°C，湿度 70%" };
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

rpc.register("tools/list", ["cursor"], () => { requireInit(); return { tools: TOOLS }; }, 0);

/**
 * ★ MCP 最重要的一条设计：两类失败，走两条完全不同的路。
 *
 *  ① 协议级错误  → 抛 JsonRpcError，变成标准的 JSON-RPC error 对象。
 *     用于「模型多半修不了」的问题：工具不存在、请求结构不合 schema。
 *  ② 工具执行错误 → 正常返回 result，但带 isError: true，错误文本放 content 里。
 *     用于「模型看了能自己改参数重试」的：除零、查不到、外部 API 挂了。
 *
 * 官方理由：工具执行错误 "contain actionable feedback that language models
 * can use to self-correct and retry with adjusted parameters"。
 * 所以这条分界线是按「模型看了能不能自己改对」划的，不是按「谁的错」划的。
 */
rpc.register("tools/call", ["name", "arguments", "inputResponses", "requestState"],
  async (name: string, args: Record<string, unknown> = {}, inputResponses?: Record<string, any>, requestState?: string) => {
    requireInit();

    if (!TOOLS.some((t) => t.name === name)) {
      // ① 协议级：工具根本不存在。官方示例用的就是 -32602。
      throw new JsonRpcError(INVALID_PARAMS, "Unknown tool", { tool: name });
    }

    if (name === "get_weather") {
      const city = args.city;
      // ① 协议级：连 inputSchema 的形状都不对
      if (typeof city !== "string") throw new JsonRpcError(INVALID_PARAMS, "city 必须是字符串");
      // ② 工具执行错误：形状对，就是查不到。模型看得懂，可以换个城市重试。
      if (!(city in WEATHER)) {
        return { content: [{ type: "text", text: `没有「${city}」的天气数据，可选：${Object.keys(WEATHER).join("、")}` }], isError: true };
      }
      return { content: [{ type: "text", text: `${city}今日天气：${WEATHER[city]}` }], isError: false };
    }

    if (name === "divide") {
      // 参数不是数 → ① 协议级，与 get_weather 保持同一条线。
      // 注意 JSON 的 false 在 JS 里 `false == 0` 也成立，isNum 把它挡掉了。
      if (!isNum(args.a) || !isNum(args.b)) throw new JsonRpcError(INVALID_PARAMS, "a、b 必须是数字");
      // ② 工具执行错误：模型看到这句话就知道该把 b 换掉
      if (args.b === 0) return { content: [{ type: "text", text: "除数不能为 0，请换一个 b 再试" }], isError: true };
      return { content: [{ type: "text", text: String(args.a / args.b) }], isError: false };
    }

    if (name === "summarize") {
      // ★ Legacy：干活干到一半，反过来请求客户端「借你的大模型用一下」
      const reply = await askClient("sampling/createMessage", {
        messages: [{ role: "user", content: { type: "text", text: "用一句话概括：" + String(args.text) } }],
        maxTokens: 100,
      });
      return { content: [{ type: "text", text: "（由客户端的模型生成）" + reply.content.text }], isError: false };
    }

    if (name === "summarize_mrtr") {
      // ★ MRTR（Multi Round-Trip Requests）—— 2026-07-28 起取代反向请求。
      //
      // 服务端**不再发起自己的 JSON-RPC 请求**（现行 MCP 明文禁止），
      // 改成把「我还需要什么」装进一个正常的 result 里回去，
      // 让客户端去办，办完带着答案重发原请求。
      // 于是整条链路始终是「客户端发请求、服务端发响应」的单向骨架，
      // MCP 也因此能变成无状态的 —— 中间任何一跳都不必记住谁欠谁一个回答。
      //
      // 注意 inputRequests / inputResponses 是 **map（对象）不是数组**：
      // 键是服务端自起的标识符，值直接就是请求本体 / 客户端的 result。
      if (!inputResponses) {
        return {
          resultType: "input_required",            // ← 不是 "complete"
          inputRequests: {
            ir1: {
              method: "sampling/createMessage",
              params: { messages: [{ role: "user", content: { type: "text", text: "用一句话概括：" + String(args.text) } }], maxTokens: 100 },
            },
          },
          // 服务端把「刚才办到哪了」铸成一个不透明句柄交给客户端保管。
          // 「不透明」指客户端看不懂，不是服务端不用看 —— 下面第二轮必须校验。
          requestState: MRTR_STATE,
        };
      }
      if (requestState !== MRTR_STATE) {
        throw new JsonRpcError(INVALID_PARAMS, "requestState 无效或已过期");
      }
      const answer = inputResponses.ir1;
      if (!answer?.content?.text) throw new JsonRpcError(INVALID_PARAMS, "inputResponses.ir1 形状不对");
      return {
        resultType: "complete",
        content: [{ type: "text", text: `（第二轮返回，凭 requestState 校验通过）${answer.content.text}` }],
        isError: false,
      };
    }

    throw new JsonRpcError(INTERNAL_ERROR, `工具已登记但没实现：${name}`);
  }, 1);

// ─── 传输：一行一帧，请求去分发，响应去认领 ─────────────────────────────────

async function handleLine(line: string): Promise<void> {
  let obj: unknown;
  try { obj = JSON.parse(line); } catch { writeFrame(makeError(null, PARSE_ERROR)); return; }

  // 这一步是「对等端」的标志：收到的东西既可能是对方的请求，
  // 也可能是对方对我先前那次反向请求的回答。
  if (typeof obj === "object" && obj !== null && !Array.isArray(obj) && !("method" in obj)) {
    if (!router.resolve(obj as ResponseObject)) log(`收到一个没人认领的响应：${line}`);
    return;
  }
  const out = await rpc.handlePayload(obj);
  if (out !== null) writeFrame(out);
}

log(`已就绪（协议版本 ${PROTOCOL_VERSION}），等待 initialize`);
readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (raw) => { const l = raw.trim(); if (l) void handleLine(l).catch((e) => log(`炸了：${e}`)); })
  .on("close", () => log("退出"));
