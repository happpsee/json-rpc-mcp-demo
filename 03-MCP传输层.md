# MCP 是怎么用 JSON-RPC 的

> 读这一篇前，请先读完 [01-概念.md](01-概念.md)，并跑一遍 `python3 demo/mcp_client.py`。
> 本篇所有 MCP 事实均核对自 modelcontextprotocol.io 官方规范，**核对日期 2026-09-20**，现行修订版 **2026-07-28**。MCP 迭代很快，看到本文半年以上请回官网复核。

## 0. 一句话

**MCP 不是一个新协议，它是 JSON-RPC 2.0 + 一份方法命名表 + 几条加严规定。**

你在 01 篇学的每一条——信封四件套、id 配对、通知不回复、result/error 互斥——在 MCP 里原封不动地成立。MCP 在它上面只做了三件事：

1. 规定了一批方法名（`initialize`、`tools/list`、`tools/call`…）
2. 规定了两种传输的分帧方式（JSON-RPC 自己不管这个）
3. **给 JSON-RPC 做了三条减法**，并在 `params._meta` 里开了一道扩展门

把这三件事弄明白，MCP 就只剩下「查文档看方法名」这点事了。

---

## 1. 版本简史：一条绕回原点的路

| 修订版 | 关键变化 |
|---|---|
| 2024-11-05 | 首版。两种传输：stdio，以及 HTTP+SSE **双端点**（一个 GET 开 SSE、一个 POST 发消息） |
| 2025-03-26 | 引入 **Streamable HTTP** 单端点传输；明确要求实现 **MUST 支持接收 JSON-RPC 批量** |
| 2025-06-18 | **移除 JSON-RPC 批量**（changelog 第一条，PR #416）；新增 elicitation、structuredContent |
| 2025-11-25 | 澄清输入校验错误归类（SEP-1303）；允许服务端随时断开 SSE 流、客户端凭 `Last-Event-ID` 续传（SEP-1699） |
| **2026-07-28** | **当前版本。** 取消 initialize 握手、删掉会话、整体转为无状态；反向请求换成 MRTR |

注意版本号的含义：它是 **最后一次做出向后不兼容改动的日期**，向后兼容的改动不递增版本号。

这条时间线里藏着一个很有意思的弧线：

> JSON-RPC 规范开篇自称 **stateless**。
> MCP 从 2024-11-05 到 2025-11-25 一路往上加状态——会话 ID、连接内的能力协商、id 不得跨会话复用。
> 然后 2026-07-28 把它们全删了，**绕回到基础协议的原始定位**。

这不是反复横跳。加状态是为了让「一次对话」这件事在协议层面成立；删状态是因为一旦要过负载均衡、网关、Serverless，任何「服务端记得你上次说了什么」的假设都会变成部署上的枷锁。**无状态是分布式部署的通行证**，这个代价 MCP 用了两年才认。

⚠️ **被融合的那篇中文文章写的是 2025-03-26**（文中 `protocolVersion` 出现两次，都是这个值）。它的 MCP 一章已经整体过期，细节见 [04-原文勘误.md](04-原文勘误.md)。

---

## 2. 三条减法：MCP 用了 JSON-RPC，但不是全部的 JSON-RPC

这一节是本篇最实用的部分。**照着 JSON-RPC 规范写 MCP Server，就会在这三个地方踩空。**

### 减法一：没有批量

2025-03-26 还写着 "implementations MAY support sending JSON-RPC batches, but **MUST support receiving**"，2025-06-18 整条删掉，此后没有恢复。在传输层也能验证：

> The body of the HTTP POST **MUST** be a single JSON-RPC *request* or *notification*.（2026-07-28 Streamable HTTP）

所以：

```
JSON-RPC 规范 §6：客户端 MAY 发送一个装满请求的数组     ✅ 协议允许
MCP：                                                 ❌ 不接受
```

demo 的 `mcp_server.py` 因为协议层是按纯 JSON-RPC 写的，扔给它一个数组它照样处理（见场景 M7）——但真正的 MCP server 不会。

### 减法二：id 不许是 null，也不许复用

