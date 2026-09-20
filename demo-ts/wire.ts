/**
 * 线缆监听器 —— 把两端之间真正流过的每一个字节原样打出来。
 *
 * 整个 demo 的重点不是「调用成功了」，而是「你看见了那一行 JSON」。
 * 规范第 7 节用的就是这套记号，本文件照抄：
 *     -->  发往服务端的数据
 *     <--  发往客户端的数据
 */

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = (s: string) => c("2", s);
export const bold = (s: string) => c("1", s);
export const cyan = (s: string) => c("36", s);
export const green = (s: string) => c("32", s);
export const yellow = (s: string) => c("33", s);
export const red = (s: string) => c("31", s);
export const magenta = (s: string) => c("35", s);

function cut(raw: string, limit?: number): string {
  if (limit && raw.length > limit) {
    return raw.slice(0, limit) + dim(` …（省略 ${raw.length - limit} 字符）`);
  }
  return raw;
}

export function scene(no: string | number, title: string, why = ""): void {
  console.log();
  console.log(bold("━".repeat(78)));
  console.log(bold(`场景 ${no} ｜ ${title}`));
  for (const line of why.trim().split("\n")) {
    if (line.trim()) console.log(dim("        " + line.trim()));
  }
  console.log(bold("━".repeat(78)));
}

/** 客户端 → 服务端 */
export const out = (raw: string, limit?: number) => console.log("  " + cyan("-->") + " " + cut(raw, limit));
/** 服务端 → 客户端 */
export const inp = (raw: string, limit?: number) => console.log("  " + green("<--") + " " + cut(raw, limit));
/** 服务端主动发来的报文（通知，或 Legacy MCP 里的反向请求） */
export const push = (raw: string, limit?: number) =>
  console.log("  " + magenta("<~~") + " " + cut(raw, limit) + "   " + dim("（服务端主动发来）"));

export const silence = (note = "") =>
  console.log("  " + dim("<--") + " " + dim("（无任何响应）") + (note ? "  " + dim(note) : ""));

export const note = (text: string) => {
  for (const line of text.trim().split("\n")) console.log("      " + yellow("· ") + line.trim());
};
export const ok = (text: string) => console.log("      " + green("✓ ") + text);
export const fail = (text: string) => console.log("      " + red("✗ ") + text);

/** 序列化成单行 —— stdio 传输里一行就是一帧，帧内不允许出现裸换行。 */
export const compact = (obj: unknown): string => JSON.stringify(obj);
