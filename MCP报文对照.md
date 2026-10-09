# MCP 每条报文的字段是谁定的

demo 里出现的每一种报文，逐字段标出来源。三种来源：

- **J** = JSON-RPC 2.0 定的。所有 JSON-RPC 都这样，跟 MCP 无关
- **M** = MCP 规范定的。字段名、取值都不能改
- **自** = 我们自己定的。换个 server 就不一样

## 0. 信封：每条消息都有

请求：

```json
{"jsonrpc":"2.0", "method":"...", "params":{...}, "id":1}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `jsonrpc` | J | 固定 `"2.0"` |
| `method` | J 定字段，M 定取值 | 只能填 MCP 规定的方法名 |
| `params` | J 定字段，M 定内容 | 必须是对象（JSON-RPC 允许数组，MCP 不允许） |
| `id` | J | 数字或字符串。JSON-RPC 允许 null，MCP 不允许 |

成功响应：

```json
{"jsonrpc":"2.0", "result":{...}, "id":1}
```

失败响应：

```json
{"jsonrpc":"2.0", "error":{"code":-32602, "message":"...", "data":...}, "id":1}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `result` | J 定字段，M 定内容 | 里面长什么样看下面各方法 |
| `error.code` | J 定字段 | -32700 ~ -32603 是 J 定的取值；-32020 ~ -32099 是 M 定的取值 |
| `error.message` | J | 一句话 |
| `error.data` | J 定字段，内容自定 | 想带什么带什么 |

## 1. 每个请求的 params 里都有的 `_meta`

```json
"params": {
  ...,
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {"name":"MiniAgent", "version":"2.0.0"}
  }
}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `_meta` | M | 键名固定 |
| `.../protocolVersion` | M | 必带。取值是 MCP 发布的版本日期 |
| `.../clientCapabilities` | M | 必带。客户端会什么，啥都不会填 `{}` |
| `.../clientInfo` | M 定字段，值自定 | 可选。`name`、`version` 字段名是 M 定的，填什么自己定 |

每个 result 里都有的 `_meta`：

```json
"result": {
  "resultType": "complete",
  ...,
  "_meta": {"io.modelcontextprotocol/serverInfo": {"name":"MiniWeatherServer", "version":"0.2.0"}}
}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `resultType` | M | 必带。`"complete"` 或 `"input_required"`，就这两个值 |
| `.../serverInfo` | M 定字段，值自定 | 可选。服务端报个名 |

下面各方法的 result 里，`resultType` 和 `_meta` 不再重复列。

## 2. server/discover

请求：params 里只有 `_meta`。

响应：

```json
"result": {
  "supportedVersions": ["2026-07-28"],
  "capabilities": {"tools": {}},
  "ttlMs": 3600000,
  "cacheScope": "public"
}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `supportedVersions` | M | 我支持哪几版 |
| `capabilities` | M | 我会什么。`tools`、`resources`、`prompts` 这几个键名是 M 定的 |
| `ttlMs` | M | 这个结果能缓存几毫秒 |
| `cacheScope` | M | `"public"` 谁都能缓存，`"private"` 只有这个客户端能 |

## 3. tools/list

请求：params 里只有 `_meta`。

响应：

```json
"result": {
  "tools": [
    {
      "name": "get_weather",
      "description": "查询某个城市今天的天气",
      "inputSchema": {"type":"object", "properties":{"city":{"type":"string"}}, "required":["city"]}
    }
  ],
  "ttlMs": 300000,
  "cacheScope": "public"
}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `tools` | M | 数组 |
| `tools[].name` | M 定字段，值自定 | 工具名，自己起 |
| `tools[].description` | M 定字段，值自定 | 给模型看的说明，自己写 |
| `tools[].inputSchema` | M 定字段，内容是 JSON Schema | 参数长什么样。`type`、`properties`、`required` 是 JSON Schema 定的；`city` 是自己定的 |
| `ttlMs`、`cacheScope` | M | 同上 |

## 4. tools/call：正常

请求：

```json
"params": {
  "name": "get_weather",
  "arguments": {"city": "北京"},
  "_meta": {...}
}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `name` | M 定字段，值自定 | 调哪个工具，得是 `tools/list` 里报过的 |
| `arguments` | M 定字段，内容自定 | 里面的 `city` 是自己定的，要和 `inputSchema` 对上 |

响应：

```json
"result": {
  "content": [{"type":"text", "text":"北京今日天气：晴，25°C"}],
  "isError": false
}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `content` | M | 数组，一段一段的内容 |
| `content[].type` | M | `"text"`、`"image"`、`"audio"`、`"resource"`，M 定的几个值 |
| `content[].text` | M 定字段，值自定 | 给模型看的文字 |
| `isError` | M | 工具执行成功还是失败 |