| | JSON-RPC 2.0 | MCP |
|---|---|---|
| id 类型 | String / Number / **Null** | **只能 string 或 integer** |
| id 为 null | 允许（是普通请求，不是通知） | **MUST NOT** |
| id 复用 | 未规定 | 2024-11-05 ~ 2025-11-25：同一会话内不得复用<br>2026-07-28：不得与**在途**未响应的请求撞号 |

MCP 的原话：

> Requests MUST include a string or integer ID. **Unlike base JSON-RPC, the ID MUST NOT be `null`.**

这正是 01 篇第 3 节那个坑的最终解法——**规范里的「不鼓励」，下游协议直接升级成了硬禁令。**

### 减法三：只用具名参数

JSON-RPC §4.2 允许 `params` 是数组（by-position）或对象（by-name）。**MCP 的 params 恒为对象**，schema 里从来没有数组形式。

三条减法并排看，结论就清楚了：**MCP 选 JSON-RPC 不是因为它功能多，而是因为它足够小。** 小到 MCP 还能再砍掉三分之一，剩下的部分依然够用。

### 一条加法：`params._meta`

JSON-RPC 把 `params` 定义成对上层不透明的结构体，MCP 就在里面开了一个受管的元数据区 `_meta`，把协议版本、客户端能力、进度令牌（progressToken）、日志级别、订阅 ID、OpenTelemetry 的 traceparent 全塞进去，并定义了保留键名规则（第二个 label 是 `modelcontextprotocol` 或 `mcp` 即为保留）。

**不改 JSON-RPC 的信封，只在 params 里开一个受管的口子**——这是整个 MCP 设计里最值得工程借鉴的一手。想扩展协议时，先问问能不能在已有的不透明字段里开门，而不是往信封上加字段。

---

## 3. 两种传输

JSON-RPC 不管分帧（01 篇第 7 节），MCP 必须自己补。它补了两套。

### stdio：一行一帧

这就是 demo 用的那套，也是本地 MCP server 的标准形态：

```
stdin   ← 对端发来的报文，一行一帧
stdout  → 我发出的报文，一行一帧
stderr  → 日志
```

四条硬规矩：

| 规矩 | 原文 |
|---|---|
| 换行分帧，**帧内禁止裸换行** | "Messages are delimited by newlines, and MUST NOT contain embedded newlines." |
| stdout 只能是协议消息 | "The server MUST NOT write anything to its stdout that is not a valid MCP message." |
| stdin 同理 | 客户端 MUST NOT 往服务端 stdin 写非 MCP 内容 |
| **必须 UTF-8** | "JSON-RPC messages MUST be UTF-8 encoded." |

**第二条是现实中最高频的 MCP bug**：某个依赖库在启动时往 stdout 打了一行横幅，整条协议流当场报废。所以 demo 的 `server_stdio.py` 把 `log()` 写死成走 stderr，并在注释里标了这条纪律。

第四条在 Windows 上最容易炸——默认编码是 cp936 而不是 UTF-8。

顺带一提，MCP 从来**没有**用过 LSP 那套 `Content-Length: N\r\n\r\n` 头部分帧。这两个协议都基于 JSON-RPC，但分帧方式完全不同——这恰恰是「JSON-RPC 不管分帧」最好的例证。

2026-07-28 还补了两条方向性约束，并指出这套线格式可原样用于 Unix domain socket / TCP：

- 客户端 **MUST NOT** 往 stdin 写 JSON-RPC **响应**
- 服务端 **MUST NOT** 往 stdout 写 JSON-RPC **请求**

后一条就是「服务端不再发起请求」这条大变化在传输层的落地，见第 6 节。

### Streamable HTTP：单端点，响应可升级成流

2025-03-26 引入，取代了 2024-11-05 的 HTTP+SSE 双端点方案。

**2025-06-18 版（Legacy，目前生态里绝大多数 SDK 还是这套）：**

- 服务端只暴露**一个** MCP 端点，同时支持 POST 与 GET
- 客户端每条消息一个 POST，`Accept` 头 **必须同时列出** `application/json` 和 `text/event-stream`
- POST 的 body 是**响应或通知** → 服务端回 **202 Accepted**，无 body
- POST 的 body 是**请求** → 服务端二选一，客户端两种都必须支持：
  - `Content-Type: application/json`，回一个 JSON 对象
  - `Content-Type: text/event-stream`，**开一条 SSE 流**，流里可以先陆续发进度通知，最后发响应并关流
