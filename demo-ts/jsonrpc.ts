/**
 * JSON-RPC 2.0 协议核心层 —— 零依赖、传输无关。
 *
 * 和 Python 版（../demo/jsonrpc.py）是同一套逻辑，但 TypeScript 在两个地方
 * 能做得更好、也有一处做不到，这三点本身就是值得讲的内容：
 *
 *   ✅ 更好之一：`result` 与 `error` 的互斥可以编进类型系统。
 *      §5 说 "both members MUST NOT be included" —— 在 TS 里可以让它**根本写不出来**，
 *      而不是靠运行时检查。见下面的 ResponseObject 判别联合。
 *
 *   ✅ 更好之二：`id` 只能是 String / Number / Null（§4），这条也能用类型钉死。
 *
 *   ❌ 做不到的：JS **没有运行时参数名反射**。Python 那边 `inspect.signature` 白拿，
 *      TS 这边编译后参数名就没了，所以 §4.2 的 by-name 绑定必须让注册方
 *      自己把参数名写出来。这不是偷懒，是语言的真实代价 —— 见 register()。
 *
 * 每个判断旁边标了它对应规范的哪一节（§N）。
 */

// ─── §4 / §5 协议常量 ────────────────────────────────────────────────────────

export const VERSION = "2.0";

/** §5.1 预定义错误码。-32768 ~ -32000 整段是保留区，不要往里塞业务错误。 */
export const PARSE_ERROR = -32700;      // 收到的不是合法 JSON
export const INVALID_REQUEST = -32600;  // 是合法 JSON，但不是合法的 Request 对象
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

const DEFAULT_MESSAGES: Record<number, string> = {
  [PARSE_ERROR]: "Parse error",
  [INVALID_REQUEST]: "Invalid Request",
  [METHOD_NOT_FOUND]: "Method not found",
  [INVALID_PARAMS]: "Invalid params",
  [INTERNAL_ERROR]: "Internal error",
};

// ─── 类型：把规范的约束写进类型系统 ──────────────────────────────────────────

/** §4 id MUST 是 String、Number 或 Null。注意 boolean 不在里面。 */
export type JsonId = string | number | null;

/** §4.2 params 若出现，MUST 是 Array（按位置）或 Object（按名字）。 */
export type Params = unknown[] | Record<string, unknown>;

export interface RequestObject {
  jsonrpc: typeof VERSION;
  method: string;
  params?: Params;
  id?: JsonId;   // 可选 —— 省略即通知（§4.1）
}

export interface ErrorObject {
  code: number;      // §5.1 MUST 是整数
  message: string;
  data?: unknown;
}

/**
 * §5 的 result / error 互斥，用判别联合表达：
 * `error?: never` 让「同时带 result 和 error」变成编译错误，
 * 而不是等到运行时才发现。这是 TS 版相对 Python 版的真实增量。
 */
export interface SuccessResponse {
  jsonrpc: typeof VERSION;
  result: unknown;
  error?: never;
  id: JsonId;        // §5 响应里的 id 是 REQUIRED（请求里却是可选的 —— 这个不对称要记住）
}
export interface ErrorResponse {
  jsonrpc: typeof VERSION;
  result?: never;
  error: ErrorObject;
  id: JsonId;
}
export type ResponseObject = SuccessResponse | ErrorResponse;

// ─── 错误 ───────────────────────────────────────────────────────────────────

/** 业务代码 throw 这个，就能精确控制 error 对象的三个字段（§5.1）。 */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message?: string, data?: unknown) {
    const msg = message ?? DEFAULT_MESSAGES[code] ?? "Server error";
    super(`[${code}] ${msg}`);
    this.name = "JsonRpcError";
    // §5.1 code MUST be an integer —— 在构造处就挡掉，别等发出去才发现。
    // （被融合那篇文章的 Node 实现就漏了这一步：Node 系统错误的 code 是
    //   'ENOENT' 这类字符串，原样塞进去会产出非法的 JSON-RPC 错误响应。）
    if (!Number.isInteger(code)) {
      throw new TypeError(`JSON-RPC 错误码必须是整数，收到 ${JSON.stringify(code)}`);
    }
    this.code = code;
    this.data = data;
  }

  toObject(): ErrorObject {
    const obj: ErrorObject = { code: this.code, message: this.message.replace(/^\[-?\d+\] /, "") };
    // 注意这里判的是 undefined 而不是 falsy ——
    // 写成 `if (this.data)` 会把合法的 0 / "" / false 一起吞掉。
    if (this.data !== undefined) obj.data = this.data;
    return obj;
  }
}

// ─── 构造报文 ───────────────────────────────────────────────────────────────

