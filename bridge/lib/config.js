const OPENCODE_BASE = process.env.OPENCODE_BASE || "http://opencode.opencode.svc.cluster.local:4000";
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "3100", 10);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "zzz/claude-sonnet-4-5-20250929-thinking";
const OPENAI_STREAM_CHUNK_SIZE = Math.max(0, parseInt(process.env.OPENAI_STREAM_CHUNK_SIZE || "4", 10) || 0);
const OPENAI_STREAM_CHUNK_DELAY_MS = Math.max(0, parseInt(process.env.OPENAI_STREAM_CHUNK_DELAY_MS || "10", 10) || 0);
const ENABLE_LEADING_ECHO_FILTER = String(process.env.ENABLE_LEADING_ECHO_FILTER || "false").toLowerCase() === "true";
const BRIDGE_STREAM_DEBUG = String(process.env.BRIDGE_STREAM_DEBUG || "false").toLowerCase() === "true";
const MESSAGE_POST_TIMEOUT_MS = Math.max(10000, parseInt(process.env.BRIDGE_MESSAGE_TIMEOUT_MS || "300000", 10) || 300000);
const SILENCE_TIMEOUT_MS = Math.max(0, parseInt(process.env.BRIDGE_SILENCE_TIMEOUT_MS || "0", 10) || 0);
const SESSION_COOLDOWN_MS = Math.max(0, parseInt(process.env.BRIDGE_SESSION_COOLDOWN_MS || "500", 10) || 0);
const SESSION_IDLE_WAIT_MS = Math.max(0, parseInt(process.env.BRIDGE_SESSION_IDLE_WAIT_MS || "10000", 10) || 0);

module.exports = {
  OPENCODE_BASE,
  BRIDGE_PORT,
  DEFAULT_MODEL,
  OPENAI_STREAM_CHUNK_SIZE,
  OPENAI_STREAM_CHUNK_DELAY_MS,
  ENABLE_LEADING_ECHO_FILTER,
  BRIDGE_STREAM_DEBUG,
  MESSAGE_POST_TIMEOUT_MS,
  SILENCE_TIMEOUT_MS,
  SESSION_COOLDOWN_MS,
  SESSION_IDLE_WAIT_MS,
};