- 服务端可在 initialize 响应头里下发 `Mcp-Session-Id`，客户端此后每个请求 MUST 带上；服务端可随时对该 ID 返回 404，客户端收到后 MUST 重新握手
- 客户端可 GET 该端点开一条**与任何在途请求无关**的 SSE 长连接，供服务端主动推送
- 握手后每个 HTTP 请求 MUST 带 `MCP-Protocol-Version` 头

> 注意 202 这个细节：它正是 01 篇第 7 节「通知在 HTTP 上该回什么」的**权威答案**。demo 的 `server_http.py` 用的是通用 JSON-RPC over HTTP 的事实标准 204 No Content；MCP 自己规定的是 202 Accepted。两者都是「无 body」，选哪个取决于你在写通用 JSON-RPC 服务还是 MCP 服务。

**2026-07-28 版（Modern）删掉了一大半：**

- 删 `Mcp-Session-Id`
- 删 GET 长连接端点（改用 `subscriptions/listen`：客户端 POST 一个 listen 请求并声明想订阅的通知类型，**它的响应流本身就是那条长连接**）
- 删 SSE 断点续传（`Last-Event-ID` 与事件 ID）
- 旧客户端来的 GET/DELETE **SHOULD** 回 405，`Mcp-Session-Id` 与 `Last-Event-ID` 一律忽略
- 新增头体镜像：POST 必须带 `Mcp-Method`（取自 method）；`tools/call`、`resources/read`、`prompts/get` 还必须带 `Mcp-Name`（取自 `params.name` 或 `params.uri`）。服务端 **MUST 校验头与 body 一致**，不一致回 400 + `-32020`

最后一条的动机写得很直白：**让负载均衡和网关不解析 body 就能路由**，同时防止「LB 按头路由、服务器按 body 执行」的分叉攻击。这是一个纯消息层协议被搬到真实网络基础设施上之后，必然会长出来的东西。

两条工程细节，写 SSE 时真会踩：开流时带 `X-Accel-Buffering: no`（否则 nginx 会把事件攒在缓冲区里不吐），长连接上定期发 `:` 注释行做 keep-alive。

---

## 4. 生命周期：从握手到无握手

### Legacy（2024-11-05 ~ 2025-11-25）：三步握手

```
① 客户端 --> {"jsonrpc":"2.0","method":"initialize","params":{
                "protocolVersion":"2025-06-18",
                "capabilities":{"tools":{},"sampling":{}},
                "clientInfo":{"name":"MiniAgent","version":"1.0.0"}},"id":2}

② 服务端 <-- {"jsonrpc":"2.0","result":{
                "protocolVersion":"2025-06-18",
                "capabilities":{"tools":{"listChanged":true},"logging":{}},
                "serverInfo":{"name":"MiniWeatherServer","version":"0.1.0"}},"id":2}

③ 客户端 --> {"jsonrpc":"2.0","method":"notifications/initialized"}
             （通知，服务端一个字都不许回）
```

**第三步是通知**——这是「服务端绝不能回复通知」这条规矩在 MCP 里最重要的落点，也是手写实现最容易踩空的地方（见 [04-原文勘误.md](04-原文勘误.md) 第五节，官方 SDK 就在这里写错了）。

版本协商规则：客户端送自己支持的版本；服务端支持就原样回同一个，不支持就回自己支持的另一个版本；客户端不认服务端回的版本就 SHOULD 断开。

握手期间的限制是 **SHOULD** 级：客户端收到 initialize 响应前 SHOULD NOT 发除 `ping` 外的请求；服务端收到 initialized 通知前 SHOULD NOT 发除 `ping` 和 logging 外的请求。demo 里把它收严成了硬性（场景 M0），纯粹是为了让状态机看得见。

### Modern（2026-07-28）：没有握手了

`initialize` 与 `notifications/initialized` 被整个移除。取而代之：

- **每个请求**在 `_meta` 里自带 `io.modelcontextprotocol/protocolVersion`（必填）与 `io.modelcontextprotocol/clientCapabilities`（必填），`clientInfo` 选填但 SHOULD 带
- 服务端**逐请求**接受或拒绝，版本不支持时回 `-32022 UnsupportedProtocolVersion`（`data` 里列出支持的版本）
- 新增服务端 **MUST 实现**的 `server/discover`，一次返回支持的版本集、能力与身份；客户端可选调用

