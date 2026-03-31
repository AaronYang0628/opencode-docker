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
const MESSAGE_POST_TIMEOUT_MS = Math.max(10000, parseInt(process.env.BRIDGE_MESSAGE_TIMEOUT_MS || "300000", 10) || 300000);
const SILENCE_TIMEOUT_MS = Math.max(0, parseInt(process.env.BRIDGE_SILENCE_TIMEOUT_MS || "0", 10) || 0);

// N8N sessionId → OpenCode sessionId 映射（多轮对话）
const sessionMap = new Map();

// 每个 OpenCode session 的请求队列：同一 session 同时只允许一个请求在 waitForOpencodeResult 中运行
// 防止 n8n AI Agent 并发调用 LLM 时多个订阅者争抢同一个 session.idle 事件
const sessionQueue = new Map(); // opencodeSessionId -> Promise (tail of queue)

function enqueueSessionRequest(queueKey, fn) {
  const prev = sessionQueue.get(queueKey) || Promise.resolve();
  const isQueued = sessionQueue.has(queueKey);
  if (isQueued) {
    console.log(`[queue] waiting  key=${String(queueKey).slice(0, 24)}`);
  }
  const next = prev.then(() => {
    console.log(`[queue] running  key=${String(queueKey).slice(0, 24)}`);
    return fn();
  }).catch((err) => { throw err; });
  // Store a "silent" version that never rejects (so the queue keeps moving)
  sessionQueue.set(queueKey, next.catch(() => {}));
  return next;
}

// ─── 统计数据 ────────────────────────────────────────────────
// Bridge 启动时间
const BRIDGE_START_TIME = Date.now();

// ─── 全局共享 SSE 事件流 ──────────────────────────────────────
// OpenCode /event 是全局流，包含所有 session 的事件。
// 用单一连接 + 订阅者分发，避免多个并发请求各自连接导致的：
//   1. 事件被某个连接独占消费，其他连接漏收
//   2. OpenCode 并发 SSE 连接限制
//   3. 多请求互相干扰（错乱根本原因）
const globalEventBus = {
  req: null,
  connected: false,
  reconnectTimer: null,
  subscribers: new Map(),
  _subIdCounter: 0,

  // connectedPromise: resolves when the SSE connection is confirmed ready.
  // All senders must await this before posting messages, so no events are
  // missed between "message sent" and "connection established".
  _connectedResolve: null,
  connectedPromise: null,

  _initPromise() {
    if (this.connectedPromise) return;
    this.connectedPromise = new Promise((resolve) => {
      this._connectedResolve = resolve;
    });
  },

  // waitReady: await this before sending any message to OpenCode.
  // Resolves immediately if already connected, otherwise waits up to timeoutMs.
  async waitReady(timeoutMs = 10000) {
    if (this.connected) return;
    this._initPromise();
    return Promise.race([
      this.connectedPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("event-bus connect timeout")), timeoutMs)
      ),
    ]);
  },

  subscribe(opencodeSessionId, callback) {
    const id = ++this._subIdCounter;
    this.subscribers.set(id, { opencodeSessionId, callback });
    this._ensureConnected();
    return id;
  },

  unsubscribe(subscriptionId) {
    this.subscribers.delete(subscriptionId);
  },

  _dispatch(event) {
    const data = event && event.data;
    const props = (data && data.properties) || {};
    let eventSessionId = null;
    if (props.info)  eventSessionId = props.info.sessionID  || props.info.sessionId  || props.info.session_id  || null;
    if (!eventSessionId && props.part) eventSessionId = props.part.sessionID || props.part.sessionId || props.part.session_id || null;
    if (!eventSessionId) eventSessionId = props.sessionID || props.sessionId || props.session_id || null;

    for (const [, sub] of this.subscribers) {
      if (eventSessionId && sub.opencodeSessionId && eventSessionId !== sub.opencodeSessionId) continue;
      try { sub.callback(event); } catch {}
    }
  },

  _ensureConnected() {
    if (this.connected || this.req) return;
    this._connect();
  },

  _connect() {
    if (this.req) return;
    this._initPromise();
    const u = new URL(`${OPENCODE_BASE}/event`);
    const opts = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: "GET",
      headers: { Accept: "text/event-stream" },
    };
    const req = http.request(opts, (res) => {
      if (res.statusCode >= 400) {
        console.error(`[event-bus] connect failed HTTP ${res.statusCode}`);
        res.resume();
        this._scheduleReconnect();
        return;
      }
      this.connected = true;
      this.req = req;
      console.log("[event-bus] connected to OpenCode /event");
      // Resolve the connectedPromise so any waiting senders can proceed
      if (this._connectedResolve) {
        this._connectedResolve();
        this._connectedResolve = null;
        this.connectedPromise = null; // reset for next reconnect cycle
      }

      const parse = createSSEParser((ev) => this._dispatch(ev));
      res.on("data", parse);
      res.on("end", () => {
        console.warn("[event-bus] stream ended, reconnecting...");
        this.connected = false;
        this.req = null;
        this._scheduleReconnect();
      });
    });
    req.on("error", (err) => {
      console.error(`[event-bus] error: ${err.message}`);
      this.connected = false;
      this.req = null;
      this._scheduleReconnect();
    });
    req.setTimeout(0);
    req.end();
    this.req = req;
  },

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.req = null;
      this._connect(); // always reconnect, not just when subscribers exist
    }, 2000);
  },
};

