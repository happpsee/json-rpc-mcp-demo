# -*- coding: utf-8 -*-
"""业务方法表 —— 一份方法，两种传输共用。

server_stdio.py 和 server_http.py 都只 import 这个文件。
两边跑出来的协议行为一模一样，差别只在「信封怎么送」。
这就是规范第 1 节 "transport agnostic" 的现场证据。

注意这些函数里没有一行协议代码：没有 jsonrpc 字段、没有 id、没有 error 对象。
协议层（jsonrpc.py）已经把那些全挡干净了，业务只管写普通函数。
"""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, Optional

import jsonrpc
from jsonrpc import Dispatcher, JsonRpcError

rpc = Dispatcher()

# 服务端主动往回推东西的出口。stdio 传输会把它接到 stdout，
# HTTP 传输在没有 SSE 长连接时根本推不出去 —— 这个差异本身就很说明问题。
_emitter: Optional[Callable[[Dict[str, Any]], None]] = None


def set_emitter(fn: Optional[Callable[[Dict[str, Any]], None]]) -> None:
    global _emitter
    _emitter = fn


def emit(frame: Dict[str, Any]) -> bool:
    if _emitter is None:
        return False
    _emitter(frame)
    return True


# ---------------------------------------------------------------------------

@rpc.method("subtract")
def subtract(minuend, subtrahend):
    """规范 §7 的招牌例子。

    同一个函数，两种调用方式都成立：
        params 是数组 [42, 23]                       → 按位置绑定
        params 是对象 {"subtrahend":23,"minuend":42}  → 按名字绑定，顺序无所谓
    后者才是生产环境该用的写法：将来加参数不会震碎老客户端。
    """
    return minuend - subtrahend


@rpc.method("sum")
def sum_(*numbers):
    return sum(numbers)


@rpc.method("get_data")
def get_data():
    return ["hello", 5]


@rpc.method("update")
def update(*values):
    """规范 §7 里的通知例子。它有返回值也没用 —— 通知的响应会被协议层丢掉。"""
    _log("收到通知 update%s，已记录，但不会回任何东西" % (list(values),))
    return "这个返回值永远不会被发出去"


@rpc.method("notify_hello")
def notify_hello(*values):
    _log("收到通知 notify_hello%s" % (list(values),))


@rpc.method("log_event")
def log_event(level, message):
    _log("[%s] %s" % (level, message))


@rpc.method("slow_echo")
def slow_echo(label, seconds):
    """故意睡不同的时长，用来制造「响应顺序 ≠ 请求顺序」。"""
    time.sleep(seconds)
    return {"label": label, "slept": seconds}


@rpc.method("get_user")
def get_user(id):
    """演示两类错误码的分界线。"""
    if not isinstance(id, int) or isinstance(id, bool):
        # 参数类型不对 —— 这是协议层面的事，用规范预定义的 -32602
        raise JsonRpcError(jsonrpc.INVALID_PARAMS, data={"id": id, "expected": "integer"})
    if id == 403:
        # 「未授权」属于服务端实现层面的错误，适合落在 -32000~-32099 保留区
        raise JsonRpcError(-32001, "未授权", data={"need": "token"})
    if id == 999:
        # 「用户不存在」是业务语义，不是服务端故障 → 放在保留区之外
        raise JsonRpcError(1001, "用户不存在", data={"userId": id})
    return {"id": id, "name": "用户%d" % id, "email": "user%d@example.com" % id}


@rpc.method("long_task")
def long_task(steps):
    """演示双向：任务跑一半，服务端主动往回推进度通知。

    这一条说明 JSON-RPC 根本不是「客户端问、服务端答」的单行道。
    连接建立后两端完全对等，谁都可以主动发请求或通知。
    MCP 的进度通知、日志推送、乃至服务端反过来请求客户端做模型采样
    （sampling/createMessage），靠的都是这个性质。
    """
    pushed = 0
    for i in range(1, steps + 1):
        time.sleep(0.12)
        if emit(jsonrpc.make_notification(
                "notifications/progress",
                {"progress": i, "total": steps, "message": "第 %d/%d 步完成" % (i, steps)})):
            pushed += 1
    return {"done": True, "steps": steps, "pushed_notifications": pushed}


@rpc.method("boom")
def boom():
    """未捕获异常 → 协议层兜底成 -32603。异常绝不能穿透到传输层。"""
    raise RuntimeError("这是一个没人处理的内部异常")


@rpc.method("describe")
def describe():
    return {"methods": rpc.method_names}


# ---------------------------------------------------------------------------

_log_sink: Optional[Callable[[str], None]] = None


def set_log_sink(fn: Optional[Callable[[str], None]]) -> None:
    global _log_sink
    _log_sink = fn


def _log(msg: str) -> None:
    if _log_sink:
        _log_sink(msg)