这就是「无状态」落到生命周期上的样子：**处理一个请求所需的全部信息都在该请求自身内**，服务端不得依赖同一连接上的先前请求来建立上下文。跨请求的状态必须由服务端铸造显式句柄，作为普通参数由客户端每次传回。

### 迁移：做成 Dual-era

规范定义了三个词——**Modern**（2026-07-28 起）、**Legacy**（2025-11-25 及更早）、**Dual-era**（两者都支持），并给了一张**七行**兼容矩阵。

七行里只有 **Modern×Legacy** 与 **Legacy×Modern** 两行是 Fails，其余五行都能工作。**所以迁移期的正解是把客户端做成 Dual-era。**

---

## 5. ★ 两类错误：`error` 还是 `isError`

这是 MCP 在 JSON-RPC 之上做的最重要的一条语义设计，也是接 MCP 时最容易做错的一个决定。

| | 协议级错误 | 工具执行错误 |
|---|---|---|
| **报文形态** | JSON-RPC `error` 对象 | 正常的 `result`，带 `isError: true` |
| **HTTP 状态码** | 200 | 200 |
| **用于** | 工具不存在、请求不满足 `CallToolRequest` schema、服务器内部错误 | API 调用失败、输入校验失败（日期格式、取值越界）、业务逻辑错误 |
| **客户端该怎么办** | MAY 交给模型（"不太可能带来成功恢复"） | **SHOULD 交给模型** |

```json
① 协议级：调了一个不存在的工具
<-- {"jsonrpc":"2.0","error":{"code":-32602,"message":"Unknown tool"},"id":5}

② 工具级：除数为 0 —— 注意它回的是 result
<-- {"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"除数不能为 0，请换一个 b 再试"}],"isError":true},"id":6}
```

**为什么这么分？** 官方理由写得非常直白：协议错误是「models are less likely to be able to fix」的请求结构问题；工具执行错误则 "contain **actionable feedback** that language models can use to **self-correct and retry with adjusted parameters**"。

换句话说：**这条分界线是按「模型看了能不能自己改对」划的，不是按「谁的错」划的。**

把「除以零」写成 JSON-RPC error，模型就只看到一个冷冰冰的协议错误，无从知道该改哪个参数——这是接 MCP 时最常见的一个设计失误。

### 两个必须记住的工程后果

**其一：客户端必须写两段判断。**

```python
if "error" in response:              # ① 协议级
    handle_protocol_error(response["error"])
elif response["result"].get("isError"):   # ② 工具级
    feed_back_to_model(response["result"]["content"])
else:
    use(response["result"])
```

**只检查 `error` 分支的客户端，会把工具失败当成功**，然后把错误文本当答案喂给模型。

**其二：这条线规范自己也划了两版才划清。**

- 2025-06-18：协议错误列表里写着 "Invalid arguments"，工具执行错误列表里写着 "Invalid input data"——同一件事挂在两边，边界模糊
- 2025-11-25（SEP-1303）：澄清**输入校验错误应归工具执行错误**，理由就是让模型能自纠
- 2026-07-28：清单改写为「Malformed requests（不满足 CallToolRequest schema）」对「Input validation errors（如日期格式、取值越界）」

规范自己走了两版才把这条线划清楚——这本身就说明它不是一条显而易见的线，值得你在设计自己的工具时多想三十秒。

> 看现场：MCP 场景 M4。

### 顺带：MCP 对错误码保留区的二次切分

01 篇第 5 节讲过 `-32000 ~ -32099` 是留给实现的。MCP 2026-07-28 把它又切了一刀：

- `-32000 ~ -32019`：**legacy**，新实现 SHOULD NOT 使用（除 `-32002` 外，接收方 MUST NOT 假设任何含义）
- `-32020 ~ -32099`：**MCP 规范独占**，实现 MUST NOT 发出未定义的码
  - `-32020` HeaderMismatch / `-32021` MissingRequiredClientCapability / `-32022` UnsupportedProtocolVersion
- 旧的 `-32002`（资源未找到）改用 `-32602`

