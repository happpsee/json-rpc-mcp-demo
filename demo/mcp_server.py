# -*- coding: utf-8 -*-
"""迷你 MCP Server —— 在 jsonrpc.py 这套协议层之上，只加了「方法名的约定」。

看清楚：这个文件没有 import 任何 MCP 库，也没写一行新的协议代码。
所谓 MCP，在传输这一层就是「一套约定好名字的 JSON-RPC 方法」而已：

    initialize                 握手，交换协议版本与能力
    notifications/initialized  客户端宣布握手完成（通知，无回复）
    tools/list                 我这有哪些工具
    tools/call                 调用其中一个
    sampling/createMessage     ← 方向相反：服务端反过来请求客户端

传输仍然是 stdio 上的换行分隔 JSON —— 和 MCP 官方 stdio 传输一模一样。

本 demo 演的是 Legacy 形态（2025-06-18 / 2025-11-25 那一代，有握手、有会话）。
最新的 2026-07-28 取消了握手、改成无状态，差异见 03-MCP传输层.md。
"""

from __future__ import annotations

import json
import sys
import threading

import jsonrpc
from jsonrpc import Dispatcher, JsonRpcError, ResponseRouter

PROTOCOL_VERSION = "2025-06-18"

rpc = Dispatcher()
router = ResponseRouter(prefix="srv-")   # 服务端自己也要发请求，所以它也有一张未决表
_write_lock = threading.Lock()
_state = {"initialized": False, "client": None}


def log(msg):
    sys.stderr.write("[mcp-server] %s\n" % msg)
    sys.stderr.flush()


def write_frame(obj):
    with _write_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def ask_client(method, params, timeout=10.0):
    """★ 服务端反过来向客户端发起一次请求，并等它的响应。

    这在 HTTP 的世界里是不可想象的（服务端怎么给浏览器发请求？），
    但在 JSON-RPC 里它和正向调用是同一套报文结构，只是方向反过来。
    MCP 的 sampling（借用客户端的大模型）、roots（问客户端要文件根）、
    elicitation（向用户追问）全靠这个能力。
    """
    req_id = router.new_id()
    slot = router.register(req_id)
    write_frame(jsonrpc.make_request(method, params, req_id))
    log("↑ 反向请求 %s id=%s，等客户端回话" % (method, req_id))
    return slot.result(timeout=timeout)


# ---------------------------------------------------------------------------
# MCP 生命周期
# ---------------------------------------------------------------------------

@rpc.method("initialize")
def initialize(protocolVersion=None, capabilities=None, clientInfo=None, **_ignored):
    """握手第 ① 步。注意版本协商：认得就原样回，不认得就回自己支持的版本。"""
    _state["client"] = clientInfo
    log("握手请求来自 %s，它说协议版本 %s" % (clientInfo, protocolVersion))
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {"tools": {"listChanged": True}, "logging": {}},
        "serverInfo": {"name": "MiniWeatherServer", "version": "0.1.0"},
        "instructions": "一个只有三个工具的教学用 MCP server。",
    }


@rpc.method("notifications/initialized")
def initialized(**_ignored):
    """握手第 ③ 步。这是**通知**（客户端发来时不带 id），所以绝不能有响应。

    协议层会自动把返回值丢掉 —— 这正是很多手写实现翻车的地方。
    顺带一提：你项目 .venv 里的 claude_agent_sdk 就写错了这一条，
    它给这条通知回了 {"jsonrpc":"2.0","result":{}}（连 id 都没有）。见 04-原文勘误.md。
    """
    _state["initialized"] = True
    log("握手完成，可以正常干活了")


def _require_init():
    if not _state["initialized"]:
        # 规范里这是 SHOULD 级（客户端 SHOULD NOT 在握手前发别的请求），
        # 本 demo 收严成硬性，好让状态机看得见。
        raise JsonRpcError(-32002, "尚未完成 initialize 握手", data={"need": "initialize"})


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "name": "get_weather",
        "description": "查询某个城市今天的天气",
        "inputSchema": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "城市名"}},
            "required": ["city"],
        },
    },
    {
        "name": "divide",
        "description": "两数相除（用来演示「工具执行错误」）",
        "inputSchema": {
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
            "required": ["a", "b"],
        },
    },
    {
        "name": "summarize",
        "description": "概括一段文字（Legacy 做法：服务端反过来请求客户端的大模型）",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "summarize_mrtr",
        "description": "同样是概括，但用 2026-07-28 的 MRTR 做法（服务端不发请求，只返回「我还需要什么」）",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
]

_WEATHER = {"北京": "晴，25°C，湿度 45%", "上海": "多云，28°C，湿度 70%"}


@rpc.method("tools/list")
def tools_list(cursor=None, **_ignored):
    _require_init()
    return {"tools": TOOLS}