## 5. tools/call：两种失败

工具不存在，参数格式错。回 JSON-RPC 的 error，给程序看：

```json
"error": {"code": -32602, "message": "Unknown tool", "data": {"tool": "no_such_tool"}}
```

| 字段 | 来源 |
|---|---|
| `code: -32602` | J 定的码，M 规定「工具不存在」用这个码 |
| `message` | 自定 |
| `data` | 自定 |

工具跑了但没成，回正常 result，给模型看：

```json
"result": {
  "content": [{"type":"text", "text":"除数不能为 0，请换一个 b 再试"}],
  "isError": true
}
```

和第 4 节一样的结构，只是 `isError` 变成 `true`，`text` 里写清楚为什么失败。

## 6. tools/call：MRTR 两轮

第一轮请求和第 4 节一样。第一轮响应：

```json
"result": {
  "resultType": "input_required",
  "inputRequests": {
    "ask_name": {
      "method": "elicitation/create",
      "params": {"mode":"form", "message":"你叫什么？", "requestedSchema":{...}}
    }
  },
  "requestState": "opaque-state-token-7f3a"
}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `resultType: "input_required"` | M | 缺东西 |
| `inputRequests` | M | 对象，键是自己起的名字 |
| `inputRequests.ask_name` | 键名自定 | 第二轮客户端按这个名字回 |
| `inputRequests.ask_name.method` | M | 要客户端干什么。`elicitation/create` 是问用户，M 定的方法名 |
| `inputRequests.ask_name.params` | M | 见下面「elicitation/create 的 params」 |
| `requestState` | M 定字段，内容自定 | 服务端的便签，客户端不看，原样带回 |

### elicitation/create 的 params

三个字段，全是 M 定的：

| 字段 | 必带 | 取值 |
|---|---|---|
| `mode` | 否，不填等于 `"form"` | `"form"` 或 `"url"`，就这两个 |
| `message` | 是 | 给用户看的一句话，说明为什么要问 |
| `requestedSchema` | `form` 模式要 | 表单长什么样 |
| `url` | `url` 模式要 | 让用户去打开的网址 |

**`form` 模式**：客户端弹个表单，用户填完把数据交回来。数据会经过客户端，所以不能用来要密码、token 这类敏感信息。

**`url` 模式**：客户端只负责把网址给用户看、征得同意后打开。用户在网页上干什么客户端不知道。用来做授权、付款、填 API key。

`requestedSchema` 是缩水版的 JSON Schema，规则：

- 最外层必须是 `{"type":"object", "properties":{...}, "required":[...]}`
- `properties` 里每个字段只能是下面五种之一，**不能嵌套对象，不能数组套对象**。因为客户端要把它画成表单

| 字段类型 | 写法 | 可选的附加字段 |
|---|---|---|
| 文本 | `{"type":"string"}` | `minLength`、`maxLength`、`format`（只认 `email`、`uri`、`date`、`date-time`） |
| 数字 | `{"type":"number"}` 或 `"integer"` | `minimum`、`maximum` |
| 开关 | `{"type":"boolean"}` | |
| 单选 | `{"type":"string", "enum":["红","绿","蓝"]}` | 想给选项配显示名用 `oneOf: [{const, title}]` |
| 多选 | `{"type":"array", "items":{"type":"string","enum":[...]}}` | `minItems`、`maxItems` |

每种都可以带 `title`（表单上显示的字段名）、`description`（字段说明）、`default`（默认值）。

例子，问名字、邮箱、年龄，前两个必填：

```json
"requestedSchema": {
  "type": "object",
  "properties": {
    "name":  { "type": "string", "title": "姓名" },
    "email": { "type": "string", "format": "email", "title": "邮箱" },
    "age":   { "type": "integer", "minimum": 18, "title": "年龄" }
  },
  "required": ["name", "email"]
}
```

客户端回来的 `inputResponses.xxx`：

| 字段 | 取值 | 意思 |
|---|---|---|
| `action` | `"accept"` | 用户填了、点了确定。`content` 里是填的数据，字段和 `requestedSchema` 对上 |
| | `"decline"` | 用户点了拒绝。没有 `content` |
| | `"cancel"` | 用户关了框、按了 Esc。没有 `content` |
| `content` | 对象 | 只有 `accept` 且是 `form` 模式才有。`url` 模式 `accept` 也没有，因为数据没经过客户端 |

服务端三种 `action` 都得接得住，不能默认用户一定会填。

第二轮请求：

```json
"params": {
  "name": "greet",
  "arguments": {},
  "inputResponses": {
    "ask_name": {"action": "accept", "content": {"name": "小孔"}}
  },
  "requestState": "opaque-state-token-7f3a",
  "_meta": {...}
}
```

| 字段 | 来源 | 说明 |
|---|---|---|
| `name`、`arguments` | 同第 4 节 | 和第一轮一样 |
| `inputResponses` | M | 键和第一轮 `inputRequests` 的键对上 |
| `inputResponses.ask_name.action` | M | `"accept"` 用户填了，`"decline"` 用户拒了，`"cancel"` 用户关了 |
| `inputResponses.ask_name.content` | M 定字段，内容按 `requestedSchema` | `name` 是第一轮 schema 里自己定的 |
| `requestState` | M | 第一轮拿到的，原样带回 |
| `id` | J | 必须换新的，不能用第一轮的 |

第二轮响应：和第 4 节一样，`resultType: "complete"`。

## 7. 三种协议级错误

| 什么情况 | code | 来源 | data 里有什么 |
|---|---|---|---|
| params 没带 `_meta` 或缺必带字段 | -32602 | J 定码，M 规定用这个 | 自定 |
| 协议版本不支持 | -32022 | M | `supported`（M 定）：我支持的版本列表；`requested`（M 定）：你发的版本 |
| 工具不存在 | -32602 | J 定码，M 规定用这个 | 自定 |

## 8. HTTP 传输的头

只在 Streamable HTTP 上有。stdio 没有头这个东西。

### 请求头（客户端发）

```http
POST /mcp HTTP/1.1
Host: 127.0.0.1:52341
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: get_weather
```

| 头 | 来源 | 必带 | 说明 |
|---|---|---|---|
| `Content-Type: application/json` | HTTP | 是 | body 是 JSON |
| `Accept` | HTTP 定头，M 定值 | 是 | 必须同时列 `application/json` 和 `text/event-stream`，表示两种回法我都接得住 |
| `MCP-Protocol-Version` | M | 是 | 抄 body 里 `_meta` 的版本，必须一致 |
| `Mcp-Method` | M | 是 | 抄 body 里的 `method`，必须一致 |
| `Mcp-Name` | M | 只有 `tools/call`、`resources/read`、`prompts/get` | 抄 body 里的 `params.name`（或 `params.uri`），必须一致 |
| `Origin` | HTTP | 浏览器自动带 | 服务端要校验，防 DNS 重绑定。不对回 403。demo 没做 |
| `Authorization` | HTTP | 远程服务要 | OAuth 的 token。本地 stdio 不用这套，从环境变量拿凭据。demo 没做 |

为什么头要抄 body：中间的负载均衡、网关不解析 body，只看头就能路由、限流、记日志。头和 body 不一致会让两边看到不同的东西，所以服务端必须核对，对不上回 400 + -32020。

### 响应头（服务端回）

正常回一个 JSON：

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

回 SSE 流（先推进度最后给结果，demo 没做）：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
X-Accel-Buffering: no
```

