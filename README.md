# JSON-RPC 2.0 与 MCP 教学演示

这是一个**教学演示项目**，不是能直接用的库。

它做一件事：**手写一遍 JSON-RPC 2.0 的协议层，再在这层上面搭一个 MCP 服务端**，全程不依赖任何 JSON-RPC 或 MCP 库。协议要守的规矩、容易写错的地方，都在代码里能看见。

跑完你能回答这几个问题：

- `id` 到底为什么不能省？把 `{"id": null}` 当成通知会出什么事？
- 通知为什么不能回响应？回 `200 + 空字符串` 会怎样？
- MCP 2026-07-28 为什么把 `initialize` 握手删了？不握手的话每条请求要自带什么？
- 「工具执行失败」和「协议级错误」为什么要分成两种回法？

## 内容

| 读什么 | 是什么 |
|---|---|
| [JSON-RPC.md](JSON-RPC.md) | 协议讲了什么，坑在哪，手写实现最容易错的三处 |
| [MCP.md](MCP.md) | MCP 在 JSON-RPC 上加了哪些限制，新版为什么没有握手 |
| [MCP报文对照.md](MCP报文对照.md) | 每条报文的字段，逐字段标出是 JSON-RPC 定的（J）、MCP 定的（M），还是自己定的（自） |
| [抓包实录.md](抓包实录.md) | 从本仓库代码真实跑出来的完整报文，不想跑就看这个 |

代码只有两个文件：

| 文件 | 干什么 |
|---|---|
| [`jsonrpc.ts`](jsonrpc.ts) | JSON-RPC 协议层。唯一入口 `jsonrpc(line, methods)`：收一行字符串，返一行字符串或 `null`。不分传输 |
| [`demo.ts`](demo.ts) | 迷你 MCP 服务端。三个方法 `server/discover` / `tools/list` / `tools/call`，挂一张方法表到 stdio 或 HTTP 上 |

`demo.ts` 没有 import 任何 MCP 库。它只是往 `jsonrpc.ts` 的方法表里塞了三个 MCP 规定好名字的方法，而且它不知道自己跑在哪种传输上——换传输只换最后 30 行。

## 跑

需要 Node 22 以上。

```bash
pnpm install
pnpm stdio        # stdio 传输：stdin 进一行，stdout 出一行
pnpm http         # 同一张方法表，挂在 HTTP 上（监听 127.0.0.1:3000）
pnpm typecheck    # tsc --noEmit（strict + noUncheckedIndexedAccess）
```

两种模式都不会自己发请求，等着你喂。stdio 版最简单的用法：

```bash
echo '{"jsonrpc":"2.0","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}},"id":1}' \
  | npx tsx demo.ts
```

HTTP 版：

```bash
npx tsx demo.ts http &
curl -s -X POST http://127.0.0.1:3000 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}},"id":2}'
```

### 关于天气工具

`tools/call` 里的 `get_weather` 会去请求 [`uapis.cn`](https://uapis.cn) 的公开天气接口，**不需要 API key**（实测带不带认证头返回一样）。这个网络调用是整个 demo 里唯一的真实副作用，你如果只想看协议行为不想联网，跳过 `tools/call` 就行。

## 三个能直接看见的点

**一、通知不回响应，判据是「有没有 id 这个键」。** 不是「值是不是 null」。

```js
const isNotification = !("id" in req);   // ✅
const isNotification = req.id == null;   // ❌ 把 {"id": null} 也吞了
```

[`jsonrpc.ts`](jsonrpc.ts) 里就是这么判的。写错了的后果是：客户端发 `{"id": null}` 想拿结果，服务端当成通知一声不吭，客户端永远等。

**二、`result` 和 `error` 只出现一个。** 规范原话是 "both members MUST NOT be included"。不出现指的是**没有这个键**，不是值为 null。

**三、新版 MCP 没有握手。** 老版要 `initialize` → `notifications/initialized` 两轮，服务端得记住这条连接握过手。2026-07-28 把这两条删了，改成每个请求自己带 `_meta`：

```json
{"method":"tools/list","params":{"_meta":{
  "io.modelcontextprotocol/protocolVersion":"2026-07-28",
  "io.modelcontextprotocol/clientCapabilities":{}
}},"id":1}
```

服务端逐条看：没带 → `-32602`；版本不支持 → `-32022`（`data.supported` 里列出支持的版本）；都对 → 正常处理。服务端什么都不记，所以一个请求落到哪台机器都能处理。

## 故意没做的部分

这是学习用的 demo，**故意不做边界防御**。往产品里搬之前至少要补：

| 缺什么 | 后果 |
|---|---|
| id 类型校验 | `{"id": {"a":1}}` 这种会被原样回填 |
| 消息大小上限 | 一行超长 JSON 直接吃内存 |
| HTTP 三个头校验 | `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` 没跟 body 核对（规范要求对不上回 400 + `-32020`） |
| 规范要求的 4xx | HTTP 版只做了 200 / 202 / 405，版本不支持该回 400 而不是 200 |
| 工具的 `divide`、`greet` | 文档里提到的「工具执行错误 `isError`」和「MRTR `input_required`」两种回法在代码里有讲到，但当前 `demo.ts` 只实现了 `get_weather` 一个工具 |

已知的一处浪费：`complete()` 给**每条**响应都加了 `_meta.serverInfo`，而这个字段里内嵌了一张 5 KB 多的 base64 图标，导致响应普遍涨到 6 KB 上下。规范只要求 `resultType: "complete"`，图标本该只在 `server/discover` 里报一次。这个坑留着没改，它演示的是「规范没禁，不代表应该这么做」。详见[抓包实录.md](抓包实录.md)文末。

## 文档校对基准

MCP 改得快。[MCP.md](MCP.md) 对应 **2026-07-28** 版，2026-09-27 照官网核对过；隔半年回官网看一眼。
