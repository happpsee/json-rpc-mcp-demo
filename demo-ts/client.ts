/**
 * 客户端 · stdio 传输 —— 把服务端当子进程拉起来，然后演一遍两端的完整对话。
 *
 * 跑法：pnpm stdio      （或 npx tsx client.ts）
 *
 * 屏幕上每一行 -->  <--  <~~ 都是真的在管道里流过的字节，
 * 一个字符都没有美化过。这就是「两端怎么用 JSON-RPC 沟通」的全部真相。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as wire from "./wire.ts";
import {
  ResponseRouter, Slot, makeRequest, makeNotification,
  type JsonId, type Params, type ResponseObject,
} from "./jsonrpc.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "server.ts");

/** 一端。它既能发请求，也能收对方推过来的东西 —— 两端在协议上是对等的。 */
class StdioPeer {
  readonly router = new ResponseRouter();
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly frames: string[] = [];             // 收到的每一行原文，按到达顺序
  private waiters: Array<(l: string | null) => void> = [];
  readonly serverLog: string[] = [];

  constructor() {
    this.proc = spawn(process.execPath, ["--import", "tsx", SERVER], {
      stdio: ["pipe", "pipe", "pipe"], cwd: HERE,
    });

    readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity })
      .on("line", (raw) => {
        const line = raw.trim();
        if (!line) return;
        this.push(line);                               // 留给「线缆监听」按到达顺序打印
        let payload: unknown;
        try { payload = JSON.parse(line); } catch { return; }
        // 一帧可能是批量（场景 11 就会收到一个数组），逐个元素看。
        for (const obj of Array.isArray(payload) ? payload : [payload]) {
          if (typeof obj !== "object" || obj === null) continue;
          if ("method" in obj) continue;               // 对端主动发来的，留给剧本自己处理
          this.router.resolve(obj as ResponseObject);  // 响应：靠 id 认领对应的那次在途调用
        }
      })
      .on("close", () => {
        this.router.failAll("对端已关闭管道");         // 别让调用方白等满一个超时
        this.push(null);
      });

    readline.createInterface({ input: this.proc.stderr, crlfDelay: Infinity })
      .on("line", (l) => this.serverLog.push(l));
  }

  private push(line: string | null): void {
    const w = this.waiters.shift();
    if (w) { w(line); return; }
    if (line !== null) this.frames.push(line);
  }

  /** 发一行原始文本。故意留这个口子，因为要演示「发非法 JSON 会怎样」。 */
  sendRaw(text: string): void {
    wire.out(text);
    this.proc.stdin.write(text + "\n");
  }

  send(frame: unknown): void { this.sendRaw(wire.compact(frame)); }

  /** 发一个请求，返回一个可以 await 的未决槽位。 */
  call(method: string, params?: Params): Slot {
    const id = this.router.newId();
    const slot = this.router.register(id);
    this.send(makeRequest(method, params, id));
    return slot;
  }

  notify(method: string, params?: Params): void { this.send(makeNotification(method, params)); }

  nextFrame(timeoutMs = 3000): Promise<string | null> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onLine);
        resolve(null);
      }, timeoutMs);
      const onLine = (l: string | null) => { clearTimeout(timer); resolve(l); };
      this.waiters.push(onLine);
    });
  }

  async expectSilence(ms = 600, note = ""): Promise<void> {
    const frame = await this.nextFrame(ms);
    if (frame === null) { wire.silence(note); return; }
    wire.inp(frame);
    wire.fail("本来不该有响应的，却收到了上面这一帧");
  }

  close(): void { this.proc.stdin.end(); this.proc.kill(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// 剧本
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log();
  console.log(wire.bold("  JSON-RPC 2.0 两端通信实录 · stdio 传输（换行分隔 JSON）· TypeScript 版"));
  console.log(wire.dim("  客户端 = 本进程   服务端 = 子进程 server.ts"));
  console.log(wire.dim("  -->  客户端发出     <--  服务端回应     <~~  服务端主动推送"));

  const peer = new StdioPeer();
  process.on("exit", () => peer.close());          // 中途抛异常也要收尸，别留孤儿进程
  await new Promise((r) => setTimeout(r, 600));    // 等服务端把就绪日志写完

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(1, "按位置传参", `
    规范 §7 的招牌例子，一字不改。params 是数组时，参数按顺序绑定。
  `);
  const s1 = peer.call("subtract", [42, 23]);
  wire.inp((await peer.nextFrame())!);
  wire.ok(`42 - 23 = ${await s1.result()}`);

  peer.call("subtract", [23, 42]);
  wire.inp((await peer.nextFrame())!);
  wire.note("换个顺序结果就变号 —— 位置参数的全部含义都藏在「顺序」这个隐式约定里。");

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(2, "按名字传参", `
    同一个方法、同一个服务端函数，params 换成对象就变成按名字绑定。
    两次调用参数顺序相反，结果完全一致。
  `);
  peer.call("subtract", { subtrahend: 23, minuend: 42 });
  wire.inp((await peer.nextFrame())!);
  peer.call("subtract", { minuend: 42, subtrahend: 23 });
  wire.inp((await peer.nextFrame())!);
  wire.ok("顺序无关。生产环境优先用命名参数：以后加参数不会震碎老客户端。");
  wire.note("⚠️ TS/JS 特有的代价：运行时拿不到参数名，编译压缩后更没有。");
  wire.note("所以 by-name 绑定的契约必须显式声明 —— 见 methods.ts 里 register 的第二个实参。");
  wire.note("Python 那边靠 inspect.signature 白拿，这是两种语言的真实差别。");

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(3, "通知：发完就走", `
    通知 = 没有 id 这个键的请求（注意不是 id 为 null）。
    规范 §4.1：服务端 MUST NOT 回复通知。
  `);
  peer.notify("update", [1, 2, 3, 4, 5]);
  await peer.expectSilence(600, "服务端确实收到了，日志在它的 stderr 里");
  peer.notify("log_event", { level: "info", message: "用户登录成功" });
  await peer.expectSilence();
  wire.note("代价：通知失败了你也不会知道。关键业务别用通知传。");

  // ───────────────────────────────────────────────────────────────────────
  wire.scene("3b", "★ id 为 null ≠ 通知（这是原文那篇文章最大的一处错）", `
    规范 §4.1 的判据是「有没有 id 这个成员」，不是「id 的值是不是 null」。
    所以下面这一帧是普通请求，服务端必须回一个 id 为 null 的正常响应。

    JS 里写成 id === undefined 恰好是对的，但写成 id == null 就错了 ——
    那会把 {"id": null} 一起吞掉。TS 也救不了你：两者都是合法的 JsonId。
  `);
  peer.sendRaw('{"jsonrpc":"2.0","method":"subtract","params":[42,23],"id":null}');
  wire.inp((await peer.nextFrame())!);
  wire.ok("回了 result，不是沉默 —— 它是请求，不是通知。");
  wire.note("但请注意副作用：这条响应的 id 也是 null，");
  wire.note("和「服务端根本没认出你是谁」的错误回执长得一模一样，客户端无从区分。");
  wire.note("这正是规范脚注[1]劝阻用 null 当 id 的原因，也是 MCP 干脆把它升级成");
  wire.note("硬性禁令的原因：「Unlike base JSON-RPC, the ID MUST NOT be null.」");

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(4, "方法不存在 → -32601", `
    有 id 的请求，哪怕失败也必须收到一个响应，且 id 原样回填。
  `);
  peer.send(makeRequest("foobar", undefined, "1"));
  wire.inp((await peer.nextFrame())!);
  wire.ok('id 回的是字符串 "1" 而不是数字 1 —— id 的类型也要原样奉还。');

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(5, "参数对不上 → -32602", `
    协议层在调用业务函数「之前」就把参数校验掉了。
  `);
  peer.call("subtract", { minuend: 42 });
  wire.inp((await peer.nextFrame())!);
  peer.call("get_user", { id: "42" });
  wire.inp((await peer.nextFrame())!);
  wire.note("data 字段是给人看的排查线索，规范允许放任意结构。");

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(6, "非法 JSON → -32700，id 必须是 null", `
    连 JSON 都解析不了，自然读不出 id，规范 §5 规定此时 id MUST 为 Null。
  `);
  peer.sendRaw('{"jsonrpc": "2.0", "method": "foobar, "params": "bar", "baz]');
  wire.inp((await peer.nextFrame())!);

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(7, "无效请求：长得像通知，照样得回", `
    下面这一帧没有 id，看起来是通知，但 method 是数字 1，报文本身不合法。
    规范 §7 明确要求服务端回 -32600 且 id 为 null —— 因为报文都错了，
    你根本无从确认对方「是不是真想发通知」，不能拿通知规则给自己免责。
    这是 90% 的手写实现会写错的一条。
  `);
  peer.sendRaw('{"jsonrpc": "2.0", "method": 1, "params": "bar"}');
  wire.inp((await peer.nextFrame())!);

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(8, "业务错误 vs 服务端错误：错误码该放哪一段", `
    -32768 ~ -32000 整段是协议保留区，其中 -32000 ~ -32099 规范写的是
    "implementation-defined server-errors"，指服务端实现层面的错误。
    「用户不存在」是业务语义，更适合放在保留区之外。
  `);
  peer.call("get_user", { id: 42 });
  wire.inp((await peer.nextFrame())!);
  peer.call("get_user", { id: 403 });
  wire.inp((await peer.nextFrame())!);
  wire.note("-32001：鉴权失败，属于服务端实现层面 → 落在保留区，合规。");
  peer.call("get_user", { id: 999 });
  wire.inp((await peer.nextFrame())!);
  wire.note("1001：业务语义错误 → 放在保留区之外，不跟协议抢地盘。");
  peer.call("boom");
  wire.inp((await peer.nextFrame())!);
  wire.note("未捕获异常被协议层兜成 -32603，异常绝不允许穿透到传输层。");

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(9, "★ id 的真正用途：响应可以乱序回来", `
    一口气发三个请求，服务端故意让它们睡不同的时长。
    响应到达顺序必然与发出顺序不同 —— 而客户端毫不慌张，
    因为「这个响应属于哪次调用」是写在 id 里的，不是靠顺序猜的。

    这就是 JSON-RPC 和 HTTP 最根本的分界：
    HTTP 用连接顺序隐式配对，JSON-RPC 用 id 显式配对。
    显式了，才可能并发在途、才可能双向对等。
  `);
  const plan: Array<[string, number]> = [["慢-0.45s", 0.45], ["快-0.05s", 0.05], ["中-0.25s", 0.25]];
  const slots = plan.map(([label, secs]) => [label, peer.call("slow_echo", { label, seconds: secs })] as const);
  const sentOrder = slots.map(([, s]) => s.id);

  wire.note("三个请求已全部发出且都在途。下面按「到达顺序」打印服务端的回应：");
  const arrivalOrder: JsonId[] = [];
  for (let i = 0; i < slots.length; i++) {
    const line = (await peer.nextFrame(5000))!;
    wire.inp(line);
    arrivalOrder.push(JSON.parse(line).id);
  }
  wire.note("发出顺序：id " + sentOrder.join(" → "));
  wire.note("到达顺序：id " + arrivalOrder.join(" → "));
  if (JSON.stringify(arrivalOrder) !== JSON.stringify(sentOrder)) {
    wire.ok("顺序确实错开了 —— 如果靠顺序配对，这里就已经张冠李戴了。");
  } else {
    wire.fail("这次恰好没错开（机器太快），但协议从不保证顺序。");
  }
  wire.note("而客户端侧的未决表按 id 认领，每一条都回到了它自己的那次调用：");
  for (const [label, slot] of slots) {
    const got = (await slot.result(5000)) as { label: string };
    wire.note(`  ${got.label === label ? "✓" : "✗"} id=${String(slot.id).padEnd(3)} 发的是 ${label.padEnd(10)} 收到的是 ${got.label}`);
  }

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(10, "★ 反向推送：服务端也能主动说话", `
    谁说 JSON-RPC 是「客户端问、服务端答」的单行道？
    连接一旦建立，两端就是完全对等的：服务端同样可以发请求和通知。
    MCP 的进度通知、日志推送，靠的全是这个性质。
  `);
  const slotLong = peer.call("long_task", { steps: 3 });
  let pushed = 0;
  for (;;) {
    const line = await peer.nextFrame(2000);
    if (line === null) break;
    const obj = JSON.parse(line);
    if ("method" in obj) { wire.push(line); pushed++; continue; }
    wire.inp(line);
    break;
  }
  await slotLong.result();
  wire.ok(`任务执行中服务端主动推了 ${pushed} 条通知（无 id，不需要回应），最后才给出带 id 的结果。`);
  wire.note("注意进度通知没有 id，所以客户端不必、也不能回应它们。");

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(11, "批量调用：一次往返干完六件事", `
    规范 §6 / §7 的经典批量例子，原样复刻。这一批里混了：
      · 三个正常调用    · 一个通知（不会有响应）
      · 一个非法元素 {"foo":"boo"}   · 一个不存在的方法
    服务端逐个独立处理，返回一个数组。
  `);
  peer.send([
    makeRequest("sum", [1, 2, 4], "1"),
    makeNotification("notify_hello", [7]),
    makeRequest("subtract", [42, 23], "2"),
    { foo: "boo" },
    makeRequest("foo.get", { name: "myself" }, "5"),
    makeRequest("get_data", undefined, "9"),
  ]);
  const batchLine = (await peer.nextFrame(5000))!;
  wire.inp(batchLine);
  wire.ok(`数组里 6 个元素，回来 ${JSON.parse(batchLine).length} 条响应 —— 少的那条正是通知。`);
  wire.note('{"foo":"boo"} 连请求都算不上，但照样占了一条 id 为 null 的 -32600。');
  wire.note("每条都要单独检查 error；「有一个失败就整批失败」是错误的心智模型。");

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(12, "整批都是通知 → 一个字节都不回", `
    规范 §6：此时服务端 MUST NOT 返回空数组 []，而是什么都不返回。
  `);
  peer.send([makeNotification("notify_sum", [1, 2, 4]), makeNotification("notify_hello", [7])]);
  await peer.expectSilence(800, "连 [] 都不能回");

  // ───────────────────────────────────────────────────────────────────────
  wire.scene(13, "空数组 [] → 回「一个」错误对象，不是数组", `
    这是最容易写错的边界：批量请求的返回通常是数组，
    但 [] 本身就不是一个合法的批量请求，所以回的是单个响应对象。
  `);
  peer.sendRaw("[]");
  const emptyLine = (await peer.nextFrame())!;
  wire.inp(emptyLine);
  wire.ok(`收到的是 ${Array.isArray(JSON.parse(emptyLine)) ? "数组" : "对象"}，不是数组。`);

  peer.sendRaw("[1]");
  wire.inp((await peer.nextFrame())!);
  wire.ok("而 [1] 是「非空但元素非法」的批量，回的就是长度为 1 的数组了。");

  // ───────────────────────────────────────────────────────────────────────
  console.log();
  console.log(wire.bold("━".repeat(78)));
  console.log(wire.bold("对话结束。服务端 stderr 日志（协议流与日志流必须分开，这是 MCP 的硬性要求）："));
  for (const l of peer.serverLog.slice(0, 5)) console.log(wire.dim("  " + l));
  console.log(wire.dim(`  ... 共 ${peer.serverLog.length} 行`));
  peer.close();
  console.log();
  console.log(wire.bold("一句话总结：JSON-RPC 只规定了「信封」长什么样 ——"));
  console.log(wire.bold("jsonrpc / method / params / id 四件套，外加 result|error 二选一。"));
  console.log(wire.bold("信封怎么送（stdio、HTTP、WebSocket）它一概不管。"));
  console.log();
}

await main();
process.exit(0);