export function makeRequest(method: string, params: Params | undefined, id: JsonId): RequestObject {
  const req: RequestObject = { jsonrpc: VERSION, method };
  if (params !== undefined) req.params = params;
  req.id = id;
  return req;
}

/**
 * §4.1 通知 = 没有 id 成员的请求。
 * 划重点：是「没有 id 这个键」，不是「id 的值为 null」。
 * 下面这个返回类型里根本没有 id 字段，就是在类型层面强调这件事。
 */
export function makeNotification(method: string, params?: Params): Omit<RequestObject, "id"> {
  const req: Omit<RequestObject, "id"> = { jsonrpc: VERSION, method };
  if (params !== undefined) req.params = params;
  return req;
}

export function makeResult(id: JsonId, result: unknown): SuccessResponse {
  return { jsonrpc: VERSION, result, id };
}

export function makeError(id: JsonId, code: number, message?: string, data?: unknown): ErrorResponse {
  return { jsonrpc: VERSION, error: new JsonRpcError(code, message, data).toObject(), id };
}

/** 一帧 = 一行，帧内绝不能出现裸换行。JSON.stringify 会把字符串里的换行转义，默认就是安全的。 */
export function dumps(obj: unknown): string {
  return JSON.stringify(obj);
}

// ─── 服务端：Dispatcher ─────────────────────────────────────────────────────

export type Handler = (...args: any[]) => unknown | Promise<unknown>;

/**
 * 参数名声明。
 * - 字符串数组：支持 by-position 与 by-name 两种绑定（§4.2）
 * - "variadic"：只支持 by-position，参数个数不定（比如 sum）
 */
export type ParamSpec = readonly string[] | "variadic";

interface MethodEntry {
  handler: Handler;
  spec: ParamSpec;
  required: number;
}

export class Dispatcher {
  private methods = new Map<string, MethodEntry>();

  /**
   * 注册一个方法。
   *
   * paramNames 必须显式写出来 —— 这是 JS 相对 Python 的真实代价：
   * 运行时拿不到参数名（编译/压缩之后更没有），而 §4.2 的 by-name 绑定
   * 又要求「成员名与服务端参数名完全一致，包括大小写」，
   * 所以只能由注册方把这份契约声明出来。
   *
   * @param required 前几个是必填的，默认全部必填
   */
  register(name: string, spec: ParamSpec, handler: Handler, required?: number): void {
    // §4「rpc.」开头的方法名保留给协议内部扩展，业务不许占用。
    // 顺带这也是一道安全闸：method 是客户端完全可控的字符串，
    // 必须白名单派发，绝不能拿它去反射任意对象属性（`obj[method]` → 原型链污染）。
    if (name.startsWith("rpc.")) {
      throw new Error(`方法名 ${JSON.stringify(name)} 占用了 §4 保留的 rpc. 前缀`);
    }
    const n = spec === "variadic" ? 0 : spec.length;
    this.methods.set(name, { handler, spec, required: required ?? n });
  }

  get methodNames(): string[] {
    return [...this.methods.keys()].sort();
  }

