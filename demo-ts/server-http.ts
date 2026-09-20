/**
 * 服务端 · HTTP 传输。
 *
 * 注意看 import：业务方法一个字都没改，直接从 methods.ts 拿现成的。
 * 换掉的只有「信封怎么送」这一层 —— 这就是规范 §1 说的 transport agnostic。
 *
 * HTTP 这一层有三个事实标准，规范本身没写（规范只管报文，不管 HTTP 映射）：
 *   1. 请求是通知 → 回 204 No Content，响应体为空。
 *      不是「200 + 空字符串」，更不是「200 + 字面量 null」——
 *      那会让客户端在 JSON.parse('') 上直接抛异常。
 *   2. JSON-RPC 层的错误（-32601 等）→ HTTP 状态码仍然是 200。
 *      因为 HTTP 这一层确实成功地把报文送达并取回了。
 *   3. Content-Type 是 application/json。
 *
 * 跑法：tsx server-http.ts [端口]   端口给 0（默认）就让系统挑一个空闲的。
 */

import * as http from "node:http";
import * as methods from "./methods.ts";
import { rpc } from "./methods.ts";

const PORT = Number(process.argv[2] ?? 0);

// HTTP 是「一问一答」的：服务端没有一条常开的反向通道，
// 想主动推东西给客户端是做不到的。所以这里不接 emitter。
// MCP 的 Streamable HTTP 正是为了补上这个缺口才引入 SSE 的。
methods.setEmitter(null);
methods.setLogSink((m) => process.stderr.write(`[http] ${m}\n`));

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    // JSON-RPC over HTTP 只用 POST：请求体里已经写清了 method 和 params，
    // 不需要也不应该把语义摊到 URL 路径上（那是 REST 的活）。
    res.writeHead(405, { Allow: "POST", "Content-Length": "0" });
    res.end();
    return;
  }

  // 只认 Content-Length 分帧的实现，遇到 HTTP/1.1 合法的 chunked 会读到空体、
  // 把一个内容正确的请求误判成 -32700，更糟的是请求体还留在 socket 里污染下一轮。
  // 这里明确拒绝，而不是装作读到了空 body。
  if (typeof req.headers["transfer-encoding"] === "string") {
    res.writeHead(411, { "Content-Length": "0" });
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    // 字节序列解不成文本，同样属于解析失败 —— 该回 -32700，不是断线。
    const body = Buffer.concat(chunks).toString("utf8");
    process.stderr.write(`[http] --> ${body}\n`);

    void rpc.handleRaw(body).then((response) => {
      if (response === null) {
        // 事实标准 1：本就不该回任何报文 → 204，空体。
        // 注意 204 **不能**带 Content-Length（RFC 9110 §8.6 MUST NOT）。
        process.stderr.write("[http] <-- 204 No Content（通知，按规范无响应）\n");
        res.writeHead(204);
        res.end();
        return;
      }
      const data = Buffer.from(response, "utf8");
      // 事实标准 2：即使 JSON-RPC 层是 error，HTTP 层也是 200
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(data.length) });
      res.end(data);
      process.stderr.write(`[http] <-- 200 ${response}\n`);
    });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  // 第一行固定是这个，客户端靠它知道该连哪个端口（避免端口被占时连错别人的服务）
  process.stderr.write(`PORT=${port}\n`);
  process.stderr.write(`[http] JSON-RPC over HTTP 已监听 http://127.0.0.1:${port}/\n`);
  process.stderr.write(`[http] 方法：${rpc.methodNames.join(", ")}\n`);
});