这是「保留区该怎么用」最权威的一个落地范例：**下游协议可以在实现段里再划分区，但绝不会去动 JSON-RPC 自己占的那五个码**（`-32700` 与 `-32600 ~ -32603`）。

---

## 6. 反向沟通：从 sampling 到 MRTR

### Legacy：服务端真的会向客户端发请求

MCP server 往往没有大模型 API Key——它是个查天气的、读文件的小程序。但它有时需要模型能力。于是它**反过来请求客户端**：

```
--> {"method":"tools/call","params":{"name":"summarize",...},"id":8}        客户端发起
<~~ {"method":"sampling/createMessage","params":{...},"id":"srv-1"}         服务端反向请求
--> {"result":{"role":"assistant","content":{...}},"id":"srv-1"}            客户端应答
<-- {"result":{"content":[...],"isError":false},"id":8}                     服务端完成原调用
```

看这四帧的交错：**一次 tools/call 还没返回，管道上就先跑了一个完整的反向调用。** 这在 HTTP 的世界里不可想象，在 JSON-RPC 里只是「id 配对」这个机制的自然推论。

Legacy 时代的三类反向请求：`sampling/createMessage`（借客户端的模型）、`roots/list`（问客户端要文件系统根）、`elicitation/create`（向用户追问）。对应能力由客户端在 initialize 的 capabilities 里声明。

> 看现场：MCP 场景 M5。

### Modern：MRTR——同一件事，不再反向发请求

2026-07-28 明确规定**服务端不发起请求**：

> A binding MUST deliver client-sent requests and notifications to the server, and server-sent responses and notifications to the client. **No other message direction exists** … servers do not initiate JSON-RPC requests and clients do not send JSON-RPC responses.

取而代之的是 **MRTR（Multi Round-Trip Requests）**：服务端把「我还需要什么」装进一个正常的 `result` 里回去。

```json
第一轮
<-- {"result":{"resultType":"input_required",
               "inputRequests":{"ir-1":{"method":"sampling/createMessage","params":{...}}},
               "requestState":"opaque-state-token-7f3a"},"id":9}

第二轮（客户端办完，用新的 id 重发原请求）
--> {"method":"tools/call","params":{"name":"...","arguments":{...},
     "inputResponses":{"ir-1":{...客户端给出的 result 本体...}},
     "requestState":"opaque-state-token-7f3a"},"id":10}
<-- {"result":{"resultType":"complete","content":[...],"isError":false},"id":10}
```

注意 `inputRequests` / `inputResponses` **是「对象（map）」不是数组**：键由服务端自己起名（本例 `"ir-1"`），在这一个请求范围内唯一；`inputResponses` 用同样的键回填，值就是客户端那一侧的 result 本体（`ElicitResult` / `CreateMessageResult` / `ListRootsResult`），不再套一层 `{"id":…, "result":…}`。`inputRequests` 与 `requestState` 都是可选的，但服务端 **MUST** 至少给出其中一个；客户端 **MUST** 原样回传 `requestState`，且 **MUST NOT** 去解析它。

全程仍然是「客户端问、服务端答」的单向骨架。服务端把「刚才办到哪了」铸成一个不透明句柄交给客户端保管，下一轮原样带回——**状态不在服务端**。

这就是无状态的办法与代价：**代价是多一次往返、多一个句柄要设计；换来的是中间任何一跳都不必记住谁欠谁一个回答**，于是负载均衡可以随便打散，Serverless 可以随时回收实例。

> 看现场：MCP 场景 M6。两场并排跑一遍，差别一眼就看出来了。

⚠️ demo 的 `mcp_server.py` / `mcp_client.py` 把 `inputRequests` / `inputResponses` 写成了**数组**（`[{"id":"ir-1", …}]`），与上面的真实 schema（map）不同——那是按 changelog 文字示意写的，只为把「一个 result 里带着请求」这个形状演出来。字段名本身（`resultType` / `inputRequests` / `requestState` / `inputResponses`）与规范一致。要落生产请以官方规范为准。

### 顺带：Modern 还弃用/移除了这些

Roots、Sampling、Logging 三项特性整体标记为 Deprecated（至少 12 个月弃用窗口）；`ping`、`logging/setLevel`、`notifications/roots/list_changed` 已移除。

