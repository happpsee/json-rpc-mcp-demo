# -*- coding: utf-8 -*-
"""客户端 · HTTP 传输。

和 client_stdio.py 对照着看：**发出去的 JSON 一模一样**，
变的只有外面那层 HTTP 信封，以及由此带来的三个差异：

    · 通知不再是「静默」，而是一个 204 空响应
    · 批量调用的价值被放大了：HTTP 一次往返有握手/头部开销，
      合并成一批能实打实省掉往返次数
    · 服务端推不动东西过来 —— 没有反向通道

跑法：python3 client_http.py     （会自己把 server_http.py 拉起来）
"""

from __future__ import annotations

import json
import atexit
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

import wire
from jsonrpc import make_notification, make_request

HERE = os.path.dirname(os.path.abspath(__file__))
URL = ""          # 服务端启动后填入真实端口


def start_server():
    """把服务端拉起来，从它 stderr 的第一行读出系统分配的端口。"""
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, "server_http.py"), "0"],
                            stderr=subprocess.PIPE, text=True, encoding="utf-8",
                            bufsize=1, cwd=HERE)
    first = proc.stderr.readline().strip()
    if not first.startswith("PORT="):
        raise RuntimeError("服务端没报出端口，它说：%r" % first)
    port = int(first.split("=", 1)[1])
    # stderr 必须持续排空，否则管道缓冲写满会把服务端卡死
    threading.Thread(target=lambda: [None for _ in proc.stderr], daemon=True).start()
    return proc, port


def post(payload, raw=None):
    """发一次 HTTP POST，返回 (状态码, 响应体文本)。"""
    body = (raw if raw is not None else wire.compact(payload)).encode("utf-8")
    wire.out((raw if raw is not None else wire.compact(payload)))
    req = urllib.request.Request(URL, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            text = resp.read().decode("utf-8")
            return resp.status, text
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8")


def show(status, text):
    if status == 204 or not text:
        wire.silence("HTTP %d，响应体为空" % status)
    else:
        wire.inp("HTTP %d  %s" % (status, text))
    return text


def main():
    global URL
    proc, port = start_server()
    atexit.register(lambda: proc.terminate())   # 中途抛异常也要收尸
    URL = "http://127.0.0.1:%d/" % port

    print()
    print(wire.bold("  同一套协议，换个信封：JSON-RPC over HTTP"))
    print(wire.dim("  业务方法一行没改（都来自 methods.py），变的只有传输层"))
    print(wire.dim("  服务端监听 %s" % URL))

    wire.scene("H1", "普通调用：HTTP 200 + 响应体", """
        请求体就是那一行 JSON，和 stdio 版完全一致。
        URL 只有一个、方法名写在报文里 —— 这是 RPC 风格，不是 REST 风格。
    """)
    show(*post(make_request("subtract", {"minuend": 42, "subtrahend": 23}, 1)))

    wire.scene("H2", "★ 通知在 HTTP 上长什么样：204 No Content", """
        规范说「服务端 MUST NOT 回复通知」，但 HTTP 这层总得回点什么。
        正确做法是 204 + 空体。常见错误是回「200 + 空字符串」或「200 + null」，
        那会让客户端在 JSON.parse('') 上直接抛异常。
    """)
    show(*post(make_notification("log_event", {"level": "warn", "message": "磁盘快满了"})))
    wire.ok("状态码 204，响应体 0 字节 —— 客户端不该去解析它。")

    wire.scene("H3", "★ JSON-RPC 错误 ≠ HTTP 错误", """
        方法不存在，JSON-RPC 层报 -32601；但 HTTP 层这次传输是成功的，
        所以状态码是 200。别拿 404 去表达「方法不存在」，那是两层语义打架。
    """)
    show(*post(make_request("foo.get", {"name": "myself"}, 2)))
    wire.note("HTTP 状态码描述「信送到了没」，JSON-RPC 错误码描述「事办成了没」。")

    wire.scene("H4", "解析失败也照样 200", """
        请求体不是合法 JSON → -32700，id 为 null，HTTP 仍是 200。
    """)
    show(*post(None, raw='{"jsonrpc": "2.0", "method": "foobar, "params": "bar", "baz]'))

    wire.scene("H5", "批量调用：HTTP 下省掉的是「往返次数」", """
        stdio 是常开管道，批量省的只是几行文本；
        HTTP 每次往返都有连接、头部、鉴权的固定开销，批量的收益要大得多。
        这也是规范 §6 存在的主要动机。
    """)
    t0 = time.time()
    for i in range(3):
        post(make_request("get_user", {"id": 40 + i}, 100 + i))
    serial = time.time() - t0
    wire.note("上面是 3 次独立 POST，耗时 %.1f ms" % (serial * 1000))

    t0 = time.time()
    status, text = post([make_request("get_user", {"id": 40 + i}, 200 + i) for i in range(3)])
    batched = time.time() - t0
    show(status, text)
    wire.ok("一次 POST 拿回 %d 条结果，耗时 %.1f ms" % (len(json.loads(text)), batched * 1000))
    wire.note("本机回环网络差距还不明显；跨公网时，这就是 3 个 RTT 和 1 个 RTT 的差别。")

    wire.scene("H6", "整批都是通知 → 依然是 204", """
        规范 §6 要求此时不返回任何报文，映射到 HTTP 就是 204。
    """)
    show(*post([make_notification("notify_hello", [7]), make_notification("update", [1, 2])]))

    wire.scene("H7", "HTTP 传输缺了什么：服务端没法主动说话", """
        同一个 long_task 方法，在 stdio 上推了 3 条进度通知；
        在这里一条也推不出来 —— 因为 HTTP 没有常开的反向通道。
    """)
    status, text = post(make_request("long_task", {"steps": 3}, 3))
    show(status, text)
    wire.fail("pushed_notifications = 0：方法想推，但传输层递不出去。")
    wire.note("MCP 的 Streamable HTTP 就是为了补这个缺口 ——")
    wire.note("让 POST 的响应可以是一条 SSE 流，服务端就能在同一次响应里陆续吐多帧。")

    wire.scene("H8", "GET 不是 JSON-RPC 的入口", """
        方法名和参数都在请求体里，不该摊到 URL 上。
    """)
    try:
        with urllib.request.urlopen(URL, timeout=5) as r:
            print(r.status)
    except urllib.error.HTTPError as exc:
        wire.inp("HTTP %d，Allow: %s" % (exc.code, exc.headers.get("Allow")))

    print()
    print(wire.bold("━" * 78))
    print(wire.bold("对照结论：报文层一字未改，行为完全一致；"))
    print(wire.bold("传输层决定的只有两件事 —— 「无响应」怎么表达，以及「能不能反向推送」。"))
    print()
    proc.terminate()
    proc.wait(timeout=5)


if __name__ == "__main__":
    main()