// Connect to OpenCode /event immediately on bridge startup.
// This eliminates the race where LLM responds before the SSE connection
// is established, causing events to be missed entirely.
globalEventBus._connect();

// 请求计数器
const stats = {
  totalRequests: 0,
  successRequests: 0,
  errorRequests: 0,
  timeoutRequests: 0,
};

// 每个 OpenCode session 的详细指标
// key: opencodeSessionId, value: SessionMetrics
const sessionMetrics = new Map();

function getOrCreateMetrics(opencodeSessionId, n8nSessionId) {
  if (!sessionMetrics.has(opencodeSessionId)) {
    sessionMetrics.set(opencodeSessionId, {
      opencodeSessionId,
      n8nSessionId: n8nSessionId || null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      turns: 0,           // 完成的对话轮次
      errors: 0,
      timeouts: 0,
      ttftSamples: [],    // 首 token 延迟样本 (ms)
      durationSamples: [], // 完整响应时长样本 (ms)
      // token 用量（从 OpenCode API 拉取后填充）
      inputTokens: 0,
      outputTokens: 0,
      lastFetchedAt: 0,
    });
  }
  return sessionMetrics.get(opencodeSessionId);
}

function recordTurnStart(opencodeSessionId, n8nSessionId) {
  const m = getOrCreateMetrics(opencodeSessionId, n8nSessionId);
  m.lastActiveAt = Date.now();
  stats.totalRequests++;
  return Date.now();
}

function recordFirstDelta(opencodeSessionId, startedAt) {
  const m = sessionMetrics.get(opencodeSessionId);
  if (!m) return;
  const ttft = Date.now() - startedAt;
  m.ttftSamples.push(ttft);
  if (m.ttftSamples.length > 50) m.ttftSamples.shift();
}

function recordTurnDone(opencodeSessionId, startedAt, success) {
  const m = sessionMetrics.get(opencodeSessionId);
  if (!m) return;
  m.lastActiveAt = Date.now();
  if (success) {
    m.turns++;
    stats.successRequests++;
    const duration = Date.now() - startedAt;
    m.durationSamples.push(duration);
    if (m.durationSamples.length > 50) m.durationSamples.shift();
  } else {
    m.errors++;
    stats.errorRequests++;
  }
}

function recordTimeout(opencodeSessionId) {
  const m = sessionMetrics.get(opencodeSessionId);
  if (m) { m.timeouts++; m.lastActiveAt = Date.now(); }
  stats.timeoutRequests++;
  stats.errorRequests++;
}

function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

// 从 OpenCode API 拉取单个 session 的 token 用量
async function fetchSessionTokens(opencodeSessionId) {
  try {
    const messages = await fetchJSON(`${OPENCODE_BASE}/session/${opencodeSessionId}/messages`, {
      method: "GET",
      timeoutMs: 10000,
    });
    if (!Array.isArray(messages)) return null;

    let inputTokens = 0;
    let outputTokens = 0;
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const t = msg.tokens || msg.usage || {};
      inputTokens  += t.input  || t.prompt_tokens     || t.inputTokens  || 0;
      outputTokens += t.output || t.completion_tokens || t.outputTokens || 0;
    }
    return { inputTokens, outputTokens };
  } catch {
    return null;
  }
}

// 批量刷新所有 session 的 token 用量（后台定时任务）
async function refreshAllTokenStats() {
  const now = Date.now();
  for (const [sid, m] of sessionMetrics) {
    // 超过 5 分钟没活动的 session 不频繁刷新
    const staleSec = (now - m.lastActiveAt) / 1000;
    const refreshInterval = staleSec > 300 ? 300000 : 60000;
    if (now - m.lastFetchedAt < refreshInterval) continue;

    const result = await fetchSessionTokens(sid);
    if (result) {
      m.inputTokens  = result.inputTokens;
      m.outputTokens = result.outputTokens;
      m.lastFetchedAt = Date.now();
    }
  }
}