另外每个 `result` 现在 MUST 带 `resultType`（`"complete"` 或 `"input_required"`），客户端对老服务端省略该字段时 MUST 当作 `"complete"`；列表/读取类结果（`tools/list`、`prompts/list`、`resources/list`、`resources/read`、`resources/templates/list`）另外必填 `ttlMs` 与 `cacheScope`——注意 **`tools/call` 的结果不带这两个**。

`resultType` 是「JSON-RPC 只管消息形状、语义由上层协议加约束」最干净的一个例子：它在 JSON-RPC 眼里只是 `result` 里的一个普通键，在 MCP 眼里是必填项。

### 取消：同一个语义，两种传输给出相反的实现

- **stdio 上**：客户端 MUST 发 `notifications/cancelled`（stdio 是单条共享信道，没有可关的流）
- **Streamable HTTP 上**：反过来——"Closing the SSE response stream **MUST** be treated by the server as cancellation of that request."，该版核心协议在 HTTP 上根本不定义客户端→服务端的取消通知

同一件事，两种传输的做法完全相反。这又一次印证了 01 篇第 7 节那句话：**JSON-RPC 不管连接语义，所以每一种传输都得自己把这块补齐，而且补出来的东西可以完全不一样。**

---

## 7. 回到你自己的项目：ArcReel 这条链路长什么样

讲了半天别人的规范，看看自己代码里的形态。结论可能出乎意料：

**ArcReel 自己的源码里，一个 `jsonrpc` 字面量都没有。**（`git grep -i jsonrpc` 在已跟踪文件里 0 命中。）但它每天都在跑 JSON-RPC。

### 工具是怎么注册的

`server/agent_runtime/sdk_tools/__init__.py:170` 的 `build_arcreel_mcp_server()` 调用 Claude Agent SDK 的 `create_sdk_mcp_server(name="arcreel", version="1.0.0", tools=[...])`，一次性注册 **58** 个进程内工具。单个工具用 SDK 的 `@tool(name, description, input_schema)` 装饰器定义——这三个参数**逐一对应 MCP 规范里 Tool 对象的 `name` / `description` / `inputSchema`**，`input_schema` 就是一份手写的 JSON Schema。

工具返回 `{"content": [{"type": "text", "text": ...}], "is_error": bool}` 的 Python dict。注意这里有一次**字段名转换**：SDK 在 `claude_agent_sdk/__init__.py:520`（`isError=result.get("is_error", False)`）里把 Python 侧的 `is_error` 转成 MCP 线上的驼峰 `isError`，最终序列化进 JSON-RPC 的 `result`。所以第 5 节讲的那条「两类错误」分界，在 ArcReel 的工具里就是 `tool_error()` 与抛异常的区别。

`session_manager.py:1088` 通过 `ClaudeAgentOptions(mcp_servers={"arcreel": arcreel_server})` 注入，`allowed_tools` 里追加通配符 `"mcp__arcreel__*"`——**`mcp__<server名>__<工具名>` 就是 MCP 工具在 Claude 侧的实际命名规则**。

### 消息实际是怎么跑的

这里要诚实：**它确实是 JSON-RPC 消息，但不是一条完整的 MCP stdio 传输通道。**

Claude Code CLI 子进程把一条 JSON-RPC 请求塞进 SDK 自定义的信封发过来：

```json
{"type":"control_request","request_id":"...","request":{"subtype":"mcp_message","server_name":"arcreel","message":{"jsonrpc":"2.0","method":"tools/call",...}}}
```

**外层信封本身不是 JSON-RPC**——它用 `request_id` 而不是 `id`，也没有 `jsonrpc` 字段。SDK 取出 `message` 字段，按 `method` 手工分派，再逐字构造 `{"jsonrpc":"2.0","id":...,"result"/"error":...}` 回去。

这不是在违反规范，恰恰相反：**规范 §1 说它 transport agnostic，就是允许这么干的。** 消息格式是 JSON-RPC，信封和传输可以是私有的。

但代价是真实存在的，SDK 源码注释自己都写了——因为 Python MCP SDK 缺 Transport 抽象（TypeScript 有 `server.connect(transport)`，Python 只有 `server.run(read_stream, write_stream)`），所以只能手工路由。后果：

