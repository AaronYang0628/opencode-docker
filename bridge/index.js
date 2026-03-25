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
const OPENAI_STREAM_CHUNK_SIZE = Math.max(0, parseInt(process.env.OPENAI_STREAM_CHUNK_SIZE || "24", 10) || 0);
const OPENAI_STREAM_CHUNK_DELAY_MS = Math.max(0, parseInt(process.env.OPENAI_STREAM_CHUNK_DELAY_MS || "18", 10) || 0);
const ENABLE_LEADING_ECHO_FILTER = String(process.env.ENABLE_LEADING_ECHO_FILTER || "false").toLowerCase() === "true";

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
  if (!Array.isArray(messages)) return "";

  const systemBlocks = [];
  let lastUserText = "";
  let lastFallbackText = "";

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" ? message.role : "user";
    const text = messageContentToText(message.content);
    if (!text) continue;

    if (role === "system" || role === "developer") {
      systemBlocks.push(text);
      continue;
    }

    if (role === "user") {
      lastUserText = text;
      continue;
    }

    // 兜底：如果没有 user 消息，至少使用最后一条可读文本
    lastFallbackText = text;
  }

  const mainText = lastUserText || lastFallbackText;
  if (!mainText) {
    return systemBlocks.join("\n\n");
  }

  if (systemBlocks.length === 0) {
    return mainText;
  }

  return `${systemBlocks.join("\n\n")}\n\n${mainText}`;
}