// 每分钟刷新一次 token 统计
setInterval(() => { refreshAllTokenStats().catch(() => {}); }, 60000);

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
      getOrCreateMetrics(opencodeSessionId, validId);
    } else {
      console.log(`[phase] create-session ${elapsed}ms  n8n:(no sessionId) -> opencode:${opencodeSessionId}`);
      getOrCreateMetrics(opencodeSessionId, null);
    }

    // system prompt 不再通过消息注入：
    // 发消息会触发 OpenCode 进行一次 LLM 推理，产生 session.idle 事件，
    // 被后续的 waitForResult 订阅者误消费，导致真正的用户消息丢失。
    // n8n 注入的 system prompt 内容只是 sessionId，对 OpenCode 无意义，直接忽略。
    if (systemPrompt && systemPrompt.trim()) {
      console.log(`[phase] skip-system-prompt  len=${systemPrompt.length}  session=${opencodeSessionId}  reason=avoids-spurious-idle-event`);
    }
  } else {
    console.log(`[phase] reuse-session  n8n:${validId ? validId.slice(0,20) : "none"} -> opencode:${opencodeSessionId}`);
  }
  return opencodeSessionId;
}

// ─── waitForOpencodeResult ───────────────────────────────────
// 非流式路径的核心：通过 globalEventBus 等待 OpenCode 推理完成，返回完整文本
// 相比 poll 轮询，事件驱动响应更及时，且不会在 playbook 等长耗时任务上超时

