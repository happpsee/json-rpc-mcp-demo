# -*- coding: utf-8 -*-
"""JSON-RPC 2.0 协议核心层 —— 零依赖、传输无关。

这个文件只做一件事：
    把「一段 JSON 文本」翻译成「一次方法调用」，再把返回值翻译回「一段 JSON 文本」。

它完全不知道自己跑在 stdio 管道上、HTTP 上还是 WebSocket 上 —— 这正是规范第 1 节说的
"It is transport agnostic"。同一个 Dispatcher 实例，server_stdio.py 和 server_http.py
会各挂一次，跑出完全一致的行为。这件事本身就是本 demo 想让你看见的第一个结论。

代码里每个判断旁边都标了它对应规范的哪一节（§N），可以对照
《JSON-RPC 2.0 Specification》逐条读。
"""

from __future__ import annotations

import inspect
import json
import threading
from typing import Any, Callable, Dict, List, Optional, Union

# ---------------------------------------------------------------------------
# §4 / §5  协议常量
# ---------------------------------------------------------------------------

VERSION = "2.0"  # §4 jsonrpc 成员 MUST be exactly "2.0"

# §5.1 预定义错误码。-32768 ~ -32000 整段是保留区，不要往里塞业务错误。
PARSE_ERROR = -32700       # 收到的不是合法 JSON
INVALID_REQUEST = -32600   # 是合法 JSON，但不是合法的 Request 对象
METHOD_NOT_FOUND = -32601  # 方法不存在
INVALID_PARAMS = -32602    # 参数对不上
INTERNAL_ERROR = -32603    # 服务端内部炸了

# §5.1 -32000 ~ -32099 这一段规范写的是 "Reserved for implementation-defined
# server-errors" —— 留给「服务端实现层面」的错误（比如鉴权失败、限流），
# 不是留给业务语义错误的。真正的业务错误（订单不存在、余额不足）应该用
# 这个保留区之外的码，例如 1001、2003。本 demo 两种都演示了，见 server_stdio.py。
SERVER_ERROR_MIN = -32099
SERVER_ERROR_MAX = -32000

_DEFAULT_MESSAGES = {
    PARSE_ERROR: "Parse error",
    INVALID_REQUEST: "Invalid Request",
    METHOD_NOT_FOUND: "Method not found",
    INVALID_PARAMS: "Invalid params",
    INTERNAL_ERROR: "Internal error",
}

JsonId = Union[str, int, float, None]


class JsonRpcError(Exception):
    """业务代码往外抛这个，就能精确控制 error 对象的三个字段（§5.1）。"""

    def __init__(self, code: int, message: Optional[str] = None, data: Any = None):
        self.code = int(code)
        self.message = message or _DEFAULT_MESSAGES.get(self.code, "Server error")
        self.data = data
        super().__init__("[%d] %s" % (self.code, self.message))

    def to_object(self) -> Dict[str, Any]:
        obj: Dict[str, Any] = {"code": self.code, "message": self.message}
        if self.data is not None:  # §5.1 data 可省略
            obj["data"] = self.data
        return obj


# ---------------------------------------------------------------------------
# 构造报文：四个工厂函数，就是协议的全部「写」能力
# ---------------------------------------------------------------------------

def make_request(method: str, params: Any = None, id: JsonId = None) -> Dict[str, Any]:
    """§4 请求对象。注意 params 可省略，id 必须有（否则就成通知了）。"""
    req: Dict[str, Any] = {"jsonrpc": VERSION, "method": method}
    if params is not None:
        req["params"] = params
    req["id"] = id
    return req


def make_notification(method: str, params: Any = None) -> Dict[str, Any]:
    """§4.1 通知 = 没有 id 成员的请求。

    划重点：是「没有 id 这个键」，不是「id 的值为 null」。
    很多文章把这两者混为一谈，那是错的 —— 见 04-原文勘误.md。
    """
    req: Dict[str, Any] = {"jsonrpc": VERSION, "method": method}
    if params is not None:
        req["params"] = params
    return req


