# -*- coding: utf-8 -*-
"""迷你 MCP Client —— 扮演 AI Agent 那一端，把 MCP 的一生走一遍。

跑法：python3 mcp_client.py

看完这一场你会明白一件事：
    MCP 不是一个「新协议」，它是 JSON-RPC 2.0 加上一份方法命名表和几条加严规定。
    你在 client_stdio.py 里学的每一条，在这里原封不动地用。
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time

import jsonrpc
import wire
from jsonrpc import ResponseRouter, make_notification, make_request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "mcp_server.py")


class McpPeer:
    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1, cwd=HERE)
        self.router = ResponseRouter()
        self.frames = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=lambda: [None for _ in self.proc.stderr], daemon=True).start()

    def _read(self):
        for raw in self.proc.stdout:
            line = raw.strip()
            if not line:
                continue
            self.frames.put(line)
            obj = json.loads(line)
            if "method" not in obj:
                self.router.resolve(obj)
            # 带 method 的（服务端主动发来的请求/通知）留在 frames 队列里，
            # 由 drain_until_response 按到达顺序处理 —— 只为让打印顺序和线缆顺序一致。
            # 真实客户端会直接在这个读线程里应答。

    def handle_server_request(self, req):
        method, req_id = req.get("method"), req.get("id")
        if method == "sampling/createMessage" and req_id is not None:
            prompt = req["params"]["messages"][0]["content"]["text"]
            # 真实场景这里会去调大模型。demo 里假装调了一下。
            fake = "（模拟模型输出）这段话讲的是 JSON-RPC 如何成为 MCP 的地基。"
            self.send(jsonrpc.make_result(req_id, {
                "role": "assistant", "content": {"type": "text", "text": fake},
                "model": "fake-model-1", "stopReason": "endTurn"}))
            return
        if req_id is not None:
            self.send(jsonrpc.make_error(req_id, jsonrpc.METHOD_NOT_FOUND, data={"method": method}))

    def send(self, frame, show=True):
        line = wire.compact(frame)
        if show:
            wire.out(line)
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def call(self, method, params=None):
        req_id = self.router.new_id()
        slot = self.router.register(req_id)
        self.send(make_request(method, params, req_id))
        return slot

    def notify(self, method, params=None):
        self.send(make_notification(method, params))

    def next_frame(self, timeout=5.0):
        try:
            return self.frames.get(timeout=timeout)
        except queue.Empty:
            return None

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.wait(timeout=5)


def drain_until_response(peer, timeout=10.0):
    """打印途中所有反向流量，直到拿到一条真正的响应。"""
    end = time.time() + timeout
    while time.time() < end:
        line = peer.next_frame(timeout=timeout)
        if line is None:
            return None
        obj = json.loads(line)
        if "method" in obj:
            wire.push(line)
            peer.handle_server_request(obj)   # 客户端的回答紧跟其后打印
            continue
        wire.inp(line)
        return obj
    return None


def main():
    print()
    print(wire.bold("  迷你 MCP：一套 JSON-RPC 方法名约定而已"))
    print(wire.dim("  传输 = stdio 换行分隔 JSON（与 MCP 官方 stdio 传输相同）"))
    print(wire.dim("  本场演的是 Legacy 形态（2025-03-26 ~ 2025-11-25 那一代，有握手）"))

    peer = McpPeer()
    time.sleep(0.3)

    # -----------------------------------------------------------------------
    wire.scene("M0", "握手之前什么都不能干", """
        规范里这是 SHOULD 级（客户端在握手完成前 SHOULD NOT 发别的请求），
        本 demo 收严成硬性，好让状态机看得见。
    """)
    peer.call("tools/list")
    wire.inp(peer.next_frame())

    # -----------------------------------------------------------------------
    wire.scene("M1", "握手三步：initialize → result → initialized 通知", """
        注意第三步是**通知**（没有 id），所以服务端一个字都不许回。
        这三帧全都是标准 JSON-RPC 报文，没有任何「MCP 专用语法」。
    """)
    slot = peer.call("initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {"tools": {}, "sampling": {}},   # 客户端声明：我能帮你跑模型
        "clientInfo": {"name": "MiniAgent", "version": "1.0.0"},
    })
    wire.inp(peer.next_frame())
    info = slot.result()
    wire.ok("版本协商结果：%s；服务端是 %s" % (info["protocolVersion"], info["serverInfo"]["name"]))

    peer.notify("notifications/initialized")
    line = peer.next_frame(timeout=0.8)
    if line is None:
        wire.silence("正确：通知不得有响应")
    else:
        wire.inp(line)
        wire.fail("不合规！通知不该有响应")
    wire.note("对照：你项目 .venv 里的 claude_agent_sdk 在这里回了 {\"jsonrpc\":\"2.0\",\"result\":{}}，")
    wire.note("既违反「通知不得回复」，响应里还缺了必填的 id。详见 04-原文勘误.md。")

    # -----------------------------------------------------------------------
    wire.scene("M2", "tools/list：服务端自报家门", """
        inputSchema 就是一份普通的 JSON Schema。
        Agent 拿到它之后，才知道该怎么给这个工具填参数。
    """)
    slot = peer.call("tools/list")
    wire.inp(peer.next_frame(), limit=180)
    for t in slot.result()["tools"]:
        wire.note("%-16s %s" % (t["name"], t["description"]))

    # -----------------------------------------------------------------------
    wire.scene("M3", "tools/call：一次正常调用", "")
    slot = peer.call("tools/call", {"name": "get_weather", "arguments": {"city": "北京"}})
    wire.inp(peer.next_frame())
    wire.ok("isError=%s，内容：%s" % (slot.result()["isError"], slot.result()["content"][0]["text"]))

    # -----------------------------------------------------------------------
    wire.scene("M4", "★ MCP 最重要的一条设计：两类失败走两条路", """
        ① 协议级错误  → 标准 JSON-RPC error 对象
           用于「模型多半修不了」的问题：工具不存在、请求结构不合 schema。
        ② 工具执行错误 → 正常的 result，带 isError: true
           用于「模型看了能自己改参数重试」的问题：除零、查不到、外部 API 挂了。

        官方理由原话：工具执行错误 contains actionable feedback that language
        models can use to self-correct and retry with adjusted parameters。
    """)
    wire.note("① 调一个不存在的工具 —— 走 JSON-RPC error：")
    peer.call("tools/call", {"name": "no_such_tool", "arguments": {}})
    wire.inp(peer.next_frame())

    wire.note("② 除数为 0 —— 注意它回的是 result，不是 error：")
    slot = peer.call("tools/call", {"name": "divide", "arguments": {"a": 1, "b": 0}})
    wire.inp(peer.next_frame())
    r = slot.result()
    wire.ok("JSON-RPC 层成功（有 result），业务层失败（isError=%s）" % r["isError"])
    wire.note("工程后果：客户端必须写**两段**判断 ——")
    wire.note("  先看有没有 error 成员（协议级），再看 result.isError（工具级）。")
    wire.note("只检查 error 分支的客户端，会把工具失败当成功，然后把错误文本当答案喂给模型。")

    wire.note("③ 参数形状不对（city 不是字符串）—— 又回到协议级：")
    peer.call("tools/call", {"name": "get_weather", "arguments": {"city": 123}})
    wire.inp(peer.next_frame())
    wire.note("这条线规范自己也划了两版才划清：2025-06-18 把 Invalid arguments 列在协议错误，")
    wire.note("2025-11-25（SEP-1303）才澄清「输入校验错误」应归工具执行错误，好让模型自纠。")

    # -----------------------------------------------------------------------
    wire.scene("M5", "★ Legacy 做法：服务端反过来请求客户端（sampling）", """
        服务端自己没有大模型 API Key，于是它反过来请求**客户端**：
        「拿你的模型跑一下这段 prompt」。

        看下面的帧：一次 tools/call 还没返回，服务端就先发来了一个带 id 的请求，
        客户端回答之后，服务端才把 tools/call 的结果给出来。
        这就是 JSON-RPC 双向对等的实际用法 —— 请求和响应在管道上交错穿行。
    """)
    slot = peer.call("tools/call", {"name": "summarize",
                                    "arguments": {"text": "JSON-RPC 是 MCP 的传输层基础。"}})
    drain_until_response(peer)
    wire.ok(slot.result()["content"][0]["text"])

    # -----------------------------------------------------------------------
    wire.scene("M6", "★ Modern 做法：MRTR —— 同一件事，不再反向发请求", """
        2026-07-28 把 MCP 改成了无状态协议，并明文规定服务端不发起请求。
        于是「我需要客户端帮个忙」不再是一次反向调用，而是一个特殊的 result：

            resultType: "input_required" + inputRequests + requestState

        客户端办完，用**新的 id 重发原请求**，带上 inputResponses 与 requestState。
        全程仍是「客户端问、服务端答」，中间任何一跳都不必记住谁欠谁一个回答 ——
        这就是无状态的办法与代价。
    """)
    slot = peer.call("tools/call", {"name": "summarize_mrtr",
                                    "arguments": {"text": "JSON-RPC 是 MCP 的传输层基础。"}})
    wire.inp(peer.next_frame())
    first = slot.result()
    wire.ok("第一轮 resultType=%s —— 这不是错误，是「我还缺东西」" % first["resultType"])
    ir = first["inputRequests"][0]
    wire.note("服务端要的是：%s" % ir["method"])
    wire.note("它还给了一个不透明句柄 requestState=%s，让客户端替它保管状态。" % first["requestState"])

    answer = {"id": ir["id"], "result": {"role": "assistant", "content": {
        "type": "text", "text": "（模拟模型输出）这段话讲的是 JSON-RPC 如何成为 MCP 的地基。"}}}
    slot2 = peer.call("tools/call", {
        "name": "summarize_mrtr",
        "arguments": {"text": "JSON-RPC 是 MCP 的传输层基础。"},
        "inputResponses": [answer],
        "requestState": first["requestState"],
    })
    wire.inp(peer.next_frame())
    wire.ok(slot2.result()["content"][0]["text"])
    wire.note("对比 M5：管道上再没有出现过「服务端 → 客户端的请求」这种帧。")

    # -----------------------------------------------------------------------
    wire.scene("M7", "MCP 对 JSON-RPC 做的三条「减法」", """
        MCP 用了 JSON-RPC，但不是全部的 JSON-RPC。它砍掉了三样东西：
    """)
    wire.note("① 删批量：2025-03-26 还要求必须支持接收 batch，2025-06-18 整条移除，至今未恢复。")
    peer.send([make_request("tools/list", {}, 900), make_request("tools/list", {}, 901)])
    line = peer.next_frame(timeout=2)
    wire.inp(line, limit=150) if line else wire.silence("")
    wire.note("   本 demo 的协议层是按纯 JSON-RPC 写的，所以它照样处理了 ——")
    wire.note("   但真正的 MCP server 不会接受这一帧。照着 JSON-RPC 规范写 MCP，这里必踩空。")
    wire.note("② 禁 null id：JSON-RPC 允许 id 为 null，MCP 明文「Unlike base JSON-RPC,")
    wire.note("   the ID MUST NOT be null」，并且同一会话内不得复用 id。")
    wire.note("③ 只用具名参数：JSON-RPC 的 params 可以是数组，MCP 的 params 恒为对象。")

    print()
    print(wire.bold("━" * 78))
    print(wire.bold("结论：把 JSON-RPC 的四件套吃透，MCP 就只剩下「查文档看方法名」这点事了。"))
    print(wire.dim("本场景演的是 Legacy（有握手）+ Modern（MRTR）两种形态的对照；"))
    print(wire.dim("现行版本 2026-07-28 的完整差异见 03-MCP传输层.md。"))
    print()
    peer.close()


if __name__ == "__main__":
    main()