function extractOpenAIInput(payload = {}) {
  const root = payload && typeof payload === "object" ? payload : {};
  const metadata = root.metadata && typeof root.metadata === "object" ? root.metadata : {};

  const promptFromMessages = buildPromptFromMessages(root.messages);
  const promptRaw = root.prompt ?? root.input ?? root.query ?? promptFromMessages;

  const sessionIdRaw =
    root.sessionId ??
    root.session_id ??
    root.conversationId ??
    root.conversation_id ??
    root.chatId ??
    root.chat_id ??
    metadata.sessionId ??
    metadata.session_id ??
    root.user;

  return {
    prompt: toPromptText(promptRaw),
    n8nSessionId: normalizeInputString(sessionIdRaw),
    model: normalizeInputString(root.model),
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

async function resolveOpencodeSession(n8nSessionId, model, rejectOnHTTPError = false) {
  let opencodeSessionId = sessionMap.get(n8nSessionId);
  if (!opencodeSessionId) {
    const session = await fetchJSON(`${OPENCODE_BASE}/session`, {
      method: "POST",
      body: { model: model || DEFAULT_MODEL },
      rejectOnHTTPError,
    });
    opencodeSessionId = session.id;
    if (n8nSessionId) sessionMap.set(n8nSessionId, opencodeSessionId);
    console.log(`[新建Session] n8n:${n8nSessionId} → opencode:${opencodeSessionId}`);
  } else {
    console.log(`[复用Session] opencode:${opencodeSessionId}`);
  }
  return opencodeSessionId;
}

async function handleStreamRequest(req, res, { prompt, n8nSessionId, model }, options = {}) {
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
  try {
    opencodeSessionId = await resolveOpencodeSession(n8nSessionId, model, true);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: err.message }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`: connected\n\n`);
  if (mode === "bridge") {
    writeSSE(res, "meta", { success: true, sessionId: opencodeSessionId });
  } else {
    writeOpenAIStreamChunk(res, {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: responseModel,
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        },
      ],
    });
  }

  let closed = false;
  let eventReq = null;
  let fullText = "";
  let assistantMessageID = null;
  const userMessageID = createMessageID();
  let promptAccepted = false;
  const echoFilter = ENABLE_LEADING_ECHO_FILTER ? createLeadingEchoFilter(prompt) : createPassThroughFilter();
  let writeQueue = Promise.resolve();
  let closeRequested = false;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const enqueueWrite = (writer) => {
    writeQueue = writeQueue
      .then(async () => {
        if (closed) return;
        await writer();
      })
      .catch(() => {});
    return writeQueue;
  };

  const cleanup = () => {
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
      res.end();
      closed = true;
      cleanup();
    });
  };

  const emitDelta = (text) => {
    if (!text) return;
    if (mode === "bridge") {
      enqueueWrite(() => {
        writeSSE(res, "delta", { text, sessionId: opencodeSessionId });
      });
      return;
    }

    const parts = splitStreamText(text, OPENAI_STREAM_CHUNK_SIZE);
    parts.forEach((part, index) => {
      enqueueWrite(async () => {
        writeOpenAIStreamChunk(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: responseModel,
          choices: [
            {
              index: 0,
              delta: { content: part },
              finish_reason: null,
            },
          ],
        });

        if (OPENAI_STREAM_CHUNK_DELAY_MS > 0 && index < parts.length - 1) {
          await delay(OPENAI_STREAM_CHUNK_DELAY_MS);
        }
      });
    });
  };

  const emitDone = () => {
    const tail = echoFilter.flush();
    if (tail) {
      fullText += tail;
      emitDelta(tail);
    }

    if (mode === "bridge") {
      enqueueWrite(() => {
        writeSSE(res, "done", {
          success: true,
          sessionId: opencodeSessionId,
          result: fullText,
        });
      });
      return;
    }

    enqueueWrite(() => {
      writeOpenAIStreamChunk(res, {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: responseModel,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      });
      writeOpenAIStreamDone(res);
    });
  };

  const emitError = (message) => {
    if (mode === "bridge") {
      enqueueWrite(() => {
        writeSSE(res, "error", { success: false, sessionId: opencodeSessionId, error: message });
      });
      return;
    }

    enqueueWrite(() => {
      writeOpenAIStreamChunk(res, {
        error: {
          message,
          type: "server_error",
        },
      });
      writeOpenAIStreamDone(res);
    });
  };

  req.on("close", () => {
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
          if (info.sessionID !== opencodeSessionId) return;

          if (info.role === "user" && info.id === userMessageID) {
            promptAccepted = true;
            return;
          }

          if (info.role === "assistant" && info.parentID === userMessageID) {
            assistantMessageID = info.id;
            if (info.time && info.time.completed) {
              emitDone();
              closeStream();
            }
            return;
          }

          if (assistantMessageID && info.id === assistantMessageID && info.time && info.time.completed) {
            emitDone();
            closeStream();
          }
          return;
        }

        if (type === "message.part.updated") {
          const part = props.part || {};
          if (part.sessionID !== opencodeSessionId || part.type !== "text") return;
          if (part.messageID === userMessageID) return;

          if (!assistantMessageID && part.messageID && part.messageID !== userMessageID) {
            assistantMessageID = part.messageID;
          }

          if (assistantMessageID && part.messageID !== assistantMessageID) return;

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
          }
          return;
        }

        if (type === "session.status" && props.sessionID === opencodeSessionId) {
          if (props.status && props.status.type === "idle" && promptAccepted) {
            emitDone();
            closeStream();
          }
          return;
        }

        if (type === "session.idle" && props.sessionID === opencodeSessionId && promptAccepted) {
          emitDone();
          closeStream();
          return;
        }

        if (type === "session.error") {
          if (!props.sessionID || props.sessionID === opencodeSessionId) {
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

    await Promise.race([
      streamReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error("event stream connect timeout")), 10000)),
    ]);

    console.log(`[流式发送消息] ${prompt.slice(0, 80)}`);
    await fetchJSON(`${OPENCODE_BASE}/session/${opencodeSessionId}/prompt_async`, {
      method: "POST",
      body: { messageID: userMessageID, parts: [{ type: "text", text: prompt }] },
      rejectOnHTTPError: true,
    });
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

      const { prompt, n8nSessionId, model } = extractOpenAIInput(parsed);
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
          { prompt, n8nSessionId, model: responseModel },
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
        const opencodeSessionId = await resolveOpencodeSession(n8nSessionId, responseModel, true);
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

        // 复用或新建 OpenCode Session
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
});
