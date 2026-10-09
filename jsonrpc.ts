
//不是合法json
export const PARSE_ERROR = -32700;
//无效头
export const INVALID_REQUEST = -32600;
//方法不存在
export const METHOD_NOT_FOUND = -32601;
//无效的params
export const INVALID_PARAMS = -32602;

export const INTERNAL_ERROR = -32603;

export type JsonId = string | number | null;

export const MESSAGES: Record<number, string> = {
  [PARSE_ERROR]: "Parse error",
  [INVALID_REQUEST]: "Invalid Request",
  [METHOD_NOT_FOUND]: "Method not found",
  [INVALID_PARAMS]: "Invalid params",
  [INTERNAL_ERROR]: "Internal error",
};

export interface JsonRpc {
    jsonrpc: "2.0",
    method: "server/discover" | "tools/list" | "tools/call" | "resources/list" | "resources/read" | "prompts/list" | "prompts/get",
    params: any,
    id: JsonId
}


export class JsonError extends Error {
    msg?: string;
    data?: unknown;
    code: number;
    constructor(code: number, msg?: string, data?: unknown) {
        super( msg ?? MESSAGES[code] ?? "Server error");
        this.msg = msg;
        this.data = data;
        this.code = code;
    }
}


export const makeRequest =  (id: JsonId, method: string, params: unknown) => {
    return {
        id, method, params, jsonrpc: "2.0"
    }
}
export const makeNotification =  (method: string, params: unknown) => {
    return !!params ? 
    { method, params, jsonrpc: "2.0" } : {
        method, jsonrpc: "2.0"
    }
}
export const makeError = (code: number, id: JsonId = null, msg?: string, data?: unknown) => {
    return {
        jsonrpc: "2.0",
        id,
        error: data === undefined ? 
        {code, message: msg ?? MESSAGES[code] ?? "Server error"} :
        {code, message: msg ?? MESSAGES[code] ?? "Server error", data}
    }
};

export const makeResult = (id: JsonId = null, result: any = null) => {
    return {
        jsonrpc: "2.0",
        id,
        result
    };
}

export const jsonrpc = async (line: string, methods: Record<string, (...args: any[]) => any>) => {
    let req;

    try {
        req = JSON.parse(line);
    } catch (err) {
        return makeError(PARSE_ERROR);
    }

    if (req === null) {
        return makeError(INVALID_REQUEST, null, "请求数据不能是null");
    }

    if (req.jsonrpc !== "2.0") {
        return makeError(INVALID_REQUEST, req.id, "jsonrpc版本必须是2.0");
    }
    if (!("method" in req)) {
        return makeError(INVALID_REQUEST, req.id, "必须传递method");
    }
    if (typeof req.method !== "string") {
        return makeError(INVALID_REQUEST, req.id, "method必须是string");
    }


    const isNotification = !("id" in req);
    if (!isNotification && !req.params) {
        return makeError(INVALID_REQUEST, req.id, "必须传递params参数");
    }
    if (!isNotification && (typeof req.params !== "object" || req.params === null)) {
        return makeError(INVALID_REQUEST, req.id, "params必须是对象切不能是null");
    }

    const fn = methods[req.method];

    if (!fn) {
        return isNotification  ? null : makeError(METHOD_NOT_FOUND, req.id);
    }


    try {
      const ans = await Promise.resolve(fn(req.params));
      return isNotification ? null : makeResult(req.id, ans);
      //表示成功
    } catch (err: any) {
        //如果错误
        if (err instanceof JsonError) {
            return isNotification ? null : makeError(err.code, req.id, err.message, err.data);
        } 
        return isNotification ? null : makeError(INTERNAL_ERROR, req.id,  err.message, err.data);
    }
};