@rpc.method("tools/call")
def tools_call(name=None, arguments=None, inputResponses=None,
               requestState=None, **_ignored):
    """★ MCP 最重要的一条设计：两类失败，走两条完全不同的路。

    ① 协议级错误  → 抛 JsonRpcError，变成标准的 JSON-RPC error 对象。
       用于「模型多半修不了」的问题：工具不存在、请求结构不合 schema。
    ② 工具执行错误 → 正常返回 result，但带 isError: true，错误文本放 content 里。
       用于「模型看了能自己改参数重试」的问题：除零、日期格式错、取值越界、外部 API 挂了。

    官方的理由写得很直白：工具执行错误 "contains actionable feedback that language
    models can use to self-correct and retry with adjusted parameters"。
    所以客户端 SHOULD 把 ② 交给模型看，而 ① 交给模型基本没用。

    把「除以零」写成 JSON-RPC error，模型就只看到一个冷冰冰的协议错误，
    无从知道自己该改哪个参数 —— 这是接 MCP 时最常见的一个设计失误。
    """
    _require_init()
    arguments = arguments or {}

    tool = next((t for t in TOOLS if t["name"] == name), None)
    if tool is None:
        # ① 协议级：工具根本不存在。官方示例用的就是 -32602。
        raise JsonRpcError(jsonrpc.INVALID_PARAMS, "Unknown tool", data={"tool": name})

    if name == "get_weather":
        city = arguments.get("city")
        if not isinstance(city, str):
            # ① 协议级：连 inputSchema 的形状都不对
            raise JsonRpcError(jsonrpc.INVALID_PARAMS, "city 必须是字符串")
        if city not in _WEATHER:
            # ② 工具执行错误：形状对，就是查不到。模型看得懂，可以换个城市重试。
            return {
                "content": [{"type": "text", "text": "没有「%s」的天气数据，可选：%s"
                             % (city, "、".join(_WEATHER))}],
                "isError": True,
            }
        return {"content": [{"type": "text", "text": "%s今日天气：%s" % (city, _WEATHER[city])}],
                "isError": False}

    if name == "divide":
        a, b = arguments.get("a"), arguments.get("b")
        if b == 0:
            # ② 工具执行错误：模型看到这句话就知道该把 b 换掉
            return {"content": [{"type": "text", "text": "除数不能为 0，请换一个 b 再试"}],
                    "isError": True}
        return {"content": [{"type": "text", "text": str(a / b)}], "isError": False}

    if name == "summarize":
        # ★ 干活干到一半，反过来请求客户端：「借你的大模型用一下」
        reply = ask_client("sampling/createMessage", {
            "messages": [{"role": "user", "content": {
                "type": "text", "text": "用一句话概括：" + str(arguments.get("text"))}}],
            "maxTokens": 100,
        })
        return {"content": [{"type": "text", "text": "（由客户端的模型生成）" + reply["content"]["text"]}],
                "isError": False}

    if name == "summarize_mrtr":
        # ★ MRTR（Multi Round-Trip Requests）—— 2026-07-28 起取代反向请求的做法。
        #
        # 服务端**不再发起自己的 JSON-RPC 请求**（现行 MCP 明文禁止：
        # 「servers do not initiate requests」），改成把「我还需要什么」
        # 装进一个正常的 result 里回去，让客户端去办，办完**带着答案重发原请求**。
        # 这样整条链路始终是「客户端发请求、服务端发响应」的单向骨架，
        # 于是 MCP 可以变成无状态的 —— 中间任何一跳都不必记住谁欠谁一个回答。
        #
        # ⚠️ 诚实说明：下面的字段位置是按官方 changelog 对 MRTR 的描述**示意**写的，
        #    未与 2026-07-28 的 schema 逐字比对。要落生产请以官方规范为准。
        if not inputResponses:
            return {
                "resultType": "input_required",          # ← 不是 "complete"
                "inputRequests": [{
                    "id": "ir-1",
                    "method": "sampling/createMessage",
                    "params": {"messages": [{"role": "user", "content": {
                        "type": "text",
                        "text": "用一句话概括：" + str((arguments or {}).get("text"))}}],
                        "maxTokens": 100},
                }],
                # 服务端把「刚才办到哪了」铸成一个不透明句柄交给客户端保管，
                # 下一轮由客户端原样带回 —— 状态不在服务端，这就是无状态的代价与办法。
                "requestState": "opaque-state-token-7f3a",
            }
        answer = inputResponses[0]["result"]["content"]["text"]
        return {
            "resultType": "complete",
            "content": [{"type": "text", "text": "（第二轮返回，凭 requestState=%s）%s"
                         % (requestState, answer)}],
            "isError": False,
        }

    raise JsonRpcError(jsonrpc.INTERNAL_ERROR, "工具已登记但没实现：%s" % name)


# ---------------------------------------------------------------------------
# 传输：一行一帧，请求去分发，响应去认领
# ---------------------------------------------------------------------------

def handle_line(line):
    try:
        obj = json.loads(line)
    except ValueError:
        write_frame(jsonrpc.make_error(None, jsonrpc.PARSE_ERROR))
        return

    # 这一步是「对等端」的标志：收到的东西既可能是对方的请求，
    # 也可能是对方对我先前那次反向请求的回答。
    if isinstance(obj, dict) and "method" not in obj:
        if not router.resolve(obj):
            log("收到一个没人认领的响应：%s" % line)
        return

    out = rpc.handle_payload(obj)
    if out is not None:
        write_frame(out)


def main():
    log("已就绪（协议版本 %s），等待 initialize" % PROTOCOL_VERSION)
    for raw in sys.stdin:
        line = raw.strip()
        if line:
            threading.Thread(target=handle_line, args=(line,), daemon=True).start()
    log("退出")


if __name__ == "__main__":
    main()
