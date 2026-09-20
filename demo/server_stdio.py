# -*- coding: utf-8 -*-
"""服务端 · stdio 传输（换行分隔 JSON / NDJSON）。

这就是 MCP 本地 server 的真实形态：没有端口、没有 URL、没有 TLS。
父进程把它当子进程拉起来，两根管子一插就开始说话：

    stdin   ← 对端发来的报文，一行一帧
    stdout  → 我发出的报文，一行一帧
    stderr  → 日志。**绝不能往 stdout 写日志**，那会当场污染协议流。

跑法：通常不用手动跑，由 client_stdio.py 作为子进程拉起。
     想手动玩：python3 server_stdio.py  然后一行一行粘 JSON 进去。
"""

from __future__ import annotations

import json
import sys
import threading

import methods
from methods import rpc

# stdout 是共享资源：多个工作线程会同时想往外写。
# 一帧必须原子地整行写出去，否则两帧会交错成一行乱码。
_write_lock = threading.Lock()


def log(msg: str) -> None:
    """日志走 stderr。这条纪律在 MCP 的 stdio 传输里是硬性要求。"""
    sys.stderr.write("[server] %s\n" % msg)
    sys.stderr.flush()


def write_frame(line: str) -> None:
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def emit(frame: dict) -> None:
    """服务端主动往对端推一帧（通知 / 反向请求）。"""
    write_frame(json.dumps(frame, ensure_ascii=False, separators=(",", ":")))


def serve_line(line: str) -> None:
    log("收到帧：%s" % line)
    response = rpc.handle_raw(line)
    if response is None:
        # §4.1 / §6：通知、以及全是通知的批量，服务端 MUST NOT 回复。
        log("按规范本帧无需响应（通知 / 全通知批量）")
        return
    write_frame(response)
    log("已发出：%s" % response)


def main() -> None:
    # stdio 传输的编码必须两端说死。子进程的 stdout 默认按 locale 编码，
    # 中文 Windows 上是 cp936，而父进程按 UTF-8 读 —— 所有含中文的帧当场乱码。
    # MCP 规范对此有明文：JSON-RPC messages MUST be UTF-8 encoded.
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8")  # Python 3.7+

    methods.set_emitter(emit)          # stdio 传输有反向通道，把出口接上
    methods.set_log_sink(log)
    log("已就绪，等待 stdin 上的换行分隔 JSON。注册方法：%s" % ", ".join(rpc.method_names))
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        # 每帧开一个线程：慢请求不会堵住后面的快请求，
        # 于是响应自然乱序返回 —— 而客户端靠 id 照样认得回去（见客户端场景 9）。
        threading.Thread(target=serve_line, args=(line,), daemon=True).start()
    log("stdin 已关闭，退出")


if __name__ == "__main__":
    main()
