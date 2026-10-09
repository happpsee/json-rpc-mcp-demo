import { INVALID_PARAMS, JsonError, jsonrpc } from "./jsonrpc.ts";
import * as readline from "node:readline";
import https from "node:https";
import http from "node:http";

// MCP 规范在 JSON-RPC 保留区 -32020 ~ -32099 里定的码。自己写的 server 别往这段放。
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

// server/discover 里报的服务端图标（webp，内联成 data URL）。
// 留着了，但只在一个地方用到——所有 result 都带它是没必要的。
const ICON_WEBP = "data:image/webp;base64,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";

const MCP_INFO = {
    "server/discover": {
        "supportedVersions": ["2026-07-28"],
        "capabilities": { "tools": {} },
        "instructions": "查中国城市的天气，城市名用中文，比如[北京]。查不到的城市会返回可选列表，让用户从里面挑。",
    },
    "version": ["2026-07-28"],
    "ttlMs": 3600000,
    "cacheScope": "public"
};

// 服务端身份。规范里 serverInfo 是「可选」，它在哪出现是我们的选择——
// 只在 server/discover 报一次，不塞进每个 result：icons 那张 base64 有 18060 字符，
// 每条响应都带会把 tools/call 从 378 字节撑到 18 KB。
const SERVER_INFO = {
    name: "miniWeatherServer",
    version: "0.2.0",
    title: "迷你天气",
    icons: [{ mimeType: "image/webp", src: ICON_WEBP }]
};
// 每个 result 都带的 _meta。没有 serverInfo，所以很小。
const RESULT_META = {};
// 只有 server/discover 用这个。
const DISCOVER_META = { "io.modelcontextprotocol/serverInfo": SERVER_INFO };


// 默认 _meta 是空的。要带 serverInfo 的只有 server/discover，它显式传进来。
const complete = (data: any, meta: object = RESULT_META) => {
    return {
        resultType: "complete",
        ...data,
        "ttlMs": MCP_INFO["ttlMs"],
        "cacheScope": MCP_INFO["cacheScope"],
        "_meta": meta
    };
};

interface Tool {
    name: string,
    description: string,
    inputSchema: {
        type: string;
        properties: any;
        required?: string[]
    }
} //

const TOOLS: Tool[] = [
    {
        name: "get_weather",
        description: "查询某个城市天气",
        inputSchema: {
            type: "object",
            properties: {
                city: {
                    type: "string"
                }
            },
            required: ["city"]
        },
    }
]


const checkMeta = (params: any) => {
    const meta = params?._meta ?? {};
    const version = meta["io.modelcontextprotocol/protocolVersion"];
    if (!version || !meta["io.modelcontextprotocol/clientCapabilities"]) {
        throw new JsonError(INVALID_PARAMS, "_meta 里要有 protocolVersion 和 clientCapabilities");
    }
    const capabilities = meta["io.modelcontextprotocol/clientCapabilities"];

    if (!(typeof capabilities === "object" && capabilities !== null) || Array.isArray(capabilities)) {
        throw new JsonError(INVALID_PARAMS, "clientCapabilities必须是一个对象");
    }

    if (!MCP_INFO["version"].includes(version)) {
        throw new JsonError(UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", { supported: MCP_INFO["version"], requested: version });
    }
};


const serverDiscover = (params: any) => {
    checkMeta(params);

    // 唯一一处带 serverInfo 的响应
    return complete({
        "supportedVersions": MCP_INFO["version"],
        "capabilities": { "tools": {} },
        "instructions": "查中国城市的天气，城市名用中文，比如: 北京"
    }, DISCOVER_META);
};

const toolsList = (params: any) => {
    checkMeta(params);
    // ttlMs / cacheScope 由 complete() 统一补，这里不再重复写（写了也会被覆盖）
    return complete({
        tools: TOOLS
    });
}


const weather_send = (city: string) => {
    return new Promise((resolve, reject) => {
        const req = https.request({
            "method": "GET",
            "hostname": "uapis.cn",
            "path": `/api/v1/misc/weather?city=${encodeURIComponent(city)}`,
            "headers": {
                "content-type": "application/json"
            }
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                resolve(data);
            })
        });
        req.on("error", (err) => {
            reject(err.message);
        })
        req.end();
    });
};


const toolsCall = async (params: any) => {
    const { name, arguments: args = {} } = params;

    if (name === "get_weather") {
        if (typeof args.city !== "string") throw new JsonError(INVALID_PARAMS, "city必须是字符串");

        try {
            const text = await weather_send(args.city);
            return complete({
                content: [
                    {
                        type: "text",
                        text
                    }
                ],
                isError: false
            });
        } catch (e: any) {
            return complete({
                "content": [
                    {
                        type: "text",
                        text: e.message
                    }
                ],
                isError: true
            });
        }
    }
    
    throw new JsonError(INVALID_PARAMS, "Unknown tool" + name)
};

    const methods: Record<string, (params: any) => any> = {
        "server/discover": serverDiscover,
        "tools/list": toolsList,
        "tools/call": toolsCall
    }



    const stdioServer = () => {
        readline.createInterface({
            input: process.stdin
        }).on("line", async (line) => {
            if (!line.trim()) return;
            const out = JSON.stringify(await jsonrpc(line, methods));
            if (out !== "null") process.stdout.write(out + "\n");
        })
    };

    const httpServer = () => {
        const server = http.createServer((req, res) => {
            if (req.method !== "POST") {
                res.writeHead(405, "Method not Allow");
                res.end();
                return;
            }

            let body = "";
            req.on("data", (chunk) => body += chunk);
            req.on("end", async () => {
                const out = JSON.stringify(await jsonrpc(body, methods));
                if (out === "null") {
                    res.writeHead(202);
                    res.end();
                    return;
                }
                res.writeHead(200, {
                    "content-type": "application/json"
                });
                res.end(out);
            });
        });

        server.listen(3000, "127.0.0.1", () => {
            process.stderr.write(`PORT=${3000}\n`)
        });
    }

    // 默认 stdio：stdin 进一行，stdout 出一行。传 http 参数才起 HTTP 服务。
    // 两种传输挂的是同一张 methods 表，方法表本身不知道自己跑在哪。
    if (process.argv[2] === "http") {
        httpServer();
    } else {
        stdioServer();
    }