  /** 收一段文本，吐一段文本；返回 null 表示「按规范这次不该回任何东西」。 */
  async handleRaw(raw: string): Promise<string | null> {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      // §7 例：解析都失败了，自然读不出 id，MUST 回填 null
      return dumps(makeError(null, PARSE_ERROR));
    }
    const response = await this.handlePayload(payload);
    return response === null ? null : dumps(response);
  }

  async handlePayload(payload: unknown): Promise<ResponseObject | ResponseObject[] | null> {
    if (Array.isArray(payload)) {
      // §6 空数组：整个批本身就不是合法请求 ——
      //     此时回的是「一个」响应对象，不是只含一个元素的数组。这个坑很常见。
      if (payload.length === 0) return makeError(null, INVALID_REQUEST);

      // §6 服务端 MAY 并发处理一个批量。这里就用 Promise.all 真的并发。
      // ⚠️ 规范没禁止同一批里出现重复 id，本实现也不查重 ——
      //    但客户端收到两条同 id 的响应时根本无法分辨谁是谁。这是发送方的责任。
      const all = await Promise.all(payload.map((item) => this.handleOne(item)));
      const responses = all.filter((r): r is ResponseObject => r !== null);

      // §6 如果批里全是通知，服务端 MUST NOT 返回空数组，而是什么都不返回。
      return responses.length > 0 ? responses : null;
    }
    return this.handleOne(payload);
  }

  private async handleOne(req: unknown): Promise<ResponseObject | null> {
    // ── 第一阶段：先把 id 认出来 ──────────────────────────────────────────
    //
    // §5：「If there was an error in detecting the id in the Request object
    // (e.g. Parse error/Invalid Request), it MUST be Null.」
    //
    // ⚠️ 这句话是规范里少数几处真歧义之一，两种读法都有人采纳。
    // 本实现选「只有认不出 id 才回 null」，并在整个函数里始终如一地执行 ——
    // 因为回了 null，客户端就没法把这个错误对到是哪次调用上。
    // 真正不可接受的是两种读法混着用。
    if (typeof req !== "object" || req === null || Array.isArray(req)) {
      return makeError(null, INVALID_REQUEST, undefined, "请求必须是 JSON Object");
    }
    const r = req as Record<string, unknown>;

    const hasId = "id" in r;
    const rawId = r.id;
    // §4 id MUST 是 String / Number / Null。
    // JS 这边要当心的是 boolean 和 NaN；typeof true === "boolean" 天然被挡掉，
    // 但 typeof NaN === "number"，得额外判一下。
    const idValid =
      !hasId ||
      rawId === null ||
      typeof rawId === "string" ||
      (typeof rawId === "number" && Number.isFinite(rawId));
    if (!idValid) {
      return makeError(null, INVALID_REQUEST, undefined, "id 必须是字符串、数字或 null");
    }
    const detected: JsonId = hasId ? (rawId as JsonId) : null;

    // ── 第二阶段：结构校验 ────────────────────────────────────────────────
    //
    // 顺序很讲究：**先校验结构，再判断是不是通知**。理由见规范 §7 的这个例子：
    //     --> {"jsonrpc": "2.0", "method": 1, "params": "bar"}
    //     <-- {"jsonrpc": "2.0", "error": {"code": -32600, ...}, "id": null}
    // 它没有 id、长得像通知，服务端照样回了错误 ——
    // 因为报文都不合法，你根本无从确认「作者是不是真的想发通知」。
    if (r.jsonrpc !== VERSION) {
      return makeError(detected, INVALID_REQUEST, undefined, 'jsonrpc 成员必须恰好是 "2.0"');
    }
    if (typeof r.method !== "string") {
      return makeError(detected, INVALID_REQUEST, undefined, "method 成员必须是字符串");
    }
    const method = r.method;

    // ── 第三阶段：结构合法了，现在才能安心判定通知 ──────────────────────────
    //
    // §4.1「A Notification is a Request object without an "id" member.」
    // 判据是「有没有 id 这个键」，不是「id 的值是不是 null」。
    // JS 里写成 `id === undefined` 恰好是对的，但写成 `id == null` 就错了 ——
    // 那会把 {"id": null} 一起吞掉。
    const isNotification = !hasId;

    // ── 第四阶段：参数与派发 ──────────────────────────────────────────────
    let params: Params | undefined;
    if ("params" in r) {
      const p = r.params;
      // §4.2 params 若出现，MUST 是 Array 或 Object。
      // 标量 params 属于「不是合法的 Request 对象」，所以判 -32600 而非 -32602。
      //
      // ⚠️ 互操作坑：`"params": null` 算「出现」还是「省略」？规范没说。
      // 本实现按「键在就算出现」判 → null 不是 Structured → -32600，
      // 理由是这样才和上面 id 的判据（"id" in r）保持同一套逻辑。
      // 结论：自己发请求时永远不要写 "params": null，直接把这个键去掉。
      if (typeof p !== "object" || p === null) {
        return isNotification
          ? null
          : makeError(detected, INVALID_REQUEST, undefined, "params 必须是数组或对象");
      }
      params = p as Params;
    }

    const entry = this.methods.get(method);
    if (!entry) {
      return isNotification ? null : makeError(detected, METHOD_NOT_FOUND, undefined, { method });
    }

    let result: unknown;
    try {
      result = await invoke(entry, params);
    } catch (err) {
      if (isNotification) return null;   // §4.1 通知出错也照样闭嘴
      if (err instanceof JsonRpcError) {
        return { jsonrpc: VERSION, error: err.toObject(), id: detected };
      }
      // 兜底：异常绝不能穿透到传输层，否则连接会直接断掉
      const e = err as Error;
      return makeError(detected, INTERNAL_ERROR, undefined, `${e?.name}: ${e?.message}`);
    }

    // §4.1 通知处理成功也照样闭嘴。哪怕上面抛了错，客户端也永远不会知道 ——
    //      这就是「通知不可确认」的代价，别拿它传关键业务。
    if (isNotification) return null;

    // §5 result 存在即成功，哪怕它的值就是 null 也算成功
    //    （「result 为 null」和「没有 result 成员」是两回事）
    return makeResult(detected, result ?? null);
  }
}

/** 把 §4.2 的两种参数结构映射到 JS 的调用约定上。 */
async function invoke(entry: MethodEntry, params: Params | undefined): Promise<unknown> {
  const { handler, spec, required } = entry;

  if (params === undefined) {
    if (required > 0) throw new JsonRpcError(INVALID_PARAMS, undefined, `缺少参数：需要 ${required} 个`);
    return handler();
  }

  if (Array.isArray(params)) {
    // by-position：按顺序绑定
    if (spec !== "variadic" && params.length < required) {
      throw new JsonRpcError(INVALID_PARAMS, undefined,
        `按位置传参需要至少 ${required} 个，收到 ${params.length} 个`);
    }
    return handler(...params);
  }

  // by-name：按名字绑定
  if (spec === "variadic") {
    throw new JsonRpcError(INVALID_PARAMS, undefined, "该方法只接受按位置传参（数组）");
  }
  const args: unknown[] = [];
  spec.forEach((name, i) => {
    // §4.2「The names MUST match exactly, including case」——
    // 用 in 判存在，而不是取值判 undefined，这样显式传 undefined 也能区分开。
    if (!(name in params)) {
      if (i < required) {
        throw new JsonRpcError(INVALID_PARAMS, undefined, `缺少必填参数 ${JSON.stringify(name)}`);
      }
      args.push(undefined);
    } else {
      args.push(params[name]);
    }
  });
  return handler(...args);
}

// ─── 客户端：ResponseRouter ─────────────────────────────────────────────────

/**
 * 客户端那一半：发号（id）、记账（未决表）、按 id 认领响应。
 *
 * 这是 JSON-RPC 与 HTTP 最本质的区别 ——
 * HTTP 的「这个响应属于哪个请求」由连接的先后顺序隐式决定；
 * JSON-RPC 把它显式写进了 id 字段，于是请求可以乱序返回、可以并发在途、
 * 甚至可以双方同时向对方发起调用。
 */
export class ResponseRouter {
  private next = 0;
  private pending = new Map<string, Slot>();

  constructor(private prefix = "") {}

  newId(): string | number {
    this.next += 1;
    return this.prefix ? `${this.prefix}${this.next}` : this.next;
  }

  register(id: JsonId): Slot {
    const slot = new Slot(id);
    this.pending.set(key(id), slot);
    return slot;
  }

  /** 收到一个响应对象，认领对应的未决请求。认领不到返回 false。 */
  resolve(response: ResponseObject): boolean {
    const k = key(response.id);
    const slot = this.pending.get(k);
    if (!slot) return false;
    this.pending.delete(k);
    slot.fill(response);
    return true;
  }

  /**
   * 放弃一个未决请求，把槽位从表里摘掉。
   * 超时之后必须调它，否则槽位会永远留在表里：长跑的进程每超时一次就漏一个，
   * 而迟到的响应还会被它悄悄认领掉，连日志都不会打。
   */
  discard(id: JsonId): boolean {
    return this.pending.delete(key(id));
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** 连接断了：把所有还在等的请求一次性叫醒，不然调用方会永远卡住。 */
  failAll(reason: string): void {
    for (const slot of this.pending.values()) {
      slot.fill(makeError(slot.id, INTERNAL_ERROR, undefined, reason));
    }
    this.pending.clear();
  }
}

/** JSON 里 1 和 "1" 是两个不同的 id，做字典键时必须带上类型，否则会串台。 */
function key(id: JsonId): string {
  return `${typeof id}:${String(id)}`;
}

/** 一个在途请求的占位符。调用方 await，读循环 fill()。 */
export class Slot {
  private settle!: (r: ResponseObject) => void;
  private readonly promise: Promise<ResponseObject>;

  constructor(readonly id: JsonId) {
    this.promise = new Promise((res) => { this.settle = res; });
  }

  fill(response: ResponseObject): void {
    this.settle(response);
  }

  /**
   * 规范通篇没有「超时」二字 —— 超时是传输层/客户端的责任，必须自己实现，
   * 否则对端不回你就永远挂着。这是生产环境最常见的一个坑。
   */
  async wait(timeoutMs = 10_000): Promise<ResponseObject> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`请求 id=${JSON.stringify(this.id)} 等待响应超时（${timeoutMs}ms）`)), timeoutMs);
    });
    try {
      return await Promise.race([this.promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  async result(timeoutMs = 10_000): Promise<unknown> {
    const resp = await this.wait(timeoutMs);
    if (resp.error) {
      throw new JsonRpcError(resp.error.code, resp.error.message, resp.error.data);
    }
    return (resp as SuccessResponse).result;
  }
}
