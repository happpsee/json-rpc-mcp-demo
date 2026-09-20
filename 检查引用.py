#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查文档里所有 `文件:行号` 引用是否还指向该指的地方。

背景：几篇文档里有上百处 `demo/jsonrpc.py:193` 这样的引用。
只要动一次代码，后面的行号就整体漂掉 —— 这件事在本项目里已经发生过两次。
与其每次靠人眼重核，不如一条命令打出来看。

用法：
    python3 检查引用.py            # 打出每处引用指向的实际代码行
    python3 检查引用.py --brief    # 只报可疑的（越界、空行、纯注释边界）
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
# 形如 demo/jsonrpc.py:193 / jsonrpc.py:226-237 / query.py:703-705
REF = re.compile(r"`?((?:[\w./\-]+/)?[\w\-]+\.py):(\d+)(?:\s*[-–]\s*(\d+))?`?")

# 文档里出现的裸文件名 → 实际路径
BARE = {p.name: p for p in (ROOT / "demo").glob("*.py")}


def resolve(name: str) -> pathlib.Path | None:
    p = ROOT / name
    if p.exists():
        return p
    return BARE.get(pathlib.Path(name).name)


def main() -> int:
    brief = "--brief" in sys.argv
    total = suspicious = unresolved = 0

    for md in sorted(ROOT.glob("*.md")):
        rows = []
        for m in REF.finditer(md.read_text(encoding="utf-8")):
            name, start, end = m.group(1), int(m.group(2)), m.group(3)
            end = int(end) if end else start
            path = resolve(name)
            total += 1

            if path is None:
                # 仓库外的路径（如 .venv 里的 SDK）本脚本不解析，跳过不算错
                if not name.startswith("demo/") and pathlib.Path(name).name not in BARE:
                    unresolved += 1
                    continue

            lines = path.read_text(encoding="utf-8").splitlines()
            if start < 1 or end > len(lines):
                rows.append(("越界", name, start, end, "文件只有 %d 行" % len(lines)))
                suspicious += 1
                continue

            body = [lines[i - 1] for i in range(start, end + 1)]
            first = body[0].strip()
            if not first:
                rows.append(("空行", name, start, end, "首行是空行，引用大概率漂了"))
                suspicious += 1
            elif not brief:
                tail = "  …+%d 行" % (len(body) - 1) if len(body) > 1 else ""
                rows.append(("", name, start, end, first[:88] + tail))

        if rows:
            print("\n── %s " % md.name + "─" * max(0, 60 - len(md.name)))
            for flag, name, s, e, text in rows:
                rng = "%d" % s if s == e else "%d-%d" % (s, e)
                mark = ("⚠ %s " % flag) if flag else "   "
                print("  %s%-18s:%-9s %s" % (mark, name, rng, text))

    print()
    print("共 %d 处引用；可疑 %d 处；未解析（仓库外路径，未检查）%d 处"
          % (total, suspicious, unresolved))
    if unresolved:
        print("注：.venv 里 claude_agent_sdk 的行号本脚本不查，改依赖版本后要手动重核。")
    return 1 if suspicious else 0


if __name__ == "__main__":
    sys.exit(main())
