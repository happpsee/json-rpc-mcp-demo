# -*- coding: utf-8 -*-
"""服务端 · HTTP 传输。

注意看 import：业务方法一个字都没改，直接从 methods.py 拿现成的。
换掉的只有「信封怎么送」这一层 —— 这就是规范第 1 节说的 transport agnostic。

HTTP 这一层有三个事实标准，规范本身没写（规范只管报文，不管 HTTP 映射），
但所有成熟实现都这么做，也是手写实现最常翻车的地方：

  1. 请求是通知（服务端本就不该回） → 回 **204 No Content**，响应体为空。
     不是「200 + 空字符串」，更不是「200 + 字面量 null」。
  2. JSON-RPC 层的错误（-32601 方法不存在等） → HTTP 状态码仍然是 **200**。
     因为 HTTP 这一层确实成功地把报文送达并取回了，错误是业务层的事。
     用 404 表示「方法不存在」是把两层语义搅在一起，客户端会无所适从。
  3. Content-Type 是 application/json。

跑法：python3 server_http.py [端口]
"""

from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import methods
from methods import rpc

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 0   # 0 = 让系统挑一个空闲端口

# HTTP 是「一问一答」的：服务端没有一条常开的反向通道，
# 想主动推东西给客户端是做不到的。所以这里不接 emitter。
# MCP 的 Streamable HTTP 传输正是为了补上这个缺口才引入 SSE 的 —— 见 03-MCP传输层.md。
methods.set_emitter(None)
methods.set_log_sink(lambda m: print("[http] %s" % m, file=sys.stderr))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 关掉默认的访问日志，免得刷屏
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8")
        print("[http] --> %s" % body, file=sys.stderr)

        response = rpc.handle_raw(body)   # ← 和 stdio 版本调用的是同一个方法

        if response is None:
            # 事实标准 1：本就不该回任何报文 → 204，空体
            print("[http] <-- 204 No Content（通知，按规范无响应）", file=sys.stderr)
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        data = response.encode("utf-8")
        # 事实标准 2：即使 JSON-RPC 层是 error，HTTP 层也是 200
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        print("[http] <-- 200 %s" % response, file=sys.stderr)

    def do_GET(self):
        # JSON-RPC over HTTP 只用 POST：请求体里已经写清了 method 和 params，
        # 不需要也不应该把语义摊到 URL 路径上（那是 REST 的活）。
        self.send_response(405)
        self.send_header("Allow", "POST")
        self.send_header("Content-Length", "0")
        self.end_headers()


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    real_port = server.server_address[1]
    # 第一行固定是这个，客户端靠它知道该连哪个端口（避免端口被占时连错别人的服务）
    print("PORT=%d" % real_port, file=sys.stderr, flush=True)
    print("[http] JSON-RPC over HTTP 已监听 http://127.0.0.1:%d/" % real_port, file=sys.stderr)
    print("[http] 方法：%s" % ", ".join(rpc.method_names), file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
