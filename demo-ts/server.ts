/**
 * 服务端 · stdio 传输（换行分隔 JSON / NDJSON）。
 *
 * 这就是 MCP 本地 server 的真实形态：没有端口、没有 URL、没有 TLS。
 * 父进程把它当子进程拉起来，两根管子一插就开始说话：
 *
 *     stdin   ← 对端发来的报文，一行一帧
 *     stdout  → 我发出的报文，一行一帧
 *     stderr  → 日志。**绝不能往 stdout 写日志**，那会当场污染协议流。
 *
 * 跑法：通常不用手动跑，由 client.ts 作为子进程拉起。
 */

import * as readline from "node:readline";
import * as methods from "./methods.ts";
import { rpc } from "./methods.ts";

/** 日志走 stderr。这条纪律在 MCP 的 stdio 传输里是硬性要求。 */
function log(msg: string): void {
  process.stderr.write(`[server] ${msg}\n`);
}

function writeFrame(line: string): void {
  // Node 的 stdout 写入天然是有序的，不像 Python 多线程那样需要显式加锁；
  // 但「一帧必须整行写出去」这条约束是一样的 —— 绝不能分两次 write 一帧。
  process.stdout.write(line + "\n");
}

/** 服务端主动往对端推一帧（通知 / 反向请求）。 */
function emit(frame: unknown): void {
  writeFrame(JSON.stringify(frame));
}

async function serveLine(line: string): Promise<void> {
  log(`收到帧：${line}`);
  const response = await rpc.handleRaw(line);
  if (response === null) {
    // §4.1 / §6：通知、以及全是通知的批量，服务端 MUST NOT 回复。
    log("按规范本帧无需响应（通知 / 全通知批量）");
    return;
  }
  writeFrame(response);
  log(`已发出：${response}`);
}

function main(): void {
  methods.setEmitter(emit);        // stdio 传输有反向通道，把出口接上
  methods.setLogSink(log);
  log(`已就绪，等待 stdin 上的换行分隔 JSON。注册方法：${rpc.methodNames.join(", ")}`);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    // 不 await：每帧各自跑各自的，慢请求不堵后面的快请求，
    // 于是响应自然乱序返回 —— 而客户端靠 id 照样认得回去（见客户端场景 9）。
    void serveLine(line).catch((e) => log(`处理帧时炸了：${e}`));
  });
  rl.on("close", () => log("stdin 已关闭，退出"));
}

main();