def make_result(id: JsonId, result: Any) -> Dict[str, Any]:
    """§5 成功响应。result 与 error 互斥，只能出现一个。"""
    return {"jsonrpc": VERSION, "result": result, "id": id}


def make_error(id: JsonId, code: int, message: Optional[str] = None,
               data: Any = None) -> Dict[str, Any]:
    """§5 失败响应。id 必须回填；实在认不出 id 时（解析失败/请求非法）填 null。"""
    return {"jsonrpc": VERSION, "error": JsonRpcError(code, message, data).to_object(), "id": id}


# ---------------------------------------------------------------------------
# 服务端：Dispatcher
# ---------------------------------------------------------------------------

class Dispatcher:
    """方法注册表 + 报文处理机。传输层只要把「收到的一段文本」喂给 handle_raw()。"""

    def __init__(self) -> None:
        self._methods: Dict[str, Callable[..., Any]] = {}

    # -- 注册 ---------------------------------------------------------------

    def method(self, name: Optional[str] = None) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
            self.register(name or fn.__name__, fn)
            return fn
        return deco

    def register(self, name: str, handler: Callable[..., Any], *, _internal: bool = False) -> None:
        # §4 「rpc.」开头的方法名保留给协议内部扩展，业务不许占用。
        # 顺带这也是一道安全闸：method 是客户端完全可控的字符串，
        # 必须白名单派发，绝不能拿它去反射任意对象属性（见 01-概念.md 第 7 节）。
        if name.startswith("rpc.") and not _internal:
            raise ValueError("方法名 %r 占用了 §4 保留的 rpc. 前缀" % name)
        self._methods[name] = handler

    def has(self, name: str) -> bool:
        return name in self._methods

    @property
    def method_names(self) -> List[str]:
        return sorted(self._methods)

    # -- 处理 ---------------------------------------------------------------

    def handle_raw(self, raw: str) -> Optional[str]:
        """收一段文本，吐一段文本；返回 None 表示「按规范这次不该回任何东西」。"""
        try:
            payload = json.loads(raw)
        except ValueError:
            # §7 例：解析都失败了，自然读不出 id，MUST 回填 null
            return _dumps(make_error(None, PARSE_ERROR))

        response = self.handle_payload(payload)
        if response is None:
            return None
        return _dumps(response)

    def handle_payload(self, payload: Any) -> Optional[Any]:
        """已经解析成 Python 对象的报文。单条走 _handle_one，数组走 §6 批量规则。"""
        if isinstance(payload, list):
            # §6 空数组：整个批本身就不是合法请求 ——
            #     此时回的是「一个」响应对象，不是只含一个元素的数组。这个坑很常见。
            if not payload:
                return make_error(None, INVALID_REQUEST)

            responses = []
            for item in payload:
                one = self._handle_one(item)
                if one is not None:
                    responses.append(one)

            # §6 如果批里全是通知，服务端 MUST NOT 返回空数组，而是什么都不返回。
            return responses or None

        return self._handle_one(payload)

    def _handle_one(self, req: Any) -> Optional[Dict[str, Any]]:
        # ---- 第一阶段：先把 id 认出来 -------------------------------------
        #
        # §5 规定：「If there was an error in detecting the id in the Request object
        # (e.g. Parse error/Invalid Request), it MUST be Null.」
        #
        # ⚠️ 这句话是规范里少数几处真歧义之一，两种读法都有人采纳：
        #   读法 A（严格照括号）：只要判定为 Invalid Request，id 一律回 null。
        #   读法 B（照条件句）：只有「认不出 id」时才回 null；认得出就回填。
        # 本实现选读法 B，并在整个函数里**始终如一**地执行它 ——
        # 因为回了 null，客户端就没法把这个错误对到是哪次调用上，排查等于瞎猜。
        # 真正不可接受的是两种读法混着用（同一个函数里一会儿回填一会儿置 null），
        # 那正是 04-原文勘误.md 里挑出的那个 bug。
        if not isinstance(req, dict):
            # 连对象都不是，无从谈起 id → null。规范 §7 的 [1,2,3] 批量例子就是这样。
            return make_error(None, INVALID_REQUEST, data="请求必须是 JSON Object")

        has_id = "id" in req
        req_id = req.get("id")
        # §4 id MUST 是 String / Number / Null。
        # Python 里 bool 是 int 的子类，得显式挡掉，否则 true 会被当成合法 id。
        id_valid = (not has_id) or req_id is None or isinstance(req_id, str) or (
            isinstance(req_id, (int, float)) and not isinstance(req_id, bool))
        if not id_valid:
            return make_error(None, INVALID_REQUEST, data="id 必须是字符串、数字或 null")
        detected = req_id if has_id else None   # 认出来的 id；没有 id 成员就是 null

        # ---- 第二阶段：结构校验 -------------------------------------------
        #
        # 顺序很讲究：**先校验结构，再判断是不是通知**。理由见规范 §7 的这个例子：
        #     --> {"jsonrpc": "2.0", "method": 1, "params": "bar"}
        #     <-- {"jsonrpc": "2.0", "error": {"code": -32600, ...}, "id": null}
        # 它没有 id、长得像通知，服务端照样回了错误 ——
        # 因为报文都不合法，你根本无从确认「作者是不是真的想发通知」，
        # 不能拿通知规则给自己免责。
        if req.get("jsonrpc") != VERSION:
            return make_error(detected, INVALID_REQUEST, data='jsonrpc 成员必须恰好是 "2.0"')

        method = req.get("method")
        if not isinstance(method, str):
            return make_error(detected, INVALID_REQUEST, data="method 成员必须是字符串")

        # ---- 第三阶段：结构合法了，现在才能安心判定通知 ---------------------
        #
        # §4.1「A Notification is a Request object without an "id" member.」
        # 判据是「有没有 id 这个键」，不是「id 的值是不是 null」。
        # 写成 req.get("id") is None 就会把 {"id": null} 误当成通知 —— 经典 bug。
        is_notification = not has_id

        # ---- 第四阶段：参数与派发 -----------------------------------------
        params = req.get("params", None)
        if "params" in req and not isinstance(params, (list, dict)):
            # §4.2 params 若出现，MUST 是 Array（按位置）或 Object（按名字）。
            # 标量 params 属于「不是合法的 Request 对象」，所以判 -32600 而非 -32602。
            return None if is_notification else make_error(
                detected, INVALID_REQUEST, data="params 必须是数组或对象")

        handler = self._methods.get(method)
        if handler is None:
            return None if is_notification else make_error(
                detected, METHOD_NOT_FOUND, data={"method": method})

        try:
            result = _invoke(handler, params)
        except JsonRpcError as exc:
            # 业务主动抛的，原样转成 error 对象
            return None if is_notification else {
                "jsonrpc": VERSION, "error": exc.to_object(), "id": detected}
        except Exception as exc:  # noqa: BLE001  —— 兜底，绝不能让异常穿透传输层
            return None if is_notification else make_error(
                detected, INTERNAL_ERROR, data="%s: %s" % (type(exc).__name__, exc))

        # §4.1 通知处理成功也照样闭嘴。哪怕上面抛了错，客户端也永远不会知道 ——
        #      这就是「通知不可确认」的代价，别拿它传关键业务。
        if is_notification:
            return None

        # §5 result 存在即成功，哪怕它的值就是 null 也算成功
        #    （「result 为 null」和「没有 result 成员」是两回事）
        return make_result(detected, result)


