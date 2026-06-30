/**
 * Aerie Dashboard — Vanilla JS SPA
 * Hash-based routing, session auth, auto-refresh
 */

/* =============================================
   State
   ============================================= */
const state = {
  authenticated: false,
  route: '',
  params: {},
  intervals: [],
  status: null,
  targets: [],
  stats: [],
  audits: [],
  auditStats: null,
  alerts: [],
  targetName: null,
};

/* =============================================
   DOM shortcuts
   ============================================= */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const html = (el, h) => { el.innerHTML = h; return el; };

/* =============================================
   Toast
   ============================================= */
function toast(msg, type = 'success') {
  let container = $('#toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 3800);
}

/* =============================================
   API helper
   ============================================= */
async function api(method, path, body = null) {
  const opts = {
    method,
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401 && !path.includes('/auth/')) {
    state.authenticated = false;
    window.location.hash = '#login';
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = new Error(`API ${method} ${path} → ${res.status}`);
    try { err.data = await res.json(); } catch (_) {}
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

/* =============================================
   Router
   ============================================= */
const routes = {};

function route(pattern, fn) {
  routes[pattern] = fn;
}

function matchRoute(hash) {
  const path = hash.replace(/^#/, '') || 'overview';
  for (const [pattern, fn] of Object.entries(routes)) {
    const parts = pattern.split('/');
    const input = path.split('/');
    if (parts.length !== input.length) continue;
    const params = {};
    let match = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) {
        params[parts[i].slice(1)] = decodeURIComponent(input[i]);
      } else if (parts[i] !== input[i]) {
        match = false;
        break;
      }
    }
    if (match) return { fn, params };
  }
  return null;
}

function navigate(hash) {
  window.location.hash = hash;
}

/* =============================================
   Chart — Canvas line chart
   ============================================= */
function drawChart(canvas, dataPoints, metrics) {
  if (!canvas || !dataPoints || dataPoints.length < 2) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  const PAD = { top: 16, right: 16, bottom: 40, left: 48 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  // Clear
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#1a1d27';
  ctx.fillRect(0, 0, W, H);

  // Find Y range across all metrics
  let maxVal = 0;
  let minVal = Infinity;
  const series = metrics.map(m => {
    const values = dataPoints.map(d => d[m.key] != null ? +d[m.key] : null).filter(v => v !== null);
    return { ...m, values };
  });
  for (const s of series) {
    if (s.values.length === 0) continue;
    const sMax = Math.max(...s.values);
    const sMin = Math.min(...s.values);
    if (sMax > maxVal) maxVal = sMax;
    if (sMin < minVal) minVal = sMin;
  }
  // Clamp Y range
  if (maxVal === minVal) { maxVal = maxVal + 10; minVal = Math.max(0, minVal - 5); }
  const yRange = maxVal - minVal;
  const yPad = yRange * 0.1;
  const yMax = maxVal + yPad;
  const yMin = Math.max(0, minVal - yPad);

  const toX = (i) => PAD.left + (i / (dataPoints.length - 1)) * chartW;
  const toY = (v) => PAD.top + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

  // Grid lines
  ctx.strokeStyle = '#2a2d35';
  ctx.lineWidth = 1;
  const gridCount = 5;
  for (let i = 0; i <= gridCount; i++) {
    const y = PAD.top + (i / gridCount) * chartH;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(W - PAD.right, y);
    ctx.stroke();

    // Y axis labels
    const val = yMax - (i / gridCount) * (yMax - yMin);
    ctx.fillStyle = '#6b7280';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(val.toFixed(1), PAD.left - 8, y);
  }

  // X axis labels (show ~6 ticks)
  const xTickCount = Math.min(6, dataPoints.length);
  const xStep = Math.max(1, Math.floor((dataPoints.length - 1) / (xTickCount - 1)));
  for (let i = 0; i < dataPoints.length; i += xStep) {
    const x = toX(i);
    ctx.fillStyle = '#6b7280';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const date = new Date(dataPoints[i].collected_at);
    const label = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    ctx.fillText(label, x, PAD.top + chartH + 8);
  }

  // Border line at bottom of chart area
  ctx.strokeStyle = '#2a2d35';
  ctx.beginPath();
  ctx.moveTo(PAD.left, PAD.top + chartH);
  ctx.lineTo(W - PAD.right, PAD.top + chartH);
  ctx.stroke();

  // Data lines
  for (const s of series) {
    if (s.values.length === 0) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < dataPoints.length; i++) {
      const v = dataPoints[i][s.key];
      if (v == null) continue;
      const x = toX(i);
      const y = toY(+v);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else { ctx.lineTo(x, y); }
    }
    ctx.stroke();

    // Fill under line with gradient
    if (s.values.length > 1) {
      ctx.globalAlpha = 0.08;
      ctx.beginPath();
      let fillStarted = false;
      for (let i = 0; i < dataPoints.length; i++) {
        const v = dataPoints[i][s.key];
        if (v == null) continue;
        const x = toX(i);
        const y = toY(+v);
        if (!fillStarted) {
          ctx.moveTo(x, PAD.top + chartH);
          ctx.lineTo(x, y);
          fillStarted = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.lineTo(toX(dataPoints.length - 1), PAD.top + chartH);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

/* =============================================
   Sidebar
   ============================================= */
function renderSidebar() {
  const navItems = [
    { hash: '#overview', icon: '\u2302', label: 'Overview' },
    { hash: '#targets', icon: '\u2601', label: 'Targets' },
    { hash: '#audit', icon: '\u2691', label: 'Audit Log' },
    { hash: '#alerts', icon: '\u26a0', label: 'Alerts' },
  ];

  const sb = $('#sidebar');
  if (!sb) return;

  const currentHash = window.location.hash || '#overview';

  html(sb, `
    <div class="sidebar-brand">
      <div class="sidebar-brand-icon">AE</div>
      <div class="sidebar-brand-text">
        Aerie
        <small>Warpgate MCP</small>
      </div>
    </div>
    <nav class="sidebar-nav">
      ${navItems.map(item => `
        <button class="nav-item ${currentHash === item.hash ? 'active' : ''}"
                data-hash="${item.hash}"
                onclick="navigate('${item.hash}')">
          <span class="nav-icon">${item.icon}</span>
          ${item.label}
        </button>
      `).join('')}
    </nav>
    <div class="sidebar-footer">
      <button class="btn-logout" onclick="handleLogout()">
        <span class="nav-icon">\u2192</span>
        Logout
      </button>
    </div>
  `);
}

async function handleLogout() {
  try { await api('POST', '/api/auth/logout'); } catch (_) {}
  state.authenticated = false;
  navigate('#login');
}

/* =============================================
   Page — Login
   ============================================= */
route('login', async () => {
  html($('#app'), `
    <div class="login-wrapper">
      <div class="login-card">
        <div class="login-logo">
          <div class="logo-icon">AE</div>
          <h1>Aerie Dashboard</h1>
          <p>Warpgate MCP Server</p>
        </div>
        <div class="form-group">
          <label for="login-token">Access Token</label>
          <input type="password" id="login-token" class="form-input"
                 placeholder="Enter your API token" autocomplete="off">
        </div>
        <button class="btn btn-primary" id="login-btn" onclick="handleLogin()">
          \u2192 Login
        </button>
        <div class="login-error alert alert-error" id="login-error"></div>
      </div>
    </div>
  `);
  $('#login-token').focus();
});

async function handleLogin() {
  const token = $('#login-token').value.trim();
  const btn = $('#login-btn');
  const errEl = $('#login-error');
  if (!token) return;

  btn.disabled = true;
  btn.textContent = 'Logging in...';
  errEl.classList.remove('visible');

  try {
    await api('POST', '/api/auth/login', { token });
    state.authenticated = true;
    // Replace login in history so back doesn't return to login
    window.location.replace('#overview');
  } catch (e) {
    errEl.textContent = 'Authentication failed. Please check your token.';
    errEl.classList.add('visible');
    btn.disabled = false;
    btn.innerHTML = '\u2192 Login';
  }
}

/* =============================================
   Page — Overview
   ============================================= */
route('overview', async () => {
  html($('#app'), `
    <div class="top-bar">
      <div>
        <h1 class="page-title">Overview</h1>
        <p class="page-subtitle">Server status and key metrics</p>
      </div>
    </div>
    <div class="stats-grid" id="overview-stats">
      <div class="stat-card accent-blue">
        <div class="stat-icon">\u23f1</div>
        <div class="stat-label">Uptime</div>
        <div class="stat-value" id="stat-uptime">--</div>
        <div class="stat-sub">since last restart</div>
      </div>
      <div class="stat-card accent-green">
        <div class="stat-icon">\u2601</div>
        <div class="stat-label">Total Requests</div>
        <div class="stat-value" id="stat-requests">--</div>
        <div class="stat-sub">all time</div>
      </div>
      <div class="stat-card accent-red">
        <div class="stat-icon">\u2716</div>
        <div class="stat-label">Failed Requests</div>
        <div class="stat-value" id="stat-failed">--</div>
        <div class="stat-sub">${String.fromCharCode(8593)} recent failures</div>
      </div>
      <div class="stat-card accent-yellow">
        <div class="stat-icon">\u2699</div>
        <div class="stat-label">Targets</div>
        <div class="stat-value" id="stat-targets">--</div>
        <div class="stat-sub">configured hosts</div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">System Status</span>
      </div>
      <div class="panel-body" id="overview-status">
        <div class="loading"><div class="spinner"></div> Loading...</div>
      </div>
    </div>
  `);
  await loadOverview();
  startInterval('overview', loadOverview, 15000);
});

async function loadOverview() {
  try {
    const data = await api('GET', '/api/status');
    state.status = data;

    const uptime = data.uptime_seconds || 0;
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const mins = Math.floor((uptime % 3600) / 60);

    const uptimeStr = days > 0
      ? `${days}d ${hours}h ${mins}m`
      : `${hours}h ${mins}m`;

    $('#stat-uptime').textContent = uptimeStr;
    $('#stat-requests').textContent = data.stats?.total_requests ?? '--';
    $('#stat-failed').textContent = data.stats?.failed_requests ?? '--';
    $('#stat-targets').textContent = data.stats?.targets_count ?? '--';

    const panel = $('#overview-status');
    const healthy = data.status === 'healthy' || data.status === 'running';
    html(panel, `
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:12px;height:12px;border-radius:50%;
                    background:${healthy ? 'var(--accent-green)' : 'var(--accent-red)'};
                    box-shadow:0 0 8px ${healthy ? 'rgba(52,211,153,0.4)' : 'rgba(248,113,113,0.4)'};"></div>
        <div>
          <div style="font-weight:600;font-size:15px;">${data.status || 'unknown'}</div>
          <div style="font-size:12px;color:var(--text-secondary);">
            Uptime: ${uptimeStr}
          </div>
        </div>
      </div>
    `);
  } catch (e) {
    console.error('Failed to load overview', e);
  }
}

/* =============================================
   Page — Targets
   ============================================= */
route('targets', async () => {
  html($('#app'), `
    <div class="top-bar">
      <div>
        <h1 class="page-title">Targets</h1>
        <p class="page-subtitle">Managed SSH targets via Warpgate</p>
      </div>
      <div class="section-actions">
        <button class="btn btn-secondary btn-sm" onclick="loadTargets()">\u21bb Refresh</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-body" style="padding:0;" id="targets-table-container">
        <div class="loading"><div class="spinner"></div> Loading targets...</div>
      </div>
    </div>
  `);
  await loadTargets();
  startInterval('targets', loadTargets, 15000);
});

async function loadTargets() {
  const container = $('#targets-table-container');
  try {
    const targets = await api('GET', '/api/targets');
    state.targets = targets || [];

    if (!targets || targets.length === 0) {
      html(container, `<div class="empty-state"><div class="empty-icon">\u2601</div><p>No targets configured</p></div>`);
      return;
    }

    html(container, `
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Host</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Latency</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${targets.map(t => `
              <tr>
                <td><a href="#" onclick="event.preventDefault(); navigate('#performance/${encodeURIComponent(t.name)}')" class="mono" style="font-weight:500;">${escHtml(t.name)}</a></td>
                <td class="mono text-muted">${escHtml(t.host)}</td>
                <td><span class="badge badge-unknown" style="text-transform:none;">${escHtml(t.kind || 'ssh')}</span></td>
                <td>${renderHealthStatus(t.health)}</td>
                <td class="mono">${t.health?.latency_ms != null ? t.health.latency_ms + 'ms' : '--'}</td>
                <td style="text-align:right;">
                  <button class="btn btn-xs btn-secondary" onclick="checkTargetHealth('${escHtml(t.name)}', this)">\u2691 Check Health</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `);
  } catch (e) {
    console.error('Failed to load targets', e);
    html(container, `<div class="empty-state"><p style="color:var(--accent-red);">Failed to load targets</p></div>`);
  }
}

function renderHealthStatus(health) {
  if (!health) return '<span class="badge badge-unknown">Unknown</span>';
  if (health.status === 'online') return '<span class="badge badge-online">Online</span>';
  if (health.status === 'offline') return '<span class="badge badge-offline">Offline</span>';
  return '<span class="badge badge-unknown">Unknown</span>';
}

async function checkTargetHealth(name, btn) {
  btn.disabled = true;
  btn.textContent = 'Checking...';
  try {
    const res = await api('POST', `/api/targets/${encodeURIComponent(name)}/health`);
    const status = res.status === 'online' || res.exitCode === 0;
    toast(`${name}: ${status ? 'Online' : 'Offline'}`, status ? 'success' : 'error');
    await loadTargets(); // refresh the table
  } catch (e) {
    toast(`Health check failed: ${e.message}`, 'error');
    btn.disabled = false;
    btn.innerHTML = '\u2691 Check Health';
  }
}

/* =============================================
   Page — Performance
   ============================================= */
route('performance/:name', async (params) => {
  const name = params.name;
  state.targetName = name;

  html($('#app'), `
    <div class="top-bar">
      <div>
        <a class="back-link" onclick="navigate('#targets')">\u2190 Targets</a>
        <h1 class="page-title">${escHtml(name)}</h1>
        <p class="page-subtitle">Performance metrics &amp; statistics</p>
      </div>
      <div class="section-actions">
        <button class="btn btn-primary btn-sm" id="collect-btn" onclick="collectStats('${escHtml(name)}')">\u2316 Collect Now</button>
        <button class="btn btn-secondary btn-sm" onclick="loadPerformance('${escHtml(name)}')">\u21bb Refresh</button>
      </div>
    </div>
    <div class="status-cards" id="perf-cards">
      <div class="status-card"><div class="status-label">CPU</div><div class="status-value text-blue" id="perf-cpu">--</div></div>
      <div class="status-card"><div class="status-label">Memory</div><div class="status-value text-green" id="perf-mem">--</div></div>
      <div class="status-card"><div class="status-label">Disk</div><div class="status-value text-yellow" id="perf-disk">--</div></div>
      <div class="status-card"><div class="status-label">Load (1m)</div><div class="status-value text-red" id="perf-load">--</div></div>
    </div>
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">CPU / Memory / Disk History</span>
      </div>
      <div class="panel-body">
        <div class="chart-legend" id="chart-legend"></div>
        <div class="chart-container">
          <canvas id="perf-chart"></canvas>
        </div>
      </div>
    </div>
  `);
  await loadPerformance(name);
  startInterval('perf_' + name, () => loadPerformance(name), 15000);
});

async function loadPerformance(name) {
  try {
    const stats = await api('GET', `/api/targets/${encodeURIComponent(name)}/stats`);
    state.stats = stats || [];

    // Update latest values in cards
    const latest = stats && stats.length > 0 ? stats[stats.length - 1] : null;
    if (latest) {
      $('#perf-cpu').textContent = (latest.cpu_percent != null ? latest.cpu_percent.toFixed(1) : '--') + '%';
      $('#perf-mem').textContent = (latest.mem_percent != null ? latest.mem_percent.toFixed(1) : '--') + '%';
      $('#perf-disk').textContent = (latest.disk_percent != null ? latest.disk_percent.toFixed(1) : '--') + '%';
      $('#perf-load').textContent = latest.load_1m != null ? latest.load_1m.toFixed(2) : '--';
    }

    // Legend
    const legend = $('#chart-legend');
    const items = [
      { label: 'CPU', color: '#3b82f6' },
      { label: 'Memory', color: '#22c55e' },
      { label: 'Disk', color: '#f59e0b' },
      { label: 'Load', color: '#ef4444' },
    ];
    html(legend, items.map(i =>
      `<span class="legend-item"><span class="legend-dot" style="background:${i.color}"></span>${i.label}</span>`
    ).join(''));

    // Draw chart
    const canvas = $('#perf-chart');
    if (stats && stats.length >= 2) {
      // Take last 60 data points
      const points = stats.slice(-60);
      drawChart(canvas, points, [
        { key: 'cpu_percent', color: '#3b82f6' },
        { key: 'mem_percent', color: '#22c55e' },
        { key: 'disk_percent', color: '#f59e0b' },
        { key: 'load_1m', color: '#ef4444' },
      ]);
    } else {
      const ctx = canvas.getContext('2d');
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      ctx.fillStyle = '#1a1d27';
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = '#6b7280';
      ctx.font = '14px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Not enough data points yet', rect.width / 2, rect.height / 2);
    }
  } catch (e) {
    console.error('Failed to load performance stats', e);
  }
}

async function collectStats(name) {
  const btn = $('#collect-btn');
  btn.disabled = true;
  btn.textContent = 'Collecting...';
  try {
    const res = await api('POST', `/api/targets/${encodeURIComponent(name)}/stats/collect`);
    toast('Stats collected successfully', 'success');
    await loadPerformance(name);
  } catch (e) {
    toast(`Collection failed: ${e.message}`, 'error');
  }
  btn.disabled = false;
  btn.innerHTML = '\u2316 Collect Now';
}

/* =============================================
   Page — Audit
   ============================================= */
route('audit', async () => {
  html($('#app'), `
    <div class="top-bar">
      <div>
        <h1 class="page-title">Audit Log</h1>
        <p class="page-subtitle">Security events and tool invocations</p>
      </div>
    </div>
    <div class="panel">
      <div class="panel-body" id="audit-stats-container">
        <div class="loading"><div class="spinner"></div> Loading audit stats...</div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-body">
        <div class="filter-bar" id="audit-filters">
          <div class="form-group">
            <label>Target</label>
            <input type="text" class="form-input" id="filter-target" placeholder="All targets" oninput="loadAudit()">
          </div>
          <div class="form-group">
            <label>Risk Level</label>
            <select class="form-select" id="filter-risk" onchange="loadAudit()">
              <option value="">All Levels</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="loadAudit()">\u21bb Refresh</button>
        </div>
        <div id="audit-table-container">
          <div class="loading"><div class="spinner"></div> Loading audit log...</div>
        </div>
      </div>
    </div>
  `);
  await loadAuditStats();
  await loadAudit();
  startInterval('audit', async () => { await loadAudit(); await loadAuditStats(); }, 15000);
});

async function loadAuditStats() {
  const container = $('#audit-stats-container');
  try {
    const stats = await api('GET', '/api/audit/stats');
    state.auditStats = stats;

    const byRisk = stats.by_risk_level || {};
    const byStatus = stats.by_status || {};

    html(container, `
      <div class="section-title" style="margin-bottom:12px;">Summary</div>
      <div class="audit-stats">
        <div class="audit-stat">
          <div class="as-value" style="color:var(--text-primary);">${stats.total_calls ?? 0}</div>
          <div class="as-label">Total Calls</div>
        </div>
        <div class="audit-stat">
          <div class="as-value" style="color:var(--accent-green);">${byStatus.success ?? 0}</div>
          <div class="as-label">Success</div>
        </div>
        <div class="audit-stat">
          <div class="as-value" style="color:var(--accent-red);">${byStatus.failure ?? 0}</div>
          <div class="as-label">Failure</div>
        </div>
        <div class="audit-stat">
          <div class="as-value" style="color:var(--accent-yellow);">${byStatus.blocked ?? 0}</div>
          <div class="as-label">Blocked</div>
        </div>
        <div class="audit-stat">
          <div class="as-value" style="color:var(--risk-critical);">${byRisk.critical ?? 0}</div>
          <div class="as-label">Critical</div>
        </div>
        <div class="audit-stat">
          <div class="as-value" style="color:var(--risk-high);">${byRisk.high ?? 0}</div>
          <div class="as-label">High</div>
        </div>
      </div>
    `);
  } catch (e) {
    console.error('Failed to load audit stats', e);
    html(container, '<div class="text-muted">Unable to load audit stats</div>');
  }
}

async function loadAudit() {
  const container = $('#audit-table-container');
  const target = $('#filter-target')?.value || '';
  const risk = $('#filter-risk')?.value || '';
  const params = new URLSearchParams();
  if (target) params.set('target', target);
  if (risk) params.set('riskLevel', risk);

  try {
    const audits = await api('GET', '/api/audit?' + params.toString());
    state.audits = audits || [];

    if (!audits || audits.length === 0) {
      html(container, `<div class="empty-state"><div class="empty-icon">\u2691</div><p>No audit entries found</p></div>`);
      return;
    }

    const riskBadge = (level) => {
      const map = { low: 'badge-risk-low', medium: 'badge-risk-medium', high: 'badge-risk-high', critical: 'badge-risk-critical' };
      return `<span class="badge ${map[level] || 'badge-unknown'}">${escHtml(level || 'unknown')}</span>`;
    };

    html(container, `
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Tool</th>
              <th>Target</th>
              <th>Risk</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${audits.map(a => `
              <tr>
                <td class="mono" style="font-size:12px;white-space:nowrap;">${formatTime(a.timestamp)}</td>
                <td>${escHtml(a.tool)}</td>
                <td class="mono">${escHtml(a.target) || '--'}</td>
                <td>${riskBadge(a.risk_level)}</td>
                <td>${renderStatusBadge(a.status)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `);
  } catch (e) {
    console.error('Failed to load audit', e);
    html(container, '<div class="empty-state"><p style="color:var(--accent-red);">Failed to load audit log</p></div>');
  }
}

function renderStatusBadge(status) {
  if (status === 'success') return '<span class="badge badge-online">Success</span>';
  if (status === 'failure') return '<span class="badge badge-offline">Failure</span>';
  if (status === 'blocked') return `<span class="badge badge-risk-critical">Blocked</span>`;
  return `<span class="badge badge-unknown">${escHtml(status || 'unknown')}</span>`;
}

/* =============================================
   Page — Alerts
   ============================================= */
route('alerts', async () => {
  html($('#app'), `
    <div class="top-bar">
      <div>
        <h1 class="page-title">Alerts</h1>
        <p class="page-subtitle">Threshold-based alerting rules</p>
      </div>
      <div class="section-actions">
        <button class="btn btn-secondary btn-sm" onclick="loadAlerts()">\u21bb Refresh</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Create Alert Rule</span>
      </div>
      <div class="panel-body">
        <div id="alert-form-msg"></div>
        <div class="form-row">
          <div class="form-group">
            <label>Rule Name</label>
            <input type="text" class="form-input" id="alert-name" placeholder="e.g. High CPU">
          </div>
          <div class="form-group">
            <label>Target Name</label>
            <input type="text" class="form-input" id="alert-target" placeholder="Target identifier">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Metric</label>
            <select class="form-select" id="alert-metric">
              <option value="cpu_percent">CPU %</option>
              <option value="mem_percent">Memory %</option>
              <option value="disk_percent">Disk %</option>
              <option value="load_1m">Load (1m)</option>
            </select>
          </div>
          <div class="form-group">
            <label>Operator</label>
            <select class="form-select" id="alert-operator">
              <option value="gt">Greater Than (&gt;)</option>
              <option value="lt">Less Than (&lt;)</option>
              <option value="gte">Greater or Equal (&ge;)</option>
              <option value="lte">Less or Equal (&le;)</option>
              <option value="eq">Equal (=)</option>
            </select>
          </div>
        </div>
        <div class="form-row" style="align-items:end;">
          <div class="form-group">
            <label>Threshold</label>
            <input type="number" class="form-input" id="alert-threshold" placeholder="e.g. 90" step="0.1">
          </div>
          <div style="display:flex;gap:8px;padding-bottom:2px;">
            <button class="btn btn-primary" onclick="createAlert()">+ Create Rule</button>
          </div>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-header">
        <span class="panel-title">Existing Rules</span>
      </div>
      <div class="panel-body" style="padding:0;" id="alerts-table-container">
        <div class="loading"><div class="spinner"></div> Loading alerts...</div>
      </div>
    </div>
  `);
  await loadAlerts();
  startInterval('alerts', loadAlerts, 15000);
});

async function loadAlerts() {
  const container = $('#alerts-table-container');
  try {
    const alerts = await api('GET', '/api/alerts');
    state.alerts = alerts || [];

    if (!alerts || alerts.length === 0) {
      html(container, `<div class="empty-state" style="padding:32px;"><div class="empty-icon">\u26a0</div><p>No alert rules configured</p></div>`);
      return;
    }

    const metricLabels = {
      cpu_percent: 'CPU %',
      mem_percent: 'Memory %',
      disk_percent: 'Disk %',
      load_1m: 'Load (1m)',
    };

    html(container, `
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Target</th>
              <th>Metric</th>
              <th>Operator</th>
              <th>Threshold</th>
              <th>Status</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${alerts.map(a => `
              <tr class="${a.enabled ? 'alert-rule-enabled' : 'alert-rule-disabled'}">
                <td style="font-weight:500;">${escHtml(a.name)}</td>
                <td class="mono">${escHtml(a.target_name)}</td>
                <td>${metricLabels[a.metric] || escHtml(a.metric)}</td>
                <td class="mono">${escHtml(a.operator)}</td>
                <td class="mono">${a.threshold}</td>
                <td><span class="badge ${a.enabled ? 'badge-online' : 'badge-offline'}">${a.enabled ? 'Enabled' : 'Disabled'}</span></td>
                <td style="text-align:right;">
                  <button class="btn btn-xs btn-danger" onclick="deleteAlert('${a.id}', this)">\u2716 Delete</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `);
  } catch (e) {
    console.error('Failed to load alerts', e);
    html(container, '<div class="empty-state"><p style="color:var(--accent-red);">Failed to load alerts</p></div>');
  }
}

async function createAlert() {
  const name = $('#alert-name').value.trim();
  const targetName = $('#alert-target').value.trim();
  const metric = $('#alert-metric').value;
  const operator = $('#alert-operator').value;
  const threshold = parseFloat($('#alert-threshold').value);
  const msgEl = $('#alert-form-msg');

  if (!name || !targetName || isNaN(threshold)) {
    html(msgEl, '<div class="alert alert-error">Please fill in all fields</div>');
    return;
  }

  try {
    await api('POST', '/api/alerts', { name, target_name: targetName, metric, operator, threshold });
    toast('Alert rule created', 'success');
    html(msgEl, '<div class="alert alert-success">Alert rule created successfully</div>');
    // Clear form
    $('#alert-name').value = '';
    $('#alert-target').value = '';
    $('#alert-threshold').value = '';
    await loadAlerts();
  } catch (e) {
    html(msgEl, `<div class="alert alert-error">Failed to create alert: ${e.message}</div>`);
  }
}

async function deleteAlert(id, btn) {
  if (!confirm('Delete this alert rule?')) return;
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  try {
    await api('DELETE', `/api/alerts/${encodeURIComponent(id)}`);
    toast('Alert rule deleted', 'success');
    await loadAlerts();
  } catch (e) {
    toast(`Delete failed: ${e.message}`, 'error');
    btn.disabled = false;
    btn.innerHTML = '\u2716 Delete';
  }
}

/* =============================================
   Helpers
   ============================================= */
function escHtml(str) {
  if (str == null) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

function formatTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/* =============================================
   Interval management
   ============================================= */
function startInterval(key, fn, ms) {
  // Clear existing interval for this key
  state.intervals = state.intervals.filter(i => {
    if (i.key === key) { clearInterval(i.id); return false; }
    return true;
  });
  const id = setInterval(fn, ms);
  state.intervals.push({ key, id });
}

function clearAllIntervals() {
  state.intervals.forEach(i => clearInterval(i.id));
  state.intervals = [];
}

/* =============================================
   Resize handler for chart
   ============================================= */
let resizeTimeout;

function handleResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    const canvas = $('#perf-chart');
    if (canvas && state.stats && state.stats.length >= 2) {
      drawChart(canvas, state.stats.slice(-60), [
        { key: 'cpu_percent', color: '#3b82f6' },
        { key: 'mem_percent', color: '#22c55e' },
        { key: 'disk_percent', color: '#f59e0b' },
        { key: 'load_1m', color: '#ef4444' },
      ]);
    }
  }, 200);
}

/* =============================================
   Init
   ============================================= */
async function init() {
  // Build the fixed layout
  document.body.innerHTML = `
    <div class="app-layout">
      <aside class="sidebar" id="sidebar"></aside>
      <div class="sidebar-overlay" id="sidebar-overlay" onclick="closeSidebar()"></div>
      <main class="main-content">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;display:none;" id="mobile-header">
          <button class="menu-toggle" onclick="toggleSidebar()">\u2630</button>
        </div>
        <div id="app"></div>
      </main>
    </div>
  `;
  window.addEventListener('resize', handleResize);

  // Check for session on load
  try {
    await api('GET', '/api/status');
    state.authenticated = true;
  } catch (e) {
    state.authenticated = false;
  }

  renderSidebar();

  // Show mobile header on small screens
  const checkMobile = () => {
    const mh = $('#mobile-header');
    if (mh) mh.style.display = window.innerWidth <= 768 ? 'flex' : 'none';
  };
  checkMobile();
  window.addEventListener('resize', checkMobile);

  // Route handler
  async function onHashChange() {
    clearAllIntervals();
    const hash = window.location.hash || '#overview';
    const match = matchRoute(hash);
    if (!match) {
      navigate('#overview');
      return;
    }
    state.route = hash.slice(1);
    state.params = match.params;

    if (!state.authenticated && hash !== '#login') {
      navigate('#login');
      return;
    }

    renderSidebar();
    await match.fn(state.params);
  }

  window.addEventListener('hashchange', onHashChange);
  onHashChange();
}

window.navigate = navigate;
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.loadTargets = loadTargets;
window.checkTargetHealth = checkTargetHealth;
window.loadPerformance = loadPerformance;
window.collectStats = collectStats;
window.loadAudit = loadAudit;
window.loadAuditStats = loadAuditStats;
window.loadAlerts = loadAlerts;
window.createAlert = createAlert;
window.deleteAlert = deleteAlert;
window.toggleSidebar = function() {
  const sb = $('#sidebar');
  const overlay = $('#sidebar-overlay');
  sb.classList.toggle('open');
  overlay.classList.toggle('visible');
};
window.closeSidebar = function() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-overlay').classList.remove('visible');
};

// Boot
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