async function waitForOpencodeResult(opencodeSessionId, prompt, timeoutMs = 300000) {
  const userMessageID = createMessageID();
  const startedAt = Date.now();

  return new Promise(async (resolve, reject) => {
    let subId = null;
    let done = false;
    let fullText = "";
    let assistantMessageID = null;
    let promptAccepted = false;
    let silenceTimer = null;

    const finish = (text, err) => {
      if (done) return;
      done = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      if (subId !== null) {
        globalEventBus.unsubscribe(subId);
        subId = null;
      }
      if (err) {
        reject(err);
      } else {
        resolve(text || "");
      }
    };

    // 重置静默计时器：收到 delta 后，若 SILENCE_TIMEOUT_MS 内无新 delta 则视为完成
    const resetSilence = () => {
      if (SILENCE_TIMEOUT_MS <= 0) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        console.log(`[waitForResult] silence-timeout  elapsed=${Date.now()-startedAt}ms  session=${opencodeSessionId}`);
        finish(fullText, null);
      }, SILENCE_TIMEOUT_MS);
    };

    // 整体超时：evict session mapping，确保下次请求使用新的 OpenCode session
    // 避免 playbook 等长耗时任务卡住后，后续消息也卡在同一个 stuck session
    const overallTimer = setTimeout(() => {
      console.error(`[waitForResult] overall-timeout  elapsed=${Date.now()-startedAt}ms  session=${opencodeSessionId}`);
      // 清除 sessionMap 里的映射，下次请求会创建新的干净 session
      for (const [k, v] of sessionMap) {
        if (v === opencodeSessionId) {
          sessionMap.delete(k);
          console.warn(`[waitForResult] evicted stuck session  n8n:${k.slice(0,20)} -> opencode:${opencodeSessionId}`);
        }
      }
      finish(fullText || null, fullText ? null : new Error("waitForOpencodeResult timeout"));
    }, timeoutMs);

    const processEvent = ({ data }) => {
      if (done || !data || typeof data !== "object") return;
      const type = data.type;
      const props = data.properties || {};

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
        if (info.role === "assistant" && parentID === userMessageID) {
          assistantMessageID = infoID;
          if (info.time && info.time.completed) {
            clearTimeout(overallTimer);
            finish(fullText, null);
          }
          return;
        }
        if (assistantMessageID && infoID === assistantMessageID && info.time && info.time.completed) {
          clearTimeout(overallTimer);
          finish(fullText, null);
        }
        return;
      }

      if (type === "message.part.updated") {
        const part = props.part || {};
        const partSessionID = pickFirst(part, ["sessionID", "sessionId", "session_id"]);
        const partMessageID = pickFirst(part, ["messageID", "messageId", "message_id"]);
        if (partSessionID !== opencodeSessionId || part.type !== "text") return;
        if (partMessageID === userMessageID) return;
        if (!assistantMessageID && partMessageID) assistantMessageID = partMessageID;
        if (partMessageID !== assistantMessageID) return;

        let delta = typeof props.delta === "string" ? props.delta : "";
        if (!delta && typeof part.text === "string" && part.text.length > fullText.length) {
          delta = part.text.startsWith(fullText) ? part.text.slice(fullText.length) : part.text;
        }
        if (delta) {
          fullText += delta;
          resetSilence();
          if (delta.includes("WAITING_FOR_USER_INPUT") || fullText.includes("WAITING_FOR_USER_INPUT")) {
            clearTimeout(overallTimer);
            finish(fullText, null);
          }
        }
        return;
      }

      const sessionID = pickFirst(props, ["sessionID", "sessionId", "session_id"]);
      const statusType = props.status && props.status.type;
      if (type === "session.status" && sessionID === opencodeSessionId) {
        if ((statusType === "idle" || statusType === "waiting") && promptAccepted && fullText) {
          clearTimeout(overallTimer);
          finish(fullText, null);
        }
        return;
      }
      if ((type === "session.idle" || type === "session.waiting") && sessionID === opencodeSessionId && promptAccepted && fullText) {
        clearTimeout(overallTimer);
        finish(fullText, null);
        return;
      }
      if (type === "session.error" && (!sessionID || sessionID === opencodeSessionId)) {
        const err = props.error;
        clearTimeout(overallTimer);
        finish(null, new Error((err && (err.data && err.data.message || err.name)) || "session error"));
      }
    };

    subId = globalEventBus.subscribe(opencodeSessionId, processEvent);
    console.log(`[waitForResult] subscribed  session=${opencodeSessionId}  subId=${subId}`);

    // 等待 SSE 连接就绪，再发消息，彻底消除"消息比连接快"的竞态
    try { await globalEventBus.waitReady(8000); } catch (e) {
      console.warn(`[waitForResult] waitReady timeout: ${e.message}, proceeding anyway`);
    }

    // promptAccepted 在发消息前设为 true，避免遗漏早期事件
    promptAccepted = true;

    try {
      await fetchJSON(`${OPENCODE_BASE}/session/${opencodeSessionId}/message`, {
        method: "POST",
        body: { messageID: userMessageID, parts: [{ type: "text", text: prompt }] },
        rejectOnHTTPError: true,
        timeoutMs: 30000,  // message POST 本身只是提交，30s 够了
      });
      console.log(`[waitForResult] message sent  session=${opencodeSessionId}`);
    } catch (err) {
      clearTimeout(overallTimer);
      finish(null, err);
    }
  });
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

  const turnStartedAt = recordTurnStart(opencodeSessionId, n8nSessionId);
  // 每轮请求的唯一 ID，用于日志追踪，排查对话错乱
  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  console.log(`[request] start  id=${requestId}  session=${opencodeSessionId}  msgId=${userMessageID}`);

  let closed = false;
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
    if (subId !== null) {
      globalEventBus.unsubscribe(subId);
      console.log(`[phase] unsubscribed  id=${requestId}  session=${opencodeSessionId}  subId=${subId}  remainingSubs=${globalEventBus.subscribers.size}`);
      subId = null;
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
    const isFirstDelta = !receivedAnyDelta;
    receivedAnyDelta = true;
    streamDebug(`emit delta session=${opencodeSessionId} len=${text.length} mode=${mode}`);
    if (isFirstDelta) {
      console.log(`[phase] first-delta  elapsed=${Date.now() - startedAt}ms  session=${opencodeSessionId}`);
      recordFirstDelta(opencodeSessionId, turnStartedAt);
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
    recordTurnDone(opencodeSessionId, turnStartedAt, true);
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
    recordTurnDone(opencodeSessionId, turnStartedAt, false);
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
    // 用全局共享 SSE 连接，彻底避免多请求并发时事件串流/错乱
    let subId = null;

    const processEvent = ({ data }) => {
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
            turnHasActivity = true;
            return;
          }

          // 【防错乱】assistantMessageID 必须通过 parentID === userMessageID 精确认领
          // 不再用宽松的 promptAccepted 条件，避免认领到其他并发请求的 assistant message
          if (info.role === "assistant" && parentID === userMessageID) {
            assistantMessageID = infoID;
            turnHasActivity = true;
            if (info.time && info.time.completed) {
              finalizeFromEvent("assistant-parent-completed");
            }
            return;
          }

          // 已认领的 assistant message 完成事件
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

          // assistantMessageID 认领：事件已由 _dispatch 按 sessionId 预过滤，
          // 只要不是 user 消息的 part 就可以安全认领
          if (!assistantMessageID && partMessageID && partMessageID !== userMessageID) {
            assistantMessageID = partMessageID;
            turnHasActivity = true;
          }

          // 未认领到 assistantMessageID 则忽略
          if (!assistantMessageID) return;
          if (partMessageID !== assistantMessageID) return;

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
          // 【防错乱】必须 promptAccepted，确保是本轮消息触发的 idle/waiting
          const canFinalize = promptAccepted && (messageAccepted || turnHasActivity || receivedAnyDelta || !!assistantMessageID);
          if ((statusType === "idle" || statusType === "waiting") && canFinalize) {
            finalizeFromEvent(`session-status-${statusType}`);
          } else if (BRIDGE_STREAM_DEBUG && (statusType === "idle" || statusType === "waiting")) {
            streamDebug(`skip session.status ${statusType}  promptAccepted=${promptAccepted}  session=${opencodeSessionId}`);
          }
          return;
        }

        if (type === "session.idle" && sessionID === opencodeSessionId && promptAccepted && (messageAccepted || turnHasActivity || receivedAnyDelta || !!assistantMessageID)) {
          finalizeFromEvent("session-idle");
          return;
        }

        // opencode 专用：session 进入等待用户输入状态（playbook manual_gate）
        if (type === "session.waiting" && sessionID === opencodeSessionId && promptAccepted && (messageAccepted || turnHasActivity || receivedAnyDelta || !!assistantMessageID)) {
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
    };

    // 订阅全局事件总线，只接收本 session 的事件
    subId = globalEventBus.subscribe(opencodeSessionId, processEvent);
    console.log(`[phase] subscribed  id=${requestId}  session=${opencodeSessionId}  subId=${subId}  totalSubs=${globalEventBus.subscribers.size}`);

    // 等待 SSE 连接就绪，再发消息，彻底消除"消息比连接快"的竞态
    try { await globalEventBus.waitReady(8000); } catch (e) {
      console.warn(`[phase] waitReady timeout: ${e.message}, proceeding anyway  session=${opencodeSessionId}`);
    }

    // promptAccepted = true 必须在发送消息之前设置
    // 事件流在消息发出后立刻开始推送，晚于消息发出设置会导致早期 delta 被丢弃
    promptAccepted = true;

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
          recordTimeout(opencodeSessionId);
        }
        emitError(err.message || "message request failed");
        closeStream();
      });

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

