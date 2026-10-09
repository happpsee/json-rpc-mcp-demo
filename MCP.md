# MCP 说明

> 对应 MCP 2026-07-28 版，2026-09-27 照官网核对过。MCP 改得快，隔半年回官网看一眼。

## MCP 是什么

MCP 是 AI 应用（Claude、Cursor 这些）和外部工具之间的一套通话规矩。AI 应用是客户端，你写的工具程序是服务端。

底下用的就是 JSON-RPC 2.0。每条消息都是 `{"jsonrpc":"2.0", ...}`，没有别的格式。MCP 在这之上只做了两件事：定了一批方法名，加了几条限制。

## 方法名

`method` 不能随便填，规范定死了。写一个 MCP server，真正要实现的就三个：

| 方法 | 干什么 |
|---|---|
| `server/discover` | 我支持哪些版本、有什么能力。客户端可以不调 |
| `tools/list` | 我有哪些工具 |
| `tools/call` | 调一个工具 |

你自己写的工具，名字不放在 `method` 里，放在 `tools/call` 的 `params.name` 里：

```json
{"method":"tools/call","params":{"name":"get_weather","arguments":{"city":"北京"}},"id":4}
```

`tools/list` 返回每个工具的名字、描述、参数格式。参数格式就是普通的 JSON Schema，模型看了知道怎么填。

## 比 JSON-RPC 多的限制

JSON-RPC 允许的，MCP 有三样不允许：

| | JSON-RPC | MCP |
|---|---|---|
| 批量 | 可以一个数组装多条 | 不行 |
| id | 可以是 null | 不能是 null |
| params | 可以是数组 | 只能是对象 |

## 没有握手

以前客户端要先发 `initialize`，服务端回自己的版本和能力，客户端再发一条 `notifications/initialized`，然后才能干活。服务端要记住这条连接握过手了。

2026-07-28 版把这套删了。改成每个请求自己带上版本和能力，放在 `params._meta` 里：

```json
{"method":"tools/list","params":{"_meta":{
  "io.modelcontextprotocol/protocolVersion":"2026-07-28",
  "io.modelcontextprotocol/clientCapabilities":{},
  "io.modelcontextprotocol/clientInfo":{"name":"MiniAgent","version":"2.0.0"}
}},"id":1}
```

服务端收一条看一条：

- `_meta` 没带 → 回 -32602
- 版本不支持 → 回 -32022，`data.supported` 里列出自己支持哪些，客户端换一个再发
- 都对 → 正常处理

服务端什么都不记。这样一个请求落到哪台机器都能处理，方便放负载均衡和 Serverless 后面。

回的 result 也多两样：必须带 `resultType: "complete"`，`_meta` 里带上 `serverInfo` 报个名字。

`server/discover` 是可选的，一次问清版本、能力、身份。不调，直接发 `tools/list` 也行。

> 场景 M1

## 两种传输

**stdio**：本地工具用这个。客户端把你的程序当子进程拉起来，stdin 进一行，stdout 出一行。日志只能写 stderr。最常见的 bug 是某个依赖库启动时往 stdout 打了一行欢迎语，整条协议就乱了。

**Streamable HTTP**：远程服务用这个。一个 URL，每条请求一个 POST。服务端可以直接回一个 JSON，也可以开一条 SSE 流，先推进度最后给结果。demo 只做了回 JSON。

比普通 JSON-RPC over HTTP 多三条规矩：

- POST 要带三个头，是 body 里字段的镜像：`MCP-Protocol-Version` 对应 `_meta` 里的版本，`Mcp-Method` 对应 `method`，`Mcp-Name` 对应 `params.name`。中间的网关只看头就能路由，所以服务端要核对头和 body 一致，不一致回 400 + -32020
- 拒的时候 HTTP 状态码也要对：头不匹配、版本不支持是 400，方法不存在是 404，正常和工具执行错误都是 200
- 通知回 202 没 body。GET 不再支持

demo 的 HTTP 版只做了 405 / 202 / 200 三种，头照发但服务端不核对，因为核对得先解析 body，而 body 是原样交给协议层的。两种传输挂的是同一张方法表（`demo.ts` 里的 `methods`），`pnpm stdio` 和 `pnpm http` 跑出来的 JSON 一模一样。

## 工具出错的两种回法

这是 MCP 里最要紧的一条设计。

| | 协议级错误 | 工具执行错误 |
|---|---|---|
| 长什么样 | JSON-RPC 的 `error` | 正常 `result`，里面 `isError: true` |
| 什么时候用 | 工具不存在、参数格式不对 | 除零、查不到、外部接口挂了 |
| 给谁看 | 程序 | 模型 |

```json
<-- {"error":{"code":-32602,"message":"Unknown tool"},"id":6}
<-- {"result":{"resultType":"complete","content":[{"type":"text","text":"除数不能为 0，请换一个 b"}],"isError":true},"id":7}
```

怎么分：模型看了能不能自己改对。除以零写成 `error`，模型只看到一个 -32602，不知道该怎么办。写成 `isError` 加一句话，模型看了就知道换个参数重试。

客户端要判断两次：先看有没有 `error`，再看 `result.isError`。只看 `error` 会把工具失败当成功。

错误码还有一条：JSON-RPC 的保留区 -32000 到 -32099 里，-32020 到 -32099 归 MCP 规范用，比如上面的 -32022。你自己的 server 别往这段放。

> 场景 M4

## 服务端要客户端帮忙

工具跑到一半要问用户一句话，怎么办？

以前是服务端反过来向客户端发请求（`elicitation/create`），客户端答完服务端再继续。这样服务端也得维护一张等回答的表，实际上大多数 server 都没这么干。

新版叫 MRTR。服务端不发请求，回一个 `resultType: "input_required"` 的 result，里面说清我缺什么。客户端办完，用新 id 把原请求重发一遍，带上答案：

```
<-- {"result":{"resultType":"input_required","inputRequests":{"ask_name":{"method":"elicitation/create",...}},"requestState":"token"},"id":8}
--> {"method":"tools/call","params":{...,"inputResponses":{"ask_name":{"action":"accept","content":{"name":"小孔"}}},"requestState":"token"},"id":9}
<-- {"result":{"resultType":"complete",...},"id":9}
```

全程还是客户端问、服务端答。`requestState` 是服务端给的一个句柄，客户端原样带回来，服务端自己不存东西。代价是多一次往返。

借客户端的模型（Sampling）新版标成废弃了，server 要用模型自己直接调 API。

> 场景 M5

## 一句话

MCP = JSON-RPC + 三个方法 + 每条请求自带 `_meta` + 工具错误写进 result。剩下的去官网查。
