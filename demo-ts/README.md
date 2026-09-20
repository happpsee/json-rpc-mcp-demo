# TypeScript 版 demo

和 [`../demo/`](../demo/) 的 Python 版**协议行为完全一致**，报文一个字节都不差。
放两份不是为了凑数——同一套规范用两种语言实现，恰好能暴露出哪些东西是协议要求、
哪些只是某个语言的便利或代价。

## 跑

```bash
pnpm install      # 只装 tsx + typescript + @types/node，没有运行时依赖
pnpm stdio        # ① 两端完整对话：14 个场景
pnpm http         # ② 同一套方法换 HTTP 传输
pnpm mcp          # ③ 在同一套协议层上搭一个迷你 MCP
pnpm typecheck    # tsc --noEmit（strict + noUncheckedIndexedAccess）
```

## 文件

| 文件 | 干什么 |
|---|---|
| `jsonrpc.ts` | 协议核心。`Dispatcher`（服务端）+ `ResponseRouter`（客户端），零依赖、传输无关 |
| `methods.ts` | 业务方法表，stdio 与 HTTP 共用一份 |
| `wire.ts` | 线缆打印，`-->` `<--` 记号取自规范 §7 |
| `server.ts` / `client.ts` | stdio 换行分隔 JSON，场景 1–13（含 3b） |
| `server-http.ts` / `client-http.ts` | HTTP 传输，场景 H1–H8 |
| `mcp-server.ts` / `mcp-client.ts` | 迷你 MCP，场景 M0–M7 |

## TS 相对 Python 版的三处真实差别

这三点本身就是内容，不是实现细节。

### ✅ `result` 与 `error` 的互斥可以编进类型系统

规范 §5 说 "both members MUST NOT be included"。Python 版只能在运行时保证，
TS 版用判别联合让它**根本写不出来**：

```ts
interface SuccessResponse { result: unknown; error?: never; id: JsonId }
interface ErrorResponse   { result?: never; error: ErrorObject; id: JsonId }
type ResponseObject = SuccessResponse | ErrorResponse;
```

同理 `id` 只能是 `string | number | null`（§4），也被类型钉死了。

### ❌ JS 没有运行时参数名反射

§4.2 的 by-name 绑定要求「成员名与服务端参数名完全一致，包括大小写」。
Python 靠 `inspect.signature` 白拿参数名，**JS 拿不到**——编译压缩之后更没有。
所以注册方法时必须把参数名显式写出来：

```ts
rpc.register("subtract", ["minuend", "subtrahend"], (a: number, b: number) => a - b);
//                        ↑ 这份契约在 Python 版里是免费的
```

这不是偷懒，是语言的真实代价。任何 JS/TS 的 JSON-RPC 库都得以某种形式付这笔钱
（装饰器、schema、或者干脆放弃 by-name 只收一个 params 对象）。

### ⚖️ 并发模型不同，但协议行为必须一样

Python 版每帧开一个线程、共享 stdout 要加锁；TS 版是单线程事件循环，
`process.stdout.write` 天然有序。但**「一帧必须整行写出去」这条约束是一样的**——
绝不能分两次 write 一帧。两版都在注释里标了这一点。

场景 9（响应乱序返回）在两版里都能复现，因为乱序来自服务端的处理时长差异，
与并发模型无关。这正说明它是协议层面的性质。

## 类型检查开了什么

`tsconfig.json` 里 `strict` + `noUncheckedIndexedAccess`。后者在写这份代码时
真的抓到了一处 bug——按名字绑定时 `spec[i]` 可能是 `undefined`，
而那正好是 §4.2「参数名对不上」该走的分支。