| 头 | 来源 | 说明 |
|---|---|---|
| `Content-Type: application/json` | M | 一个 JSON 对象，就是那条 JSON-RPC 响应 |
| `Content-Type: text/event-stream` | M | SSE 流。每条 `data:` 是一条 JSON-RPC 消息，前面是通知，最后一条是响应，然后关流 |
| `X-Accel-Buffering: no` | M 建议 | 开 SSE 时带，让 nginx 这类反向代理别缓冲，不然进度攒一堆才到 |
| `Allow: POST` | HTTP | 回 405 时带，告诉对方只接 POST |

### 状态码

| 情况 | 状态 | body | 来源 |
|---|---|---|---|
| 正常、工具执行错误、工具不存在 | 200 | JSON-RPC 响应 | M |
| 通知 | 202 | 没有 | M |
| 头和 body 对不上、缺必带头 | 400 | error -32020 | M |
| 版本不支持 | 400 | error -32022 | M |
| 缺 `_meta` 必带字段 | 400 | error -32602 | M |
| body 不是 JSON | 400 | error -32700 | M |
| 方法不存在 | 404 | error -32601 | M |
| `Origin` 不对 | 403 | 可以没有 | M |
| GET、DELETE | 405 | 没有 | M |

一句话：JSON-RPC 自己的错误照样是 200，只有传输层能判断的问题才用 4xx。工具不存在是 200，因为那是 JSON-RPC 层面的事，HTTP 层不该管。

demo 的服务端只做了 200 / 202 / 405，头不核对。上面表里的 400 / 404 是规范要求，做的话要先解析 body。

## 速记

- 信封四个字段：JSON-RPC 的
- `method` 取值、`params` 和 `result` 里的字段名：MCP 的
- 工具名、参数名、文字内容、`requestState` 里装什么：自己的
- `_meta` 里带 `io.modelcontextprotocol/` 前缀的：MCP 的
