function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

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

  document.getElementById("status-badge").textContent =
    b.activeSessionMappings + " active sessions";

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

loadStats(false);
setInterval(() => loadStats(false), 30000);
</script>
</body>
</html>`;
}

module.exports = {
  formatDuration,
  getDashboardHTML,
};
