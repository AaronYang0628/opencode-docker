/**
 * OpenCode Bridge v4 - K8s 部署版
 * 通过集群内部地址访问 OpenCode
 *
 * 端口: 3100
 * 环境变量:
 *   OPENCODE_BASE   - OpenCode 服务地址（默认集群内部地址）
 *   DEFAULT_MODEL   - 默认模型
 *   BRIDGE_PORT     - 监听端口（默认 3100）
 *
 * 修复记录:
 *   - 移除 `: connected\n\n` SSE comment，避免 openai SDK 误判流已开始
 *   - 移除提前发送的空 role delta chunk，改为第一个真实 content delta 时再发
 *   - 响应头增加 Transfer-Encoding: chunked，防止 nginx 缓冲
 *   - openaiStreamChunkSize 默认改为 4，避免单次大 chunk 导致 n8n 流式失效
 */

const http = require("http");

const OPENCODE_BASE = process.env.OPENCODE_BASE || "http://opencode.opencode.svc.cluster.local:4000";
const BRIDGE_PORT   = parseInt(process.env.BRIDGE_PORT || "3100");
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "zzz/claude-sonnet-4-5-20250929-thinking";
// FIX: 默认改为 4，避免整个响应作为单个 chunk 发出
const OPENAI_STREAM_CHUNK_SIZE = Math.max(0, parseInt(process.env.OPENAI_STREAM_CHUNK_SIZE || "4", 10) || 0);
const OPENAI_STREAM_CHUNK_DELAY_MS = Math.max(0, parseInt(process.env.OPENAI_STREAM_CHUNK_DELAY_MS || "10", 10) || 0);
const ENABLE_LEADING_ECHO_FILTER = String(process.env.ENABLE_LEADING_ECHO_FILTER || "false").toLowerCase() === "true";
const BRIDGE_STREAM_DEBUG = String(process.env.BRIDGE_STREAM_DEBUG || "false").toLowerCase() === "true";

// N8N sessionId → OpenCode sessionId 映射（多轮对话）
const sessionMap = new Map();

