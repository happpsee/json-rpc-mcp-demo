# json-rpc-mcp-demo

一个能跑的 JSON-RPC 2.0 + MCP 示例，手写的协议层，没有用 json-rpc 或 mcp 的库。

代码只有两个文件：

- `jsonrpc.ts` — JSON-RPC 2.0 那一层。入口是 `jsonrpc(line, methods)`，收一行字符串，返回一行字符串或者 `null`。它不关心底下是管道还是 HTTP。
- `demo.ts` — 一个 MCP 服务端。实现了 `server/discover`、`tools/list`、`tools/call` 三个方法，里面有一个查天气的工具。

`demo.ts` 往 `jsonrpc.ts` 的方法表里塞了三个 MCP 规定名字的方法，除此之外没有 MCP 相关的代码。stdio 和 HTTP 两种跑法用的是同一张方法表。

## 跑

需要 Node 22 以上。

```bash
pnpm install
pnpm stdio        # 默认。stdin 进一行，stdout 出一行
pnpm http         # 同一张方法表挂到 HTTP 上，监听 127.0.0.1:3000
pnpm typecheck    # tsc --noEmit
```

两种跑法都不会自己发请求，等着你喂。

stdio：

```bash
echo '{"jsonrpc":"2.0","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}},"id":1}' | npx tsx demo.ts
```

HTTP：

```bash
npx tsx demo.ts http &

curl -s -X POST http://127.0.0.1:3000 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}},"id":2}'
```

## 代码里能看到的几处

- 通知的判据是「有没有 `id` 这个键」，不是「值是不是 null」。写错的话客户端发 `{"id": null}` 想拿结果，服务端当通知处理，一声不吭。
- 响应里 `result` 和 `error` 只出现一个，不出现指的是没有这个键。
- 每个请求自己带 `_meta`（协议版本 + 客户端能力），服务端逐条检查，不记状态。没有 `initialize` 握手。
- 版本不支持回 `-32022`，`data.supported` 列出支持的版本。
- 服务端身份（含一张 18060 字符的 base64 图标）只在 `server/discover` 报一次。不这么收窄的话，`tools/call` 的响应会从 378 字节涨到 18 KB。

## 故意没做的

这是示例，没做边界防御。往产品里搬之前至少要补：

| 缺什么 | 说明 |
|---|---|
| id 类型校验 | `{"id": {"a":1}}` 会被原样回填 |
| 消息大小上限 | 一行超长 JSON 直接吃内存 |
| HTTP 三个头校验 | `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` 没跟 body 核对，规范要求对不上回 400 + `-32020` |
| 规范要求的 4xx | HTTP 版只做了 200 / 202 / 405 |
| 两个演示工具 | 工具执行错误（`isError`）和 `input_required` 两种回法没写，现在只有 `get_weather` |

另外 `MCP_INFO["server/discover"]` 那段配置是死代码，没有被读到，实际返回的字段都在 `serverDiscover()` 里。

## 天气工具

`tools/call` 里的 `get_weather` 会请求 `uapis.cn` 的公开接口，不需要 API key。只想过一遍协议行为的话跳过 `tools/call` 就行。

## 文档

讲解文档还没写，后面补。