- 只覆盖 `initialize` / `tools/list` / `tools/call` / `notifications/initialized` **四个** method，其余一律 -32601
- `tools/list` 只输出 `name` / `description` / `inputSchema`，**丢掉了规范里的 `title` 与 `outputSchema`**
- `tools/call` 只回 `content` 与 `isError`，**丢掉了 `structuredContent`**（那是 2025-06-18 的主要新特性）
- `initialize` 响应里 `protocolVersion` **硬编码成 `"2024-11-05"`**（`query.py:591`）

最后一条特别值得记住：**「MCP 规范到哪一版」和「你手里的 SDK 实现到哪一版」是两件完全不同的事。** 现行规范是 2026-07-28，而这个 SDK 自报的是 2024-11-05——中间隔了四个修订版。拿新规范的行为去对老实现的代码，只会把自己绕晕。

还有一处实打实的不合规，就在 `query.py:703-705`，详见 [04-原文勘误.md](04-原文勘误.md) 第五节。

### ArcReel 的 SSE 与 MCP Streamable HTTP：像在哪，不像在哪

ArcReel 有三处 SSE（`assistant.py` 的会话流、`project_events.py` 的项目事件、`tasks.py` 的任务队列流），形态上都是 `EventSourceResponse` + `ServerSentEvent`。它和 MCP 的 Streamable HTTP **看着像，实质不同**：

| | ArcReel SSE | MCP Streamable HTTP |
|---|---|---|
| 上下行 | **两个不同 URL**：下行 `GET .../stream`，上行另发 `POST /sessions/send` | **同一个端点**，POST 一条请求，响应可直接升级成 SSE 流 |
| 请求与流内事件怎么配对 | 靠 URL 路径参数 `session_id` | 靠 JSON-RPC 的 `id` |
| `data` 里装什么 | 应用自定义 JSON，靠 `event` 字段区分类型 | **一律是 JSON-RPC 消息**，不靠 event 名分类 |
| 认证 | `?token=<jwt>` 查询参数 | `Authorization` 头 |

最后一行的原因很具体，也解释了一个 MCP 的隐含约束：**浏览器的 `EventSource` 只会发 GET，而且不能自定义请求头**。所以 ArcReel 的 SSE 认证只能退化成查询参数。而 MCP 反过来：现行版里每一条消息都是**带头的 POST**——`Accept` 要同时列出两种类型、`MCP-Protocol-Version` 必带、`Mcp-Method` 必带（`tools/call` 等还要 `Mcp-Name`），认证走 `Authorization`。这等于说，**MCP Streamable HTTP 的客户端不能是裸浏览器 `EventSource`**，必须是能自己拼 POST 请求头的 HTTP 客户端（浏览器里就是 `fetch` + 手工解析 SSE）。这就是「为什么 MCP 不长成 ArcReel SSE 那个样子」的技术原因。

> 补一句版本归属：Streamable HTTP 那套（2025-03-26 引入，属 Legacy 时代的后半段）还额外依赖 `Last-Event-ID` **请求头**做断线续传，那是同一结论的另一条佐证；但 2026-07-28 已把续传与事件 ID 整个删掉（"Resumable SSE streams via `Last-Event-ID` are not supported."），所以今天再拿续传当理由就挂错版本了——现行的理由是上面那串必带请求头。

（`tasks.py` 那条流确实实现过与 MCP **Legacy** resumability 同构的断线续传——SSE event id + `Last-Event-ID` / `last_event_id` 双入口。但它已标记 `deprecated=True`（`tasks.py:305`），前端改为轮询 `GET /tasks`，现在是只被单测覆盖的历史实现。巧的是 MCP 自己也在 2026-07-28 把这套删了，两边同时退场。拿它做对照可以，别当成在用的东西。）

---

## 8. 一句话收尾

把 01 篇的四件套吃透，MCP 就只剩下三件事要记：

1. **三条减法**：没有批量、id 不许 null、params 只用对象
2. **两类错误**：`error` 给程序看，`result.isError` 给模型看
3. **一条主线**：它加了两年状态，又全部删回无状态——因为**无状态是分布式部署的通行证**

剩下的，去官网查方法名就行了。