// ─── 工具：时间格式化 ─────────────────────────────────────────

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function timeAgo(ts) {
  if (!ts) return "-";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "刚刚";
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

// ─── Dashboard HTML ───────────────────────────────────────────

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCode Bridge Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}
  .topbar{background:#1a1d27;border-bottom:1px solid #2d3148;padding:16px 24px;display:flex;align-items:center;gap:16px}
  .topbar h1{font-size:16px;font-weight:600;color:#fff}
  .topbar .badge{background:#6366f1;color:#fff;font-size:11px;padding:2px 8px;border-radius:20px}
  .refresh-btn{margin-left:auto;background:#6366f1;color:#fff;border:none;padding:7px 16px;border-radius:8px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:6px}
  .refresh-btn:hover{background:#5558e3}
  .refresh-btn.loading{opacity:.6;pointer-events:none}
  .container{padding:24px;max-width:1400px;margin:0 auto}
  .summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:28px}
  .card{background:#1a1d27;border:1px solid #2d3148;border-radius:12px;padding:20px}
  .card-label{font-size:12px;color:#8892b0;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
  .card-value{font-size:28px;font-weight:700;color:#e2e8f0}
  .card-value.green{color:#34d399}
  .card-value.blue{color:#60a5fa}
  .card-value.amber{color:#fbbf24}
  .card-value.red{color:#f87171}
  .card-sub{font-size:12px;color:#8892b0;margin-top:4px}
  .section-title{font-size:14px;font-weight:600;color:#a0aec0;margin-bottom:14px;display:flex;align-items:center;gap:8px}
  .section-title .dot{width:6px;height:6px;border-radius:50%;background:#6366f1}
  table{width:100%;border-collapse:collapse;background:#1a1d27;border:1px solid #2d3148;border-radius:12px;overflow:hidden}
  th{text-align:left;padding:12px 16px;font-size:11px;font-weight:600;color:#8892b0;text-transform:uppercase;letter-spacing:.05em;background:#151721;border-bottom:1px solid #2d3148}
  td{padding:12px 16px;font-size:13px;border-bottom:1px solid #1e2235;vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#1e2235}
  .session-id{font-family:monospace;font-size:11px;color:#8892b0}
  .tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}
  .tag-active{background:#1a2e1a;color:#34d399;border:1px solid #2d4a2d}
  .tag-idle{background:#1e2235;color:#8892b0;border:1px solid #2d3148}
  .tag-error{background:#2e1a1a;color:#f87171;border:1px solid #4a2d2d}
  .token-bar-wrap{display:flex;align-items:center;gap:8px}
  .token-bar{height:6px;background:#2d3148;border-radius:3px;flex:1;max-width:100px;overflow:hidden}
  .token-bar-fill{height:100%;background:#6366f1;border-radius:3px;transition:width .3s}
  .num{font-variant-numeric:tabular-nums}
  .empty{text-align:center;padding:48px;color:#4a5568}
  .last-refresh{font-size:12px;color:#4a5568;margin-top:12px;text-align:right}
  @keyframes spin{to{transform:rotate(360deg)}}
  .spin{animation:spin .8s linear infinite;display:inline-block}
</style>
</head>
<body>
<div class="topbar">
  <h1>🌉 OpenCode Bridge</h1>
  <span class="badge" id="status-badge">Loading...</span>
  <button class="refresh-btn" onclick="loadStats(true)" id="refresh-btn">
    <span id="refresh-icon">⟳</span> 刷新
  </button>
</div>
<div class="container">
  <div class="summary-grid" id="summary-grid">
    <div class="card"><div class="card-label">加载中</div><div class="card-value">...</div></div>
  </div>
  <div class="section-title"><span class="dot"></span> Session 列表</div>
  <div id="sessions-table-wrap">
    <div class="empty">加载中...</div>
  </div>
  <div class="last-refresh" id="last-refresh"></div>
</div>

<script>
let maxTotalTokens = 1;

function fmt(n) {
  if (!n) return "0";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(1)+"K";
  return String(n);
}
function fmtMs(ms) {
  if (!ms) return "-";
  if (ms < 1000) return ms+"ms";
  return (ms/1000).toFixed(1)+"s";
}
function timeAgo(ts) {
  if (!ts) return "-";
  const s = Math.floor((Date.now()-ts)/1000);
  if (s<5) return "刚刚";
  if (s<60) return s+"秒前";
  if (s<3600) return Math.floor(s/60)+"分钟前";
  if (s<86400) return Math.floor(s/3600)+"小时前";
  return Math.floor(s/86400)+"天前";
}
function fmtDur(ms) {
  const s=Math.floor(ms/1000);
  if(s<60) return s+"s";
  const m=Math.floor(s/60);
  if(m<60) return m+"m "+s%60+"s";
  const h=Math.floor(m/60);
  if(h<24) return h+"h "+m%60+"m";
  return Math.floor(h/24)+"d "+h%24+"h";
}
function statusTag(sess) {
  if (sess.errors > 0 && sess.turns === 0) return '<span class="tag tag-error">异常</span>';
  const idle = sess.idleSec;
  if (idle < 120) return '<span class="tag tag-active">活跃</span>';
  return '<span class="tag tag-idle">空闲</span>';
}

async function loadStats(force) {
  const btn = document.getElementById("refresh-btn");
  const icon = document.getElementById("refresh-icon");
  btn.classList.add("loading");
  icon.classList.add("spin");
  icon.textContent = "⟳";

  try {
    if (force) {
      await fetch("/stats/refresh");
      await new Promise(r => setTimeout(r, 1500));
    }
    const r = await fetch("/stats");
    const data = await r.json();
    renderDashboard(data);
  } catch(e) {
    document.getElementById("sessions-table-wrap").innerHTML =
      '<div class="empty">加载失败: ' + e.message + '</div>';
  } finally {
    btn.classList.remove("loading");
    icon.classList.remove("spin");
    icon.textContent = "⟳";
    document.getElementById("last-refresh").textContent =
      "最后刷新：" + new Date().toLocaleTimeString("zh-CN");
  }
}

function renderDashboard(data) {
  const b = data.bridge;
  const sessions = data.sessions || [];

  // Update badge
  document.getElementById("status-badge").textContent =
    b.activeSessionMappings + " active sessions";

  // Summary cards
  const totalIn = sessions.reduce((a,s)=>a+s.inputTokens,0);
  const totalOut = sessions.reduce((a,s)=>a+s.outputTokens,0);
  const totalTokens = totalIn + totalOut;
  const avgTtft = sessions.length
    ? Math.round(sessions.filter(s=>s.avgTtftMs).reduce((a,s)=>a+s.avgTtftMs,0)/sessions.filter(s=>s.avgTtftMs).length)
    : 0;

  document.getElementById("summary-grid").innerHTML = \`
    <div class="card">
      <div class="card-label">运行时长</div>
      <div class="card-value blue">\${fmtDur(b.uptime)}</div>
      <div class="card-sub">共处理 \${b.requests.totalRequests} 次请求</div>
    </div>
    <div class="card">
      <div class="card-label">成功率</div>
      <div class="card-value green">\${b.successRate}</div>
      <div class="card-sub">成功 \${b.requests.successRequests} / 失败 \${b.requests.errorRequests}</div>
    </div>
    <div class="card">
      <div class="card-label">超时次数</div>
      <div class="card-value \${b.requests.timeoutRequests>0?"amber":"green"}">\${b.requests.timeoutRequests}</div>
      <div class="card-sub">占总请求 \${b.requests.totalRequests>0?((b.requests.timeoutRequests/b.requests.totalRequests)*100).toFixed(1):0}%</div>
    </div>
    <div class="card">
      <div class="card-label">Session 总数</div>
      <div class="card-value">\${b.totalTrackedSessions}</div>
      <div class="card-sub">活跃映射 \${b.activeSessionMappings} 个</div>
    </div>
    <div class="card">
      <div class="card-label">Input Token</div>
      <div class="card-value blue">\${fmt(totalIn)}</div>
      <div class="card-sub">Output: \${fmt(totalOut)}</div>
    </div>
    <div class="card">
      <div class="card-label">总 Token 用量</div>
      <div class="card-value amber">\${fmt(totalTokens)}</div>
      <div class="card-sub">跨 \${sessions.length} 个 session</div>
    </div>
    <div class="card">
      <div class="card-label">平均首Token延迟</div>
      <div class="card-value \${avgTtft>5000?"amber":avgTtft>2000?"blue":"green"}">\${fmtMs(avgTtft)}</div>
      <div class="card-sub">TTFT (Time to First Token)</div>
    </div>
  \`;

  // Session table
  if (sessions.length === 0) {
    document.getElementById("sessions-table-wrap").innerHTML =
      '<div class="empty">暂无 Session 数据</div>';
    return;
  }

  maxTotalTokens = Math.max(1, ...sessions.map(s=>s.totalTokens));

  const rows = sessions.map(s => {
    const barWidth = maxTotalTokens > 0 ? Math.round((s.totalTokens/maxTotalTokens)*100) : 0;
    const sid = s.opencodeSessionId || "-";
    const shortSid = sid.length > 20 ? sid.slice(0,8)+"…"+sid.slice(-6) : sid;
    const n8nSid = s.n8nSessionId ? s.n8nSessionId.slice(0,16)+"…" : "-";
    return \`<tr>
      <td>
        <span class="session-id" title="\${sid}">\${shortSid}</span>
        <div class="session-id" style="margin-top:3px;font-size:10px;color:#4a5568" title="\${s.n8nSessionId||''}">\${n8nSid}</div>
      </td>
      <td>\${statusTag(s)}</td>
      <td class="num">\${timeAgo(s.lastActiveAt)}</td>
      <td class="num">\${timeAgo(s.createdAt)}</td>
      <td class="num">\${s.turns}</td>
      <td class="num" style="color:\${s.errors>0?'#f87171':'#8892b0'}">\${s.errors}\${s.timeouts>0?' (超时'+s.timeouts+')':''}</td>
      <td>
        <div class="token-bar-wrap">
          <span class="num">\${fmt(s.inputTokens)}</span>
          <div class="token-bar"><div class="token-bar-fill" style="width:\${barWidth}%;background:#60a5fa"></div></div>
        </div>
      </td>
      <td>
        <div class="token-bar-wrap">
          <span class="num">\${fmt(s.outputTokens)}</span>
          <div class="token-bar"><div class="token-bar-fill" style="width:\${barWidth}%"></div></div>
        </div>
      </td>
      <td class="num" style="color:#fbbf24;font-weight:600">\${fmt(s.totalTokens)}</td>
      <td class="num">\${fmtMs(s.avgTtftMs)}</td>
      <td class="num">\${fmtMs(s.avgDurationMs)}</td>
    </tr>\`;
  }).join("");

  document.getElementById("sessions-table-wrap").innerHTML = \`
    <table>
      <thead><tr>
        <th>Session ID</th>
        <th>状态</th>
        <th>最后活跃</th>
        <th>创建时间</th>
        <th>对话轮次</th>
        <th>错误</th>
        <th>Input Token</th>
        <th>Output Token</th>
        <th>总 Token</th>
        <th>TTFT 均值</th>
        <th>响应时长均值</th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  \`;
}

// 加载数据，每 30 秒自动刷新
loadStats(false);
setInterval(() => loadStats(false), 30000);
</script>
</body>
</html>`;
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

      // 非流式请求：bridge 内部用 globalEventBus 等待 OpenCode 推理完成，再返回完整 JSON
      // 队列 key 用 n8nSessionId（在 resolveOpencodeSession 之前就已知），
      // 确保同一 n8n session 的并发请求完全串行，不会出现两个 waitForResult 同时订阅同一个 OpenCode session
      const queueKey = n8nSessionId || ("anon_" + responseModel);
      try {
        const result = await enqueueSessionRequest(queueKey, async () => {
          const opencodeSessionId = await resolveOpencodeSession(n8nSessionId, responseModel, true, systemPrompt);
          console.log(`[OpenAI兼容消息] ${prompt.slice(0, 80)}  session=${opencodeSessionId}`);
          return waitForOpencodeResult(opencodeSessionId, prompt, MESSAGE_POST_TIMEOUT_MS);
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildOpenAIChatCompletion({ completionId, created, model: responseModel, content: result })));
      } catch (err) {
        console.error(`[OpenAI兼容消息] error: ${err.message}  queueKey=${queueKey}`);
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

  // ── GET /stats (JSON API) ─────────────────────────────────────
  if (normalizedPath === "/stats") {
    const uptimeMs = Date.now() - BRIDGE_START_TIME;
    const sessionsData = [];
    for (const [sid, m] of sessionMetrics) {
      sessionsData.push({
        opencodeSessionId: m.opencodeSessionId,
        n8nSessionId: m.n8nSessionId,
        createdAt: m.createdAt,
        lastActiveAt: m.lastActiveAt,
        idleSec: Math.round((Date.now() - m.lastActiveAt) / 1000),
        turns: m.turns,
        errors: m.errors,
        timeouts: m.timeouts,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        totalTokens: m.inputTokens + m.outputTokens,
        avgTtftMs: avg(m.ttftSamples),
        avgDurationMs: avg(m.durationSamples),
        lastFetchedAt: m.lastFetchedAt,
        inSessionMap: [...sessionMap.values()].includes(sid),
      });
    }
    sessionsData.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      bridge: {
        uptime: uptimeMs,
        uptimeHuman: formatDuration(uptimeMs),
        startedAt: BRIDGE_START_TIME,
        activeSessionMappings: sessionMap.size,
        totalTrackedSessions: sessionMetrics.size,
        requests: stats,
        successRate: stats.totalRequests > 0
          ? ((stats.successRequests / stats.totalRequests) * 100).toFixed(1) + "%"
          : "n/a",
      },
      sessions: sessionsData,
    }, null, 2));
    return;
  }

  // ── GET /stats/refresh (force refresh token counts) ───────────
  if (normalizedPath === "/stats/refresh") {
    refreshAllTokenStats().catch(() => {});
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "Token refresh triggered" }));
    return;
  }

  // ── GET /session/:id — proxy to OpenCode session detail ───────
  if (req.method === "GET" && /^\/session\/[^/]+$/.test(normalizedPath)) {
    const sessionId = normalizedPath.slice("/session/".length);
    try {
      const [sessionInfo, messages] = await Promise.all([
        fetchJSON(`${OPENCODE_BASE}/session/${sessionId}`, { timeoutMs: 5000 }).catch(() => null),
        fetchJSON(`${OPENCODE_BASE}/session/${sessionId}/messages`, { timeoutMs: 5000 }).catch(() => []),
      ]);
      const metrics = sessionMetrics.get(sessionId) || null;
      const queuePending = sessionQueue.has(sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        sessionId,
        opencode: sessionInfo,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        messages: Array.isArray(messages) ? messages.map(m => ({
          id: m.id,
          role: m.role,
          time: m.time,
          tokens: m.tokens || m.usage || null,
          parts: Array.isArray(m.parts) ? m.parts.map(p => ({
            type: p.type,
            textPreview: typeof p.text === "string" ? p.text.slice(0, 200) : null,
          })) : [],
        })) : [],
        bridgeMetrics: metrics,
        queuePending,
      }, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /sessions — list all OpenCode sessions ────────────────
  if (req.method === "GET" && normalizedPath === "/sessions") {
    try {
      const allSessions = await fetchJSON(`${OPENCODE_BASE}/session`, { timeoutMs: 5000 }).catch(() => []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        total: Array.isArray(allSessions) ? allSessions.length : 0,
        bridgeTracked: sessionMetrics.size,
        activeMappings: sessionMap.size,
        sessions: Array.isArray(allSessions) ? allSessions.map(s => ({
          id: s.id,
          title: s.title,
          time: s.time,
          bridgeMetrics: sessionMetrics.get(s.id) || null,
          inBridgeMap: [...sessionMap.values()].includes(s.id),
          queuePending: sessionQueue.has(s.id),
        })) : [],
      }, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /dashboard ────────────────────────────────────────────
  if (normalizedPath === "/dashboard" || normalizedPath === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getDashboardHTML());
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