def _dumps(obj: Any) -> str:
    """一帧 = 一行，帧内绝不能出现裸换行。

    json.dumps 会把字符串里的换行转义成 \\n，所以默认就是安全的；
    但如果你手贱加了 indent=2，stdio 传输当场就崩 —— MCP 规范对此有明文禁止。
    """
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _invoke(handler: Callable[..., Any], params: Any) -> Any:
    """把 §4.2 的两种参数结构映射到 Python 调用约定上。

    先用 signature().bind() 试绑，不匹配就抛 -32602 —— 这样 Invalid params
    是「调用前」判出来的，不会把 handler 内部自己抛的 TypeError 误报成参数错误。
    """
    sig = inspect.signature(handler)
    try:
        if params is None:
            bound = sig.bind()
        elif isinstance(params, list):
            bound = sig.bind(*params)          # by-position
        else:
            bound = sig.bind(**params)         # by-name
    except TypeError as exc:
        raise JsonRpcError(INVALID_PARAMS, data=str(exc))
    return handler(*bound.args, **bound.kwargs)


# ---------------------------------------------------------------------------
# 客户端：ResponseRouter
# ---------------------------------------------------------------------------

class ResponseRouter:
    """客户端那一半：发号（id）、记账（未决表）、按 id 认领响应。

    这是 JSON-RPC 与 HTTP 最本质的区别 ——
    HTTP 的「这个响应属于哪个请求」由 TCP 连接的先后顺序隐式决定；
    JSON-RPC 把它显式写进了 id 字段，于是请求可以乱序返回、可以并发在途、
    甚至可以双方同时向对方发起调用（MCP 就是这么干的）。
    """

    def __init__(self, prefix: str = "") -> None:
        self._lock = threading.Lock()
        self._next = 0
        self._prefix = prefix
        self._pending: Dict[Any, "Slot"] = {}

    def new_id(self) -> Union[str, int]:
        with self._lock:
            self._next += 1
            n = self._next
        return "%s%d" % (self._prefix, n) if self._prefix else n

    def register(self, req_id: Any) -> "Slot":
        slot = Slot(req_id)
        with self._lock:
            self._pending[_key(req_id)] = slot
        return slot

    def resolve(self, response: Dict[str, Any]) -> bool:
        """收到一个响应对象，认领对应的未决请求。认领不到返回 False。"""
        key = _key(response.get("id"))
        with self._lock:
            slot = self._pending.pop(key, None)
        if slot is None:
            return False
        slot.fill(response)
        return True

    def pending_count(self) -> int:
        with self._lock:
            return len(self._pending)

    def fail_all(self, reason: str) -> None:
        """连接断了：把所有还在等的请求一次性叫醒，不然调用方会永远卡住。"""
        with self._lock:
            slots = list(self._pending.values())
            self._pending.clear()
        for slot in slots:
            slot.fill(make_error(slot.req_id, INTERNAL_ERROR, data=reason))


def _key(req_id: Any) -> Any:
    # JSON 里 1 和 "1" 是两个不同的 id，做字典键时必须带上类型，否则会串台。
    return (type(req_id).__name__, req_id)


class Slot:
    """一个在途请求的占位符。调用方 wait()，读线程 fill()。"""

    def __init__(self, req_id: Any) -> None:
        self.req_id = req_id
        self._event = threading.Event()
        self._response: Optional[Dict[str, Any]] = None

    def fill(self, response: Dict[str, Any]) -> None:
        self._response = response
        self._event.set()

    def wait(self, timeout: float = 10.0) -> Dict[str, Any]:
        # 规范通篇没有「超时」二字 —— 超时是传输层/客户端的责任，必须自己实现，
        # 否则对端不回你就永远挂着。这是生产环境最常见的一个坑。
        if not self._event.wait(timeout):
            raise TimeoutError("请求 id=%r 等待响应超时（%.1fs）" % (self.req_id, timeout))
        assert self._response is not None
        return self._response

    def result(self, timeout: float = 10.0) -> Any:
        resp = self.wait(timeout)
        if "error" in resp:
            err = resp["error"]
            raise JsonRpcError(err["code"], err.get("message"), err.get("data"))
        return resp.get("result")
