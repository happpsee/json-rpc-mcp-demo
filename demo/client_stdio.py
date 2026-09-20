# -*- coding: utf-8 -*-
"""客户端 —— 把服务端当子进程拉起来，然后演一遍两端的完整对话。

跑法：
    python3 client_stdio.py

屏幕上每一行 -->  <--  <~~ 都是真的在管道里流过的字节，
一个字符都没有美化过。这就是「两端怎么用 JSON-RPC 沟通」的全部真相。
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time

import wire
from jsonrpc import ResponseRouter, make_notification, make_request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "server_stdio.py")


class StdioPeer:
    """一端。它既能发请求，也能收对方推过来的东西 —— 两端在协议上是对等的。"""

    def __init__(self, cmd, show_server_log=False):
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            cwd=HERE,
        )
        self.router = ResponseRouter()
        self.frames: "queue.Queue[str]" = queue.Queue()   # 收到的每一行原文，按到达顺序
        self.inbound: "queue.Queue[dict]" = queue.Queue()  # 对端主动发来的请求/通知
        self.server_log = []
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, args=(show_server_log,), daemon=True).start()

    # -- 读 -----------------------------------------------------------------

    def _read_stdout(self):
        for raw in self.proc.stdout:
            line = raw.strip()
            if not line:
                continue
            self.frames.put(line)              # 留给「线缆监听」按到达顺序打印
            try:
                payload = json.loads(line)
            except ValueError:
                continue
            for item in (payload if isinstance(payload, list) else [payload]):
                if not isinstance(item, dict):
                    continue
                if "method" in item:
                    # 对端主动发起的：请求（有 id）或通知（无 id）
                    self.inbound.put(item)
                else:
                    # 响应：靠 id 认领对应的那次在途调用
                    self.router.resolve(item)
        self.router.fail_all("对端已关闭管道")

    def _read_stderr(self, echo):
        for raw in self.proc.stderr:
            self.server_log.append(raw.rstrip())
            if echo:
                sys.stderr.write(wire.dim(raw))

    # -- 写 -----------------------------------------------------------------

    def send_raw(self, text: str) -> None:
        """发一行原始文本。故意留这个口子，因为要演示「发非法 JSON 会怎样」。"""
        wire.out(text)
        self.proc.stdin.write(text + "\n")
        self.proc.stdin.flush()

    def send(self, frame) -> None:
        self.send_raw(wire.compact(frame))

    def call(self, method, params=None):
        """发一个请求，返回一个可以 .result() 的未决槽位。"""
        req_id = self.router.new_id()
        slot = self.router.register(req_id)
        self.send(make_request(method, params, req_id))
        return slot

    def notify(self, method, params=None) -> None:
        self.send(make_notification(method, params))

    # -- 看 -----------------------------------------------------------------

    def next_frame(self, timeout=3.0):
        try:
            return self.frames.get(timeout=timeout)
        except queue.Empty:
            return None

    def expect_silence(self, seconds=0.6, note="") -> bool:
        frame = self.next_frame(timeout=seconds)
        if frame is None:
            wire.silence(note)
            return True
        wire.inp(frame)
        wire.fail("本来不该有响应的，却收到了上面这一帧")
        return False

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.wait(timeout=5)


# ===========================================================================
# 剧本
# ===========================================================================

def main():
    print()
    print(wire.bold("  JSON-RPC 2.0 两端通信实录 · stdio 传输（换行分隔 JSON）"))
    print(wire.dim("  客户端 = 本进程   服务端 = 子进程 server_stdio.py"))
    print(wire.dim("  -->  客户端发出     <--  服务端回应     <~~  服务端主动推送"))

    peer = StdioPeer([sys.executable, SERVER])
    time.sleep(0.3)  # 等服务端把就绪日志写完

    # -----------------------------------------------------------------------
    wire.scene(1, "按位置传参", """
        规范 §7 的招牌例子，一字不改。params 是数组时，参数按顺序绑定。
    """)
    slot = peer.call("subtract", [42, 23])
    wire.inp(peer.next_frame())
    wire.ok("42 - 23 = %s" % slot.result())

    peer.call("subtract", [23, 42])
    wire.inp(peer.next_frame())
    wire.note("换个顺序结果就变号 —— 位置参数的全部含义都藏在「顺序」这个隐式约定里。")

    # -----------------------------------------------------------------------
    wire.scene(2, "按名字传参", """
        同一个方法、同一个服务端函数，params 换成对象就变成按名字绑定。
        两次调用参数顺序相反，结果完全一致。
    """)
    peer.call("subtract", {"subtrahend": 23, "minuend": 42})
    wire.inp(peer.next_frame())
    peer.call("subtract", {"minuend": 42, "subtrahend": 23})
    wire.inp(peer.next_frame())
    wire.ok("顺序无关。生产环境优先用命名参数：以后加参数不会震碎老客户端。")

    # -----------------------------------------------------------------------
    wire.scene(3, "通知：发完就走", """
        通知 = 没有 id 这个键的请求（注意不是 id 为 null）。
        规范 §4.1：服务端 MUST NOT 回复通知。
    """)
    peer.notify("update", [1, 2, 3, 4, 5])
    peer.expect_silence(note="服务端确实收到了，日志在它的 stderr 里")
    peer.notify("log_event", {"level": "info", "message": "用户登录成功"})
    peer.expect_silence()
    wire.note("代价：通知失败了你也不会知道。关键业务别用通知传。")

    # -----------------------------------------------------------------------
    wire.scene("3b", "★ id 为 null ≠ 通知（这是原文那篇文章最大的一处错）", """
        规范 §4.1 的判据是「有没有 id 这个成员」，不是「id 的值是不是 null」。
        所以下面这一帧是**普通请求**，服务端必须回一个 id 为 null 的正常响应。

        Python 里写成 req.get("id") is None 就会把它误判成通知，从此静默吞掉；
        正确写法是 "id" in req。JS 里 id === undefined 恰好对，但很多人写成 == null。
    """)
    peer.send_raw('{"jsonrpc":"2.0","method":"subtract","params":[42,23],"id":null}')
    wire.inp(peer.next_frame())
    wire.ok("回了 result，不是沉默 —— 它是请求，不是通知。")
    wire.note("但请注意副作用：这条响应的 id 也是 null，")
    wire.note("和「服务端根本没认出你是谁」的错误回执长得一模一样，客户端无从区分。")
    wire.note("这正是规范脚注[1]劝阻用 null 当 id 的原因，也是 MCP 干脆把它升级成")
    wire.note("硬性禁令的原因：「Unlike base JSON-RPC, the ID MUST NOT be null.」")

    # -----------------------------------------------------------------------
    wire.scene(4, "方法不存在 → -32601", """
        有 id 的请求，哪怕失败也必须收到一个响应，且 id 原样回填。
    """)
    peer.send(make_request("foobar", None, "1"))
    wire.inp(peer.next_frame())
    wire.ok('id 回的是字符串 "1" 而不是数字 1 —— id 的类型也要原样奉还。')

    # -----------------------------------------------------------------------
    wire.scene(5, "参数对不上 → -32602", """
        协议层在调用业务函数「之前」就用签名把参数校验掉了。
    """)
    peer.call("subtract", {"minuend": 42})
    wire.inp(peer.next_frame())
    peer.call("get_user", {"id": "42"})
    wire.inp(peer.next_frame())
    wire.note("data 字段是给人看的排查线索，规范允许放任意结构。")

    # -----------------------------------------------------------------------
    wire.scene(6, "非法 JSON → -32700，id 必须是 null", """
        连 JSON 都解析不了，自然读不出 id，规范 §5 规定此时 id MUST 为 Null。
    """)
    peer.send_raw('{"jsonrpc": "2.0", "method": "foobar, "params": "bar", "baz]')
    wire.inp(peer.next_frame())

    # -----------------------------------------------------------------------
    wire.scene(7, "无效请求：长得像通知，照样得回", """
        下面这一帧没有 id，看起来是通知，但 method 是数字 1，报文本身不合法。
        规范 §7 明确要求服务端回 -32600 且 id 为 null —— 因为报文都错了，
        你根本无从确认对方「是不是真想发通知」，不能拿通知规则给自己免责。
        这是 90% 的手写实现会写错的一条。
    """)
    peer.send_raw('{"jsonrpc": "2.0", "method": 1, "params": "bar"}')
    wire.inp(peer.next_frame())

    # -----------------------------------------------------------------------
    wire.scene(8, "业务错误 vs 服务端错误：错误码该放哪一段", """
        -32768 ~ -32000 整段是协议保留区，其中 -32000 ~ -32099 规范写的是
        "implementation-defined server-errors"，指服务端实现层面的错误。
        「用户不存在」是业务语义，更适合放在保留区之外。
    """)
    peer.call("get_user", {"id": 42})
    wire.inp(peer.next_frame())
    peer.call("get_user", {"id": 403})
    wire.inp(peer.next_frame())
    wire.note("-32001：鉴权失败，属于服务端实现层面 → 落在保留区，合规。")
    peer.call("get_user", {"id": 999})
    wire.inp(peer.next_frame())
    wire.note("1001：业务语义错误 → 放在保留区之外，不跟协议抢地盘。")
    peer.call("boom")
    wire.inp(peer.next_frame())
    wire.note("未捕获异常被协议层兜成 -32603，异常绝不允许穿透到传输层。")

    # -----------------------------------------------------------------------
    wire.scene(9, "★ id 的真正用途：响应可以乱序回来", """
        一口气发三个请求，服务端故意让它们睡不同的时长。
        响应到达顺序必然与发出顺序不同 —— 而客户端毫不慌张，
        因为「这个响应属于哪次调用」是写在 id 里的，不是靠顺序猜的。

        这就是 JSON-RPC 和 HTTP 最根本的分界：
        HTTP 用连接顺序隐式配对，JSON-RPC 用 id 显式配对。
        显式了，才可能并发在途、才可能双向对等。
    """)
    plan = [("慢-0.45s", 0.45), ("快-0.05s", 0.05), ("中-0.25s", 0.25)]
    slots = []
    for label, secs in plan:
        slots.append((label, peer.call("slow_echo", {"label": label, "seconds": secs})))
    sent_order = [s.req_id for _, s in slots]

    wire.note("三个请求已全部发出且都在途。下面按「到达顺序」打印服务端的回应：")
    arrival_order = []
    for _ in range(len(slots)):
        line = peer.next_frame(timeout=5)
        wire.inp(line)
        arrival_order.append(json.loads(line)["id"])

    wire.note("发出顺序：id " + " → ".join(str(i) for i in sent_order))
    wire.note("到达顺序：id " + " → ".join(str(i) for i in arrival_order))
    if arrival_order != sent_order:
        wire.ok("顺序确实错开了 —— 如果靠顺序配对，这里就已经张冠李戴了。")
    else:
        wire.fail("这次恰好没错开（机器太快），但协议从不保证顺序。")

    wire.note("而客户端侧的未决表按 id 认领，每一条都回到了它自己的那次调用：")
    for label, slot in slots:
        got = slot.result(timeout=5)          # 阻塞等，但早就被读线程填好了
        mark = "✓" if got["label"] == label else "✗"
        wire.note("  %s id=%-3s 发的是 %-10s 收到的是 %s" % (mark, slot.req_id, label, got["label"]))

    # -----------------------------------------------------------------------
    wire.scene(10, "★ 反向推送：服务端也能主动说话", """
        谁说 JSON-RPC 是「客户端问、服务端答」的单行道？
        连接一旦建立，两端就是完全对等的：服务端同样可以发请求和通知。
        MCP 的进度通知、日志推送、以及服务端反过来请求客户端采样
        （sampling/createMessage），靠的全是这个性质。
    """)
    slot = peer.call("long_task", {"steps": 3})
    pushed = 0
    final = None
    deadline = time.time() + 6
    while time.time() < deadline:
        line = peer.next_frame(timeout=2)
        if line is None:
            break
        obj = json.loads(line)
        if "method" in obj:
            wire.push(line)
            pushed += 1
        else:
            wire.inp(line)
            final = obj
            break
    wire.ok("任务执行中服务端主动推了 %d 条通知（无 id，不需要回应），最后才给出带 id 的结果。" % pushed)
    if final:
        wire.note("注意进度通知没有 id，所以客户端不必、也不能回应它们。")

    # -----------------------------------------------------------------------
    wire.scene(11, "批量调用：一次往返干完六件事", """
        规范 §6 / §7 的经典批量例子，原样复刻。这一批里混了：
          · 两个正常调用      · 一个通知（不会有响应）
          · 一个非法元素 {"foo":"boo"}   · 一个不存在的方法
        服务端逐个独立处理，返回一个数组。
    """)
    batch = [
        make_request("sum", [1, 2, 4], "1"),
        make_notification("notify_hello", [7]),
        make_request("subtract", [42, 23], "2"),
        {"foo": "boo"},
        make_request("foo.get", {"name": "myself"}, "5"),
        make_request("get_data", None, "9"),
    ]
    peer.send(batch)
    line = peer.next_frame(timeout=5)
    wire.inp(line)
    resp = json.loads(line)
    wire.ok("发出 6 个元素，收到 %d 条响应 —— 少的那条正是通知。" % len(resp))
    wire.note('非法元素 {"foo":"boo"} 变成了一条 id 为 null 的 -32600，它不会拖垮同批其他调用。')
    wire.note("每条都要单独检查 error；「有一个失败就整批失败」是错误的心智模型。")

    # -----------------------------------------------------------------------
    wire.scene(12, "整批都是通知 → 一个字节都不回", """
        规范 §6：此时服务端 MUST NOT 返回空数组 []，而是什么都不返回。
        这两者在 HTTP 上是不同的响应体，客户端解析逻辑完全不同。
    """)
    peer.send([make_notification("notify_sum", [1, 2, 4]), make_notification("notify_hello", [7])])
    peer.expect_silence(note="连 [] 都不能回")

    # -----------------------------------------------------------------------
    wire.scene(13, "空数组 [] → 回「一个」错误对象，不是数组", """
        这是最容易写错的边界：批量请求的返回通常是数组，
        但 [] 本身就不是一个合法的批量请求，所以回的是单个响应对象。
    """)
    peer.send_raw("[]")
    line = peer.next_frame()
    wire.inp(line)
    wire.ok("收到的是 %s，不是数组。" % ("对象" if isinstance(json.loads(line), dict) else "数组"))

    peer.send_raw("[1]")
    line = peer.next_frame()
    wire.inp(line)
    wire.ok("而 [1] 是「非空但元素非法」的批量，回的就是长度为 1 的数组了。")

    # -----------------------------------------------------------------------
    print()
    print(wire.bold("━" * 78))
    print(wire.bold("对话结束。服务端 stderr 日志（协议流与日志流必须分开，这是 MCP 的硬性要求）："))
    for line in peer.server_log[:6]:
        print(wire.dim("  " + line))
    print(wire.dim("  ... 共 %d 行" % len(peer.server_log)))
    peer.close()
    print()
    print(wire.bold("一句话总结：JSON-RPC 只规定了「信封」长什么样 ——"))
    print(wire.bold("jsonrpc / method / params / id 四件套，外加 result|error 二选一。"))
    print(wire.bold("信封怎么送（stdio、HTTP、WebSocket）它一概不管，这才是它能当 MCP 底座的原因。"))
    print()


if __name__ == "__main__":
    main()
