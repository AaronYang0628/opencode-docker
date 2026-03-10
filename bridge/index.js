/**
 * OpenCode Bridge v4 - K8s 部署版
 * 通过集群内部地址访问 OpenCode
 *
 * 端口: 3100
 * 环境变量:
 *   OPENCODE_BASE   - OpenCode 服务地址（默认集群内部地址）
 *   DEFAULT_MODEL   - 默认模型
 *   BRIDGE_PORT     - 监听端口（默认 3100）
 */

const http = require("http");

const OPENCODE_BASE = process.env.OPENCODE_BASE || "http://opencode.opencode.svc.cluster.local:4000";
const BRIDGE_PORT   = parseInt(process.env.BRIDGE_PORT || "3100");
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "zzz/claude-sonnet-4-5-20250929-thinking";

// N8N sessionId → OpenCode sessionId 映射（多轮对话）
const sessionMap = new Map();

// ─── 工具函数 ─────────────────────────────────────────────────

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const reqOptions = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        ...options.headers,
      },
    };

    const req = http.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

// 从 message 响应的 parts 里提取文本
function extractText(messageResponse) {
  if (!messageResponse || !messageResponse.parts) return "";
  return messageResponse.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text || "")
    .join("");
}

// ─── HTTP Server ──────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── POST /chat ────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/chat") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { prompt, sessionId: n8nSessionId, model } = JSON.parse(body);
        if (!prompt) throw new Error("prompt is required");

        // 复用或新建 OpenCode Session
        let opencodeSessionId = sessionMap.get(n8nSessionId);
        if (!opencodeSessionId) {
          const session = await fetchJSON(`${OPENCODE_BASE}/session`, {
            method: "POST",
            body: { model: model || DEFAULT_MODEL },
          });
          opencodeSessionId = session.id;
          if (n8nSessionId) sessionMap.set(n8nSessionId, opencodeSessionId);
          console.log(`[新建Session] n8n:${n8nSessionId} → opencode:${opencodeSessionId}`);
        } else {
          console.log(`[复用Session] opencode:${opencodeSessionId}`);
        }

        console.log(`[发送消息] ${prompt.slice(0, 80)}`);
        const msgResponse = await fetchJSON(
          `${OPENCODE_BASE}/session/${opencodeSessionId}/message`,
          {
            method: "POST",
            body: { parts: [{ type: "text", text: prompt }] },
          }
        );

        const result = extractText(msgResponse);
        console.log(`[返回结果] ${result.slice(0, 80)}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, sessionId: opencodeSessionId, result }));
      } catch (err) {
        console.error(`[错误] ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ── GET /health ───────────────────────────────────────────────
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessionMap.size, opencode: OPENCODE_BASE }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(BRIDGE_PORT, "0.0.0.0", () => {
  console.log(`✅ OpenCode Bridge v4 (K8s) @ http://0.0.0.0:${BRIDGE_PORT}`);
  console.log(`   OpenCode Backend: ${OPENCODE_BASE}`);
  console.log(`   Default Model:    ${DEFAULT_MODEL}`);
});