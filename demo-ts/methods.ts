/**
 * 业务方法表 —— 一份方法，两种传输共用。
 *
 * server.ts 和 server-http.ts 都只 import 这个文件。
 * 两边跑出来的协议行为一模一样，差别只在「信封怎么送」。
 * 这就是规范第 1 节 "transport agnostic" 的现场证据。
 *
 * 注意这些函数里没有一行协议代码：没有 jsonrpc 字段、没有 id、没有 error 对象。
 */

import { Dispatcher, JsonRpcError, INVALID_PARAMS, INTERNAL_ERROR, makeNotification } from "./jsonrpc.ts";

export const rpc = new Dispatcher();

// 服务端主动往回推东西的出口。stdio 传输会把它接到 stdout，
// HTTP 传输在没有 SSE 长连接时根本推不出去 —— 这个差异本身就很说明问题。
type Emitter = (frame: unknown) => void;
let emitter: Emitter | null = null;
let logSink: ((m: string) => void) | null = null;

export const setEmitter = (fn: Emitter | null) => { emitter = fn; };
export const setLogSink = (fn: ((m: string) => void) | null) => { logSink = fn; };
const log = (m: string) => logSink?.(m);

function emit(frame: unknown): boolean {
  if (!emitter) return false;
  emitter(frame);
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 规范 §7 的招牌例子。同一个函数，两种调用方式都成立：
 *   params 是数组 [42, 23]                       → 按位置绑定
 *   params 是对象 {"subtrahend":23,"minuend":42}  → 按名字绑定，顺序无所谓
 * 后者才是生产环境该用的写法：将来加参数不会震碎老客户端。
 *
 * 注意第二个实参 ["minuend","subtrahend"] —— JS 拿不到运行时参数名，
 * by-name 绑定的契约只能这样显式声明出来。
 */
rpc.register("subtract", ["minuend", "subtrahend"], (a: number, b: number) => a - b);

rpc.register("sum", "variadic", (...nums: number[]) => nums.reduce((s, n) => s + n, 0));

rpc.register("get_data", [], () => ["hello", 5]);

/** 规范 §7 里的通知例子。它有返回值也没用 —— 通知的响应会被协议层丢掉。 */
rpc.register("update", "variadic", (...values: unknown[]) => {
  log(`收到通知 update[${values.join(", ")}]，已记录，但不会回任何东西`);
  return "这个返回值永远不会被发出去";
});

rpc.register("notify_hello", "variadic", (...values: unknown[]) => {
  log(`收到通知 notify_hello[${values.join(", ")}]`);
});

rpc.register("log_event", ["level", "message"], (level: string, message: string) => {
  log(`[${level}] ${message}`);
});

/** 故意睡不同的时长，用来制造「响应顺序 ≠ 请求顺序」。 */
rpc.register("slow_echo", ["label", "seconds"], async (label: string, seconds: number) => {
  await sleep(seconds * 1000);
  return { label, slept: seconds };
});

/** 演示两类错误码的分界线。 */
rpc.register("get_user", ["id"], (id: unknown) => {
  if (typeof id !== "number" || !Number.isInteger(id)) {
    // 参数类型不对 —— 这是协议层面的事，用规范预定义的 -32602
    throw new JsonRpcError(INVALID_PARAMS, undefined, { id, expected: "integer" });
  }
  if (id === 403) {
    // 「未授权」属于服务端实现层面的错误，适合落在 -32000~-32099 保留区
    throw new JsonRpcError(-32001, "未授权", { need: "token" });
  }
  if (id === 999) {
    // 「用户不存在」是业务语义，不是服务端故障 → 放在保留区之外
    throw new JsonRpcError(1001, "用户不存在", { userId: id });
  }
  return { id, name: `用户${id}`, email: `user${id}@example.com` };
});

/**
 * 演示双向：任务跑一半，服务端主动往回推进度通知。
 *
 * 这一条说明 JSON-RPC 根本不是「客户端问、服务端答」的单行道。
 * 连接建立后两端完全对等，谁都可以主动发请求或通知。
 */
rpc.register("long_task", ["steps"], async (steps: number) => {
  let pushed = 0;
  for (let i = 1; i <= steps; i++) {
    await sleep(120);
    if (emit(makeNotification("notifications/progress",
      { progress: i, total: steps, message: `第 ${i}/${steps} 步完成` }))) pushed++;
  }
  return { done: true, steps, pushed_notifications: pushed };
});

/** 未捕获异常 → 协议层兜底成 -32603。异常绝不能穿透到传输层。 */
rpc.register("boom", [], () => {
  throw new Error("这是一个没人处理的内部异常");
});

rpc.register("describe", [], () => ({ methods: rpc.methodNames }));

export { INTERNAL_ERROR };