// ─── 工具函数 ─────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamDebug(...args) {
  if (!BRIDGE_STREAM_DEBUG) return;
  console.log("[stream-debug]", ...args);
}

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
        let parsed = data;
        try { parsed = JSON.parse(data); }
        catch { /* keep raw string */ }

        if (options.rejectOnHTTPError && res.statusCode >= 400) {
          const message =
            (parsed && parsed.error) ||
            (parsed && parsed.message) ||
            data ||
            `Request failed with status ${res.statusCode}`;
          reject(new Error(`HTTP ${res.statusCode}: ${message}`));
          return;
        }

        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.setTimeout(options.timeoutMs || 290000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

// 从 message 响应的 parts 里提取文本
function extractText(messageResponse) {
  const parts =
    (messageResponse && messageResponse.parts) ||
    (messageResponse && messageResponse.message && messageResponse.message.parts) ||
    [];

  if (!Array.isArray(parts)) return "";

  return parts
    .map((p) => {
      if (!p || typeof p !== "object") return "";
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      if (typeof p.output_text === "string") return p.output_text;
      if (typeof p.input_text === "string") return p.input_text;
      if (Array.isArray(p.content)) {
        return p.content
          .map((c) => {
            if (typeof c === "string") return c;
            if (!c || typeof c !== "object") return "";
            return c.text || c.output_text || c.input_text || "";
          })
          .join(" ");
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

function extractAssistantTextFromMessages(messagesResponse) {
  const messages = Array.isArray(messagesResponse)
    ? messagesResponse
    : Array.isArray(messagesResponse && messagesResponse.items)
      ? messagesResponse.items
      : [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    if (message.role && message.role !== "assistant") continue;

    const text = extractText(message);
    if (text) return text;
  }

  return "";
}

async function pollAssistantTextFromSession(sessionId, options = {}) {
  const attempts = Math.max(1, options.attempts || 12);
  const intervalMs = Math.max(0, options.intervalMs || 800);
  streamDebug(`poll messages start session=${sessionId} attempts=${attempts} intervalMs=${intervalMs}`);

  for (let i = 0; i < attempts; i += 1) {
    try {
      const messagesResponse = await fetchJSON(`${OPENCODE_BASE}/session/${sessionId}/messages`, {
        method: "GET",
        rejectOnHTTPError: true,
      });
      const text = extractAssistantTextFromMessages(messagesResponse);
      if (text) {
        streamDebug(`poll messages hit session=${sessionId} attempt=${i + 1} textLen=${text.length}`);
        return text;
      }
    } catch {
      // ignore transient polling errors
    }

    if (i < attempts - 1 && intervalMs > 0) {
      await sleep(intervalMs);
    }
  }

  streamDebug(`poll messages empty session=${sessionId}`);
  return "";
}

function pickFirst(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function writeSSE(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createSSEParser(onEvent) {
  let buffer = "";
  let eventName = "message";
  let dataLines = [];

  return (chunk) => {
    buffer += chunk.toString("utf8");

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      // 空行表示一个 SSE 事件结束
      if (line === "") {
        if (dataLines.length > 0) {
          const raw = dataLines.join("\n");
          let data = raw;
          try { data = JSON.parse(raw); }
          catch { /* keep raw string */ }
          onEvent({ event: eventName, data });
        }
        eventName = "message";
        dataLines = [];
        continue;
      }

      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim() || "message";
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  };
}

function normalizeInputString(value) {
  if (typeof value !== "string") return value;
  // n8n 表达式模式里经常会把值写成 =xxx
  return value.startsWith("=") ? value.slice(1) : value;
}

function normalizeSessionCacheKey(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized === "undefined" || normalized === "null") return null;
  return normalized;
}

function toPromptText(value) {
  const v = normalizeInputString(value);
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "object") {
    const keys = ["prompt", "text", "message", "content", "query"];
    for (const k of keys) {
      if (typeof v[k] === "string") return normalizeInputString(v[k]);
    }
  }
  return String(v);
}

function createMessageID() {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function createCompletionID() {
  return `chatcmpl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function writeOpenAIStreamChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeOpenAIStreamDone(res) {
  res.write("data: [DONE]\n\n");
}

function splitStreamText(text, chunkSize) {
  if (!text) return [];
  if (!chunkSize || chunkSize <= 0) return [text];

  const chars = Array.from(text);
  if (chars.length <= chunkSize) return [text];

  const parts = [];
  for (let i = 0; i < chars.length; i += chunkSize) {
    parts.push(chars.slice(i, i + chunkSize).join(""));
  }
  return parts;
}

function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        if (typeof item.text === "string") return item.text;
        if (typeof item.input_text === "string") return item.input_text;
        if (typeof item.output_text === "string") return item.output_text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.input_text === "string") return content.input_text;
    if (typeof content.output_text === "string") return content.output_text;
  }

  return "";
}

function buildPromptFromMessages(messages) {
  // 核心原则：OpenCode session 有自己的对话记忆，不需要重复传入历史。
  // bridge 只取最后一条 user 消息发给 OpenCode，避免 token 爆炸。
  //
  // n8n AI Agent 每次调用都携带完整 messages[]（含所有历史轮次），
  // 如果把这些历史全部拼成 prompt 传给 OpenCode：
  //   ① OpenCode session 已有历史 → 历史被传两遍
  //   ② system prompt 每轮重复注入 → 额外 token 浪费
  //   ③ 10 轮对话 token 呈平方级增长 → 9000万 token 的根本原因
  if (!Array.isArray(messages)) return "";

  // 只取最后一条 user 消息
  let lastUserText = "";
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" ? message.role : "";
    if (role !== "user") continue;
    const text = messageContentToText(message.content);
    if (text && text.trim()) lastUserText = text.trim();
  }

  return lastUserText;
}

// 仅在第一次建立 OpenCode session 时注入 system prompt（只发一次，不随每轮重复）
function extractSystemPrompt(messages) {
  if (!Array.isArray(messages)) return "";
  const blocks = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" ? message.role : "";
    if (role !== "system" && role !== "developer") continue;
    const text = messageContentToText(message.content);
    if (text && text.trim()) blocks.push(text.trim());
  }
  return blocks.join("\n\n");
}

// 从 messages 数组里提取第一条 user 消息内容，用于生成稳定的 session fingerprint
// n8n 每次请求都携带完整对话历史，同一对话的第一条消息是固定的，可作为 session key
function deriveSessionKeyFromMessages(messages) {
  if (!Array.isArray(messages)) return null;

  // 优先策略：从任意消息内容里提取明确注入的 sessionId
  // 支持格式（来自 n8n system prompt 注入）：
  //   "当前sessionId是 <id>"
  //   "sessionId: <id>"
  //   "session_id: <id>"
  //   "sessionId=<id>"
  const SESSION_ID_PATTERN = /(?:当前sessionId是|sessionId[\s:=]+|session_id[\s:=]+)([a-zA-Z0-9_\-]{8,})/i;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const text = messageContentToText(msg.content);
    if (!text) continue;
    const m = text.match(SESSION_ID_PATTERN);
    if (m && m[1]) {
      return m[1];
    }
  }

  // 兜底策略：用 system message 前 120 字符做 fingerprint（同一对话 system prompt 固定不变）
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "system") continue;
    const text = messageContentToText(msg.content);
    if (!text || text.trim().length < 8) continue;
    return "sys:" + text.trim().slice(0, 120);
  }

  return null;
}

function extractOpenAIInput(payload = {}) {
  const root = payload && typeof payload === "object" ? payload : {};
  const metadata = root.metadata && typeof root.metadata === "object" ? root.metadata : {};

  const promptFromMessages = buildPromptFromMessages(root.messages);
  const promptRaw = root.prompt ?? root.input ?? root.query ?? promptFromMessages;

  // 优先从请求字段里找明确的 sessionId
  const explicitSessionId =
    root.sessionId ??
    root.session_id ??
    root.conversationId ??
    root.conversation_id ??
    root.chatId ??
    root.chat_id ??
    metadata.sessionId ??
    metadata.session_id ??
    root.user ??
    null;

  // n8n lmChatOpenAi 不传 sessionId，fallback：用 messages 历史的首条消息内容做 fingerprint
  // 同一对话的每次请求都携带相同的 messages[0]，因此可以稳定复用同一个 OpenCode session
  const sessionIdRaw = explicitSessionId ?? deriveSessionKeyFromMessages(root.messages);

  if (!explicitSessionId && sessionIdRaw) {
    console.log(`[session-fingerprint] derived from messages: ${sessionIdRaw.slice(0, 60)}...`);
  } else if (!sessionIdRaw) {
    console.warn("[session-debug] sessionId not found and messages empty, will create new session each time");
    console.warn("[session-debug] request keys:", Object.keys(root).join(", "));
  }

  const systemPrompt = extractSystemPrompt(Array.isArray(root.messages) ? root.messages : []);

  return {
    prompt: toPromptText(promptRaw),
    n8nSessionId: normalizeInputString(sessionIdRaw),
    model: normalizeInputString(root.model),
    systemPrompt,
    messages: Array.isArray(root.messages) ? root.messages : [],
  };
}

function buildOpenAIChatCompletion({ completionId, created, model, content }) {
  return {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function createLeadingEchoFilter(prompt) {
  const basePrompt = (prompt || "").trim();
  const variants = [];
  if (basePrompt) {
    variants.push(basePrompt);
    variants.push(`USER: ${basePrompt}`);
    variants.push(`用户: ${basePrompt}`);
  }

  if (variants.length === 0) {
    return {
      apply: (text) => text,
      flush: () => "",
    };
  }

  let decided = false;
  let buffer = "";
  const maxProbeLength = Math.max(...variants.map((v) => v.length)) + 16;

  const stripPrefix = (source, prefix) => {
    const leading = source.match(/^\s*/)?.[0] || "";
    const core = source.slice(leading.length);
    if (!core.startsWith(prefix)) return null;

    const rest = core.slice(prefix.length).replace(/^[\s\n\r:：,，。!！?？-]+/, "");
    return leading + rest;
  };

  return {
    apply: (text) => {
      if (!text) return "";
      if (decided) return text;

      buffer += text;

      for (const variant of variants) {
        const stripped = stripPrefix(buffer, variant);
        if (stripped !== null) {
          decided = true;
          buffer = "";
          return stripped;
        }
      }

      const probe = buffer.trimStart();
      const maybePrefix = variants.some((v) => v.startsWith(probe));
      if (!maybePrefix && probe.length >= maxProbeLength) {
        decided = true;
        const out = buffer;
        buffer = "";
        return out;
      }

      if (!maybePrefix && probe.length > 0) {
        decided = true;
        const out = buffer;
        buffer = "";
        return out;
      }

      return "";
    },
    flush: () => {
      if (decided || !buffer) return "";
      decided = true;
      const out = buffer;
      buffer = "";
      return out;
    },
  };
}

function createPassThroughFilter() {
  return {
    apply: (text) => text || "",
    flush: () => "",
  };
}

function extractModelIdFromPath(normalizedPath) {
  const marker = "/models/";
  const idx = normalizedPath.lastIndexOf(marker);
  if (idx === -1) return DEFAULT_MODEL;

  const raw = normalizedPath.slice(idx + marker.length);
  if (!raw) return DEFAULT_MODEL;

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function extractN8nInput(payload = {}) {
  const root = payload && typeof payload === "object" ? payload : {};
  const data = root.data && typeof root.data === "object" ? root.data : {};

  const promptRaw =
    root.prompt ??
    root.input ??
    root.query ??
    root.text ??
    root.message ??
    root.user_input ??
    data.prompt ??
    data.input ??
    data.query ??
    data.text ??
    data.message ??
    data.user_input;

  const sessionIdRaw =
    root.sessionId ??
    root.session_id ??
    root.chatId ??
    root.chat_id ??
    data.sessionId ??
    data.session_id ??
    data.chatId ??
    data.chat_id;

  const modelRaw = root.model ?? root.modelId ?? data.model ?? data.modelId;

  return {
    prompt: toPromptText(promptRaw),
    n8nSessionId: normalizeInputString(sessionIdRaw),
    model: normalizeInputString(modelRaw),
  };
}

async function resolveOpencodeSession(n8nSessionId, model, rejectOnHTTPError = false, systemPrompt = "") {
  const validId = normalizeSessionCacheKey(n8nSessionId);

  let opencodeSessionId = validId ? sessionMap.get(validId) : undefined;
  if (!opencodeSessionId) {
    const t0 = Date.now();
    const session = await fetchJSON(`${OPENCODE_BASE}/session`, {
      method: "POST",
      body: { model: model || DEFAULT_MODEL },
      rejectOnHTTPError,
    });
    opencodeSessionId = session.id;
    const elapsed = Date.now() - t0;
    if (validId) {
      sessionMap.set(validId, opencodeSessionId);
      console.log(`[phase] create-session ${elapsed}ms  n8n:${validId.slice(0,20)} -> opencode:${opencodeSessionId}`);
    } else {
      console.log(`[phase] create-session ${elapsed}ms  n8n:(no sessionId) -> opencode:${opencodeSessionId}`);
    }

    // 新建 session 时，若有 system prompt，作为第一条消息注入（只注入一次，后续轮次不重复）
    if (systemPrompt && systemPrompt.trim()) {
      console.log(`[phase] inject-system-prompt  len=${systemPrompt.length}  session=${opencodeSessionId}`);
      await fetchJSON(`${OPENCODE_BASE}/session/${opencodeSessionId}/message`, {
        method: "POST",
        body: { parts: [{ type: "text", text: `[SYSTEM]
${systemPrompt.trim()}` }] },
        rejectOnHTTPError: false,
        timeoutMs: 30000,
      });
    }
  } else {
    console.log(`[phase] reuse-session  n8n:${validId ? validId.slice(0,20) : "none"} -> opencode:${opencodeSessionId}`);
  }
  return opencodeSessionId;
}

async function handleStreamRequest(req, res, { prompt, n8nSessionId, model, systemPrompt = "" }, options = {}) {
  const mode = options.mode === "openai" ? "openai" : "bridge";
  const completionId = options.completionId || createCompletionID();
  const created = options.created || Math.floor(Date.now() / 1000);
  const responseModel = options.responseModel || model || DEFAULT_MODEL;

  if (!prompt) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "prompt is required" }));
    return;
  }

  let opencodeSessionId;
  const sessionCacheKey = normalizeSessionCacheKey(n8nSessionId);
  try {
    opencodeSessionId = await resolveOpencodeSession(n8nSessionId, model, true, systemPrompt);
    streamDebug(`start mode=${mode} session=${opencodeSessionId} promptLen=${prompt.length}`);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: err.message }));
    return;
  }

  const responseHeaders = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Transfer-Encoding": "chunked",
  };

  // 立即发响应头，让 n8n AI Agent 知道连接已建立，避免 streaming 握手超时
  // n8n 在 streaming 模式下会等待 HTTP 200 + 首字节，若迟迟没有会报 "No response received"
  res.writeHead(200, responseHeaders);
  let headersSent = true;
  let sentRoleChunk = false;

  // 立即写一个 SSE comment 作为 keep-alive 心跳，让 n8n 确认连接活跃
  // openai SDK 会忽略以 ": " 开头的 SSE comment，不影响解析
  res.write(": keep-alive\n\n");

  const ensureHeadersSent = () => {
    // 头已在函数入口发出，此函数保留作为兼容调用点
  };

  let closed = false;
  let eventReq = null;
  let fullText = "";
  let receivedAnyDelta = false;
  let completed = false;
  let assistantMessageID = null;
  const userMessageID = createMessageID();
  let promptAccepted = false;
  let messageAccepted = false;
  let turnHasActivity = false;
  const echoFilter = ENABLE_LEADING_ECHO_FILTER ? createLeadingEchoFilter(prompt) : createPassThroughFilter();
  let writeQueue = Promise.resolve();
  let closeRequested = false;
  const startedAt = Date.now();
  // 最后一次收到 delta 的时间，用于静默超时检测（playbook manual_gate 后 opencode 停止推送）
  let lastDeltaAt = 0;

  // 所有模式都发 SSE comment 心跳，间隔 5s
  // openai SDK 规范要求忽略 SSE comment（以 ":" 开头的行），n8n 也遵循此规范
  // 心跳作用：① 防止 nginx/load-balancer 因空闲关闭连接  ② 让 n8n 持续收到字节不触发读超时
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 5000);

  // 静默超时：有 delta 输出后，若超过 SILENCE_TIMEOUT_MS 没有新 delta，认为 opencode 已暂停
  // 主要用于捕获 playbook manual_gate 后 opencode 停止推送但不发 idle 事件的情况
  const MESSAGE_POST_TIMEOUT_MS = Math.max(10000, parseInt(process.env.BRIDGE_MESSAGE_TIMEOUT_MS || "300000", 10) || 300000);
const SILENCE_TIMEOUT_MS = Math.max(0, parseInt(process.env.BRIDGE_SILENCE_TIMEOUT_MS || "0", 10) || 0);
  const silenceChecker = setInterval(() => {
    if (closed || completed || !receivedAnyDelta) return;
    if (lastDeltaAt > 0 && Date.now() - lastDeltaAt > SILENCE_TIMEOUT_MS) {
      console.log(`[silence-timeout] no delta for ${SILENCE_TIMEOUT_MS}ms, closing stream session=${opencodeSessionId}`);
      evictSessionMapping("silence-timeout");
      emitDone("silence-timeout");
      closeStream();
    }
  }, 3000);

  // openai mode: 立即发 role chunk，让 openai SDK 确认流已开始
  // 不等第一个 content delta，避免 n8n 因长时间无内容报 'No response received'
  if (mode === "openai") {
    sentRoleChunk = true;
    writeOpenAIStreamChunk(res, {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: responseModel,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });
  }

  const enqueueWrite = (writer) => {
    writeQueue = writeQueue
      .then(async () => {
        if (closed) return;
        await writer();
      })
      .catch(() => {});
    return writeQueue;
  };

  const evictSessionMapping = (reason) => {
    if (!sessionCacheKey || !opencodeSessionId) return;
    if (sessionMap.get(sessionCacheKey) !== opencodeSessionId) return;
    sessionMap.delete(sessionCacheKey);
    console.warn(`[session-map] evict n8n:${sessionCacheKey.slice(0, 20)} -> opencode:${opencodeSessionId}  reason=${reason}`);
  };

  const cleanup = () => {
    if (heartbeat) clearInterval(heartbeat);
    clearInterval(silenceChecker);
    if (eventReq) {
      eventReq.destroy();
      eventReq = null;
    }
  };

  const closeStream = () => {
    if (closed || closeRequested) return;
    closeRequested = true;
    writeQueue.finally(() => {
      if (closed) return;
      // 如果从未发过任何内容（比如 OpenCode 没有响应），确保头已发出再结束
      ensureHeadersSent();
      res.end();
      closed = true;
      cleanup();
    });
  };

  const emitDelta = (text) => {
    if (!text) return;
    receivedAnyDelta = true;
    streamDebug(`emit delta session=${opencodeSessionId} len=${text.length} mode=${mode}`);
    if (!receivedAnyDelta) {
      console.log(`[phase] first-delta  elapsed=${Date.now() - startedAt}ms  session=${opencodeSessionId}`);
    }
    lastDeltaAt = Date.now();

    if (mode === "bridge") {
      ensureHeadersSent();
      enqueueWrite(() => {
        writeSSE(res, "delta", { text, sessionId: opencodeSessionId });
      });
      return;
    }

    // openai mode
    const parts = splitStreamText(text, OPENAI_STREAM_CHUNK_SIZE);
    parts.forEach((part, index) => {
      enqueueWrite(async () => {
        // FIX: 第一个真实 content delta 到来时才发响应头和 role chunk
        // 避免提前发空 role chunk 后长时间无内容，导致 openai SDK 误判流结束
        if (!sentRoleChunk) {
          sentRoleChunk = true;
          ensureHeadersSent();
          writeOpenAIStreamChunk(res, {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: responseModel,
            choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
          });
        }

        writeOpenAIStreamChunk(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: responseModel,
          choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
        });

        if (OPENAI_STREAM_CHUNK_DELAY_MS > 0 && index < parts.length - 1) {
          await sleep(OPENAI_STREAM_CHUNK_DELAY_MS);
        }
      });
    });
  };

  const emitDone = (reason = "unknown") => {
    if (completed) return;
    completed = true;
    console.log(`[phase] emit-done  elapsed=${Date.now() - startedAt}ms  reason=${reason}  textLen=${fullText.length}  session=${opencodeSessionId}`);
    streamDebug(`emit done session=${opencodeSessionId} fullTextLen=${fullText.length} mode=${mode}`);

    const tail = echoFilter.flush();
    if (tail) {
      fullText += tail;
      emitDelta(tail);
    }

    if (mode === "bridge") {
      ensureHeadersSent();
      enqueueWrite(() => {
        writeSSE(res, "done", {
          success: true,
          sessionId: opencodeSessionId,
          result: fullText,
        });
      });
      return;
    }

    // openai mode
    enqueueWrite(() => {
      // FIX: 如果整个过程都没有 delta（极端情况），这里补发 role chunk 确保响应合法
      if (!sentRoleChunk) {
        sentRoleChunk = true;
        ensureHeadersSent();
        writeOpenAIStreamChunk(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: responseModel,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        });
      }
      writeOpenAIStreamChunk(res, {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: responseModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      writeOpenAIStreamDone(res);
    });
  };

  const emitError = (message) => {
    console.error(`[phase] emit-error  elapsed=${Date.now() - startedAt}ms  session=${opencodeSessionId}  msg=${message}`);
    streamDebug(`emit error session=${opencodeSessionId} message=${message}`);
    ensureHeadersSent();

    if (mode === "bridge") {
      enqueueWrite(() => {
        writeSSE(res, "error", { success: false, sessionId: opencodeSessionId, error: message });
      });
      return;
    }

    enqueueWrite(() => {
      writeOpenAIStreamChunk(res, {
        error: { message, type: "server_error" },
      });
      writeOpenAIStreamDone(res);
    });
  };

  const finalizeFromEvent = (reason) => {
    if (!receivedAnyDelta && !fullText) {
      streamDebug(`skip event-done reason=${reason} session=${opencodeSessionId} no-content-yet`);
      return;
    }
    emitDone(reason);
    closeStream();
  };

  res.on("close", () => {
    closed = true;
    cleanup();
  });

  try {
    let resolveStreamReady;
    let rejectStreamReady;
    const streamReady = new Promise((resolve, reject) => {
      resolveStreamReady = resolve;
      rejectStreamReady = reject;
    });

    const eventURL = new URL(`${OPENCODE_BASE}/event`);
    const eventOptions = {
      hostname: eventURL.hostname,
      port: eventURL.port || 80,
      path: eventURL.pathname + eventURL.search,
      method: "GET",
      headers: { Accept: "text/event-stream" },
    };

    eventReq = http.request(eventOptions, (eventRes) => {
      if (eventRes.statusCode >= 400) {
        let upstreamError = "";
        eventRes.on("data", (chunk) => (upstreamError += chunk.toString("utf8")));
        eventRes.on("end", () => {
          rejectStreamReady(new Error(`event stream HTTP ${eventRes.statusCode}: ${upstreamError || "upstream error"}`));
          if (!closed) {
            emitError(`event stream HTTP ${eventRes.statusCode}: ${upstreamError || "upstream error"}`);
            closeStream();
          }
        });
        return;
      }

      resolveStreamReady();

      const parseChunk = createSSEParser(({ data }) => {
        if (closed || !data || typeof data !== "object") return;

        const event = data;
        const type = event.type;
        const props = event.properties || {};

        if (type === "message.updated") {
          const info = props.info || {};
          const infoSessionID = pickFirst(info, ["sessionID", "sessionId", "session_id"]);
          if (infoSessionID !== opencodeSessionId) return;

          const infoID = pickFirst(info, ["id", "messageID", "messageId", "message_id"]);
          const parentID = pickFirst(info, ["parentID", "parentId", "parent_id"]);

          if (info.role === "user" && infoID === userMessageID) {
            promptAccepted = true;
            return;
          }

          if (info.role === "assistant" && !assistantMessageID && promptAccepted) {
            assistantMessageID = infoID || assistantMessageID;
          }

          if (info.role === "assistant" && parentID === userMessageID) {
            assistantMessageID = infoID;
            if (info.time && info.time.completed) {
              finalizeFromEvent("assistant-parent-completed");
            }
            return;
          }

          if (assistantMessageID && infoID === assistantMessageID && info.time && info.time.completed) {
            finalizeFromEvent("assistant-message-completed");
          }
          return;
        }

        if (type === "message.part.updated") {
          const part = props.part || {};
          const partSessionID = pickFirst(part, ["sessionID", "sessionId", "session_id"]);
          const partMessageID = pickFirst(part, ["messageID", "messageId", "message_id"]);

          if (partSessionID !== opencodeSessionId || part.type !== "text") return;
          if (partMessageID === userMessageID) return;

          if (!assistantMessageID && partMessageID && partMessageID !== userMessageID) {
            assistantMessageID = partMessageID;
          }

          if (assistantMessageID && partMessageID && partMessageID !== assistantMessageID) return;

          let delta = typeof props.delta === "string" ? props.delta : "";
          if (!delta && typeof part.text === "string" && part.text.length > fullText.length) {
            if (part.text.startsWith(fullText)) {
              delta = part.text.slice(fullText.length);
            } else {
              delta = part.text;
            }
          }

          if (delta) {
            const filtered = echoFilter.apply(delta);
            if (!filtered) return;
            fullText += filtered;
            emitDelta(filtered);

            // 检测 playbook manual_gate：opencode 输出 WAITING_FOR_USER_INPUT 后暂停等待下一轮输入
            // bridge 收到该标记后立即结束当前流，把提示语返回给用户，避免无限挂起
            if (filtered.includes("WAITING_FOR_USER_INPUT") || fullText.includes("WAITING_FOR_USER_INPUT")) {
              console.log(`[manual-gate] detected WAITING_FOR_USER_INPUT, closing stream session=${opencodeSessionId}`);
              finalizeFromEvent("manual-gate-token");
              return;
            }
          } else if (BRIDGE_STREAM_DEBUG && typeof part.text === "string") {
            streamDebug(`part without delta session=${opencodeSessionId} messageID=${partMessageID || "unknown"} partTextLen=${part.text.length}`);
          }
          return;
        }

        const sessionID = pickFirst(props, ["sessionID", "sessionId", "session_id"]);
        if (type === "session.status" && sessionID === opencodeSessionId) {
          // opencode 进入 waiting 状态说明是 manual_gate，立即结束当前流
          const statusType = props.status && props.status.type;
          const canFinalize = messageAccepted || turnHasActivity || receivedAnyDelta || !!assistantMessageID;
          if ((statusType === "idle" || statusType === "waiting") && canFinalize) {
            finalizeFromEvent(`session-status-${statusType}`);
          }
          return;
        }

        if (type === "session.idle" && sessionID === opencodeSessionId && (messageAccepted || turnHasActivity || receivedAnyDelta || !!assistantMessageID)) {
          finalizeFromEvent("session-idle");
          return;
        }

        // opencode 专用：session 进入等待用户输入状态（playbook manual_gate）
        if (type === "session.waiting" && sessionID === opencodeSessionId && (messageAccepted || turnHasActivity || receivedAnyDelta || !!assistantMessageID)) {
          console.log(`[manual-gate] session.waiting event, closing stream session=${opencodeSessionId}`);
          finalizeFromEvent("session-waiting");
          return;
        }

        if (type === "session.error") {
          if (!sessionID || sessionID === opencodeSessionId) {
            const err = props.error;
            const message =
              (err && err.data && err.data.message) ||
              (err && err.name) ||
              "session error";
            emitError(message);
            closeStream();
          }
        }
      });

      eventRes.on("data", parseChunk);
      eventRes.on("end", () => {
        if (!closed) {
          emitError("upstream event stream ended unexpectedly");
          closeStream();
        }
      });
    });

    eventReq.on("error", (err) => {
      rejectStreamReady(err);
      if (!closed) {
        emitError(`event stream error: ${err.message}`);
        closeStream();
      }
    });

    eventReq.setTimeout(300000, () => {
      eventReq.destroy(new Error("event stream timeout"));
    });

    eventReq.end();

    const t_event = Date.now();
    await Promise.race([
      streamReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error("event stream connect timeout")), 10000)),
    ]);
    console.log(`[phase] event-stream-ready ${Date.now() - t_event}ms  session=${opencodeSessionId}`);

    const t_msg = Date.now();
    console.log(`[phase] sending-message  session=${opencodeSessionId}  prompt=${prompt.slice(0, 60)}`);
    // message POST 超时由 MESSAGE_POST_TIMEOUT_MS 控制（默认 300s，可通过 BRIDGE_MESSAGE_TIMEOUT_MS 调整）
    const messagePromise = fetchJSON(`${OPENCODE_BASE}/session/${opencodeSessionId}/message`, {
      method: "POST",
      body: { messageID: userMessageID, parts: [{ type: "text", text: prompt }] },
      rejectOnHTTPError: true,
      timeoutMs: MESSAGE_POST_TIMEOUT_MS,
    });

    messagePromise
      .then(async (messageResponse) => {
        console.log(`[phase] message-accepted ${Date.now() - t_msg}ms  session=${opencodeSessionId}`);
        messageAccepted = true;
        turnHasActivity = true;
        if (closed || completed) return;

        // 若上游事件流没有任何 delta，则回退到完整响应，避免长时间挂起
        if (!receivedAnyDelta) {
          streamDebug(`no delta from events, try fallback session=${opencodeSessionId}`);
          let text = extractText(messageResponse);

          if (!text) {
            // 慢模型（如 minimax）推理时间可能超过 2 分钟，加大轮询次数和间隔
            text = await pollAssistantTextFromSession(opencodeSessionId, { attempts: 180, intervalMs: 1500 });
          }

          if (text) {
            const filtered = echoFilter.apply(text);
            if (filtered) {
              fullText += filtered;
              emitDelta(filtered);
            }
          }
        }

        if (!fullText && !receivedAnyDelta) {
          emitError("upstream returned empty assistant content");
          closeStream();
          return;
        }

        emitDone();
        closeStream();
      })
      .catch(async (err) => {
        if (closed || completed) return;

        if (err && err.message === "Request timeout" && receivedAnyDelta) {
          emitDone("message-timeout-after-delta");
          closeStream();
          return;
        }

        if (err && err.message === "Request timeout" && !receivedAnyDelta) {
          streamDebug(`message timeout, polling fallback session=${opencodeSessionId}`);
          const fallbackText = await pollAssistantTextFromSession(opencodeSessionId, { attempts: 40, intervalMs: 1500 });
          if (fallbackText) {
            const filtered = echoFilter.apply(fallbackText);
            if (filtered) {
              fullText += filtered;
              emitDelta(filtered);
            }
            emitDone("message-timeout-fallback");
            closeStream();
            return;
          }
        }

        if (err && err.message === "Request timeout") {
          evictSessionMapping("message-timeout");
        }
        emitError(err.message || "message request failed");
        closeStream();
      });

    promptAccepted = true;

    // 最长等待 5 分钟；若上游完全无有效消息则返回错误，避免无限挂起
    setTimeout(() => {
      if (closed) return;
      if (Date.now() - startedAt < 300000) return;
      evictSessionMapping("stream-overall-timeout");
      emitError("upstream did not produce completion in time");
      closeStream();
    }, 300000);
  } catch (err) {
    emitError(err.message);
    closeStream();
  }
}

// ─── HTTP Server ──────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const requestURL = new URL(req.url, "http://localhost");
  const pathname = requestURL.pathname;
  const normalizedPath =
    pathname
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "") || "/";
  const hasPathSuffix = (suffix) => normalizedPath === suffix || normalizedPath.endsWith(suffix);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── OpenAI-compatible APIs (for n8n Chat Model) ──────────────
  if (req.method === "GET" && (hasPathSuffix("/v1/models") || hasPathSuffix("/models"))) {
    const modelId = DEFAULT_MODEL;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: modelId,
            object: "model",
            created: 0,
            owned_by: "opencode-bridge",
          },
        ],
      })
    );
    return;
  }

  if (req.method === "GET" && /\/models\/.+/.test(normalizedPath)) {
    const modelId = extractModelIdFromPath(normalizedPath);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: modelId,
        object: "model",
        created: 0,
        owned_by: "opencode-bridge",
      })
    );
    return;
  }

  if (req.method === "POST" && /\/chat\/completions$/.test(normalizedPath)) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid JSON body", type: "invalid_request_error" } }));
        return;
      }

      const { prompt, n8nSessionId, model, systemPrompt } = extractOpenAIInput(parsed);
      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "messages or prompt is required", type: "invalid_request_error" } }));
        return;
      }

      const responseModel = model || DEFAULT_MODEL;
      const completionId = createCompletionID();
      const created = Math.floor(Date.now() / 1000);

      if (parsed.stream === true) {
        await handleStreamRequest(
          req,
          res,
          { prompt, n8nSessionId, model: responseModel, systemPrompt },
          {
            mode: "openai",
            completionId,
            created,
            responseModel,
          }
        );
        return;
      }

      try {
        const opencodeSessionId = await resolveOpencodeSession(n8nSessionId, responseModel, true, systemPrompt);
        console.log(`[OpenAI兼容消息] ${prompt.slice(0, 80)}`);

        const msgResponse = await fetchJSON(`${OPENCODE_BASE}/session/${opencodeSessionId}/message`, {
          method: "POST",
          body: { parts: [{ type: "text", text: prompt }] },
          rejectOnHTTPError: true,
        });

        const result = extractText(msgResponse);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            buildOpenAIChatCompletion({
              completionId,
              created,
              model: responseModel,
              content: result,
            })
          )
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "server_error" } }));
      }
    });
    return;
  }

  // ── POST /chat ────────────────────────────────────────────────
  if (req.method === "POST" && normalizedPath === "/chat") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { prompt, sessionId: n8nSessionId, model } = JSON.parse(body);
        if (!prompt) throw new Error("prompt is required");

        let opencodeSessionId = sessionMap.get(n8nSessionId);
        if (!opencodeSessionId) {
          const session = await fetchJSON(`${OPENCODE_BASE}/session`, {
            method: "POST",
            body: { model: model || DEFAULT_MODEL },
            rejectOnHTTPError: true,
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

  // ── POST /chat/n8n (tool-friendly, non-stream) ───────────────
  if (req.method === "POST" && normalizedPath === "/chat/n8n") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
        return;
      }

      try {
        const { prompt, n8nSessionId, model } = extractN8nInput(parsed);
        if (!prompt) throw new Error("prompt is required");

        const opencodeSessionId = await resolveOpencodeSession(n8nSessionId, model, true);
        console.log(`[n8n工具消息] ${prompt.slice(0, 80)}`);

        const msgResponse = await fetchJSON(`${OPENCODE_BASE}/session/${opencodeSessionId}/message`, {
          method: "POST",
          body: { parts: [{ type: "text", text: prompt }] },
          rejectOnHTTPError: true,
        });

        const result = extractText(msgResponse);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            sessionId: opencodeSessionId,
            output: result,
            result,
          })
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // ── POST /chat/stream (SSE) ───────────────────────────────────
  if (req.method === "POST" && normalizedPath === "/chat/stream") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const input = extractN8nInput(parsed);
        await handleStreamRequest(req, res, input);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "invalid JSON body" }));
      }
    });
    return;
  }

  // ── GET /chat/n8n/stream (SSE, query params) ─────────────────
  if (req.method === "GET" && normalizedPath === "/chat/n8n/stream") {
    const parsed = {
      prompt: requestURL.searchParams.get("prompt"),
      sessionId: requestURL.searchParams.get("sessionId"),
      session_id: requestURL.searchParams.get("session_id"),
      model: requestURL.searchParams.get("model"),
    };
    const input = extractN8nInput(parsed);
    handleStreamRequest(req, res, input);
    return;
  }

  // ── GET /health ───────────────────────────────────────────────
  if (normalizedPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessions: sessionMap.size, opencode: OPENCODE_BASE }));
    return;
  }

  res.writeHead(404);
  console.warn(`[404] ${req.method} ${pathname}`);
  res.end("Not found");
});

server.listen(BRIDGE_PORT, "0.0.0.0", () => {
  console.log(`✅ OpenCode Bridge v4 (K8s) @ http://0.0.0.0:${BRIDGE_PORT}`);
  console.log(`   OpenCode Backend: ${OPENCODE_BASE}`);
  console.log(`   Default Model:    ${DEFAULT_MODEL}`);
  console.log(`   Stream ChunkSize: ${OPENAI_STREAM_CHUNK_SIZE}`);
  console.log(`   Stream ChunkDelay: ${OPENAI_STREAM_CHUNK_DELAY_MS}ms`);
  console.log(`   Message Timeout:  ${MESSAGE_POST_TIMEOUT_MS}ms`);
  console.log(`   Silence Timeout:  ${SILENCE_TIMEOUT_MS}ms`);
});