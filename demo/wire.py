# -*- coding: utf-8 -*-
"""线缆监听器 —— 把两端之间真正流过的每一个字节原样打出来。

整个 demo 的重点不是「调用成功了」，而是「你看见了那一行 JSON」。
规范第 7 节用的就是这套记号，本文件照抄：

    -->  发往服务端的数据
    <--  发往客户端的数据
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def _c(code: str, text: str) -> str:
    return "\033[%sm%s\033[0m" % (code, text) if _COLOR else text


def dim(text: str) -> str:
    return _c("2", text)


def bold(text: str) -> str:
    return _c("1", text)


def cyan(text: str) -> str:
    return _c("36", text)


def green(text: str) -> str:
    return _c("32", text)


def yellow(text: str) -> str:
    return _c("33", text)


def red(text: str) -> str:
    return _c("31", text)


def magenta(text: str) -> str:
    return _c("35", text)


def scene(no: Any, title: str, why: str = "") -> None:
    print()
    print(bold("━" * 78))
    print(bold("场景 %s ｜ %s" % (no, title)))
    if why:
        for line in why.strip().splitlines():
            print(dim("        " + line.strip()))
    print(bold("━" * 78))


def _cut(raw: str, limit=None) -> str:
    if limit and len(raw) > limit:
        return raw[:limit] + dim(" …（省略 %d 字符）" % (len(raw) - limit))
    return raw


def out(raw: str, limit=None) -> None:
    """客户端 → 服务端。"""
    print("  " + cyan("-->") + " " + _cut(raw, limit))


def inp(raw: str, limit=None) -> None:
    """服务端 → 客户端。"""
    print("  " + green("<--") + " " + _cut(raw, limit))


def push(raw: str, limit=None) -> None:
    """服务端主动发来的报文（通知，或 Legacy MCP 里的反向请求）。"""
    print("  " + magenta("<~~") + " " + _cut(raw, limit) + "   " + dim("（服务端主动发来）"))


def silence(note: str) -> None:
    print("  " + dim("<--") + " " + dim("（无任何响应）") + "  " + dim(note))


def note(text: str) -> None:
    for line in text.strip().splitlines():
        print("      " + yellow("· ") + line.strip())


def fail(text: str) -> None:
    print("      " + red("✗ ") + text)


def ok(text: str) -> None:
    print("      " + green("✓ ") + text)


def compact(obj: Any) -> str:
    """序列化成单行 —— stdio 传输里一行就是一帧，帧内不允许出现裸换行。"""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
