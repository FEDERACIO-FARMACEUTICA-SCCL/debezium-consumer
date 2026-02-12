import { FastifyInstance } from "fastify";
import { store } from "../domain/store";
import { TABLE_REGISTRY, TABLE_MAP } from "../domain/table-registry";
import {
  storeStatsSchema,
  storeTableSchema,
  storeRecordSchema,
  storeSearchSchema,
} from "./schemas";

export function registerStoreViewer(app: FastifyInstance): void {
  // HTML page (auth skipped in server.ts hook)
  app.get("/store", { schema: { hide: true } }, async (_request, reply) => {
    reply.type("text/html").send(getStoreViewerHtml());
  });

  // GET /store/api/stats
  app.get("/store/api/stats", { schema: storeStatsSchema }, async () => {
    const stats = store.getStats();
    const total = Object.values(stats).reduce((sum, n) => sum + n, 0);
    const memory = store.getMemoryEstimate();
    const memoryTotal = Object.values(memory).reduce((sum, n) => sum + n, 0);
    return { tables: stats, total, memory, memoryTotal };
  });

  // GET /store/api/tables/:table
  app.get<{ Params: { table: string } }>(
    "/store/api/tables/:table",
    { schema: storeTableSchema },
    async (request, reply) => {
      const { table } = request.params;
      const def = TABLE_MAP.get(table.toLowerCase());
      if (!def) {
        reply.code(404).send({ error: `Unknown table: ${table}` });
        return;
      }
      const codigos = store.getAllCodigos(def.table);
      return {
        table: def.table,
        storeKind: def.storeKind,
        codigos,
        total: codigos.length,
      };
    }
  );

  // GET /store/api/tables/:table/:codigo
  app.get<{ Params: { table: string; codigo: string } }>(
    "/store/api/tables/:table/:codigo",
    { schema: storeRecordSchema },
    async (request, reply) => {
      const { table, codigo } = request.params;
      const def = TABLE_MAP.get(table.toLowerCase());
      if (!def) {
        reply.code(404).send({ error: `Unknown table: ${table}` });
        return;
      }
      const data =
        def.storeKind === "single"
          ? store.getSingle(def.table, codigo) ?? null
          : store.getArray(def.table, codigo);
      return {
        table: def.table,
        codigo,
        storeKind: def.storeKind,
        data,
      };
    }
  );

  // GET /store/api/search?q=xxx
  app.get<{ Querystring: { q: string } }>(
    "/store/api/search",
    { schema: storeSearchSchema },
    async (request, reply) => {
      const q = (request.query.q ?? "").trim().toLowerCase();
      if (!q) {
        reply.code(400).send({ error: "Query parameter 'q' is required" });
        return;
      }
      const results: { table: string; codigo: string }[] = [];
      for (const def of TABLE_REGISTRY) {
        const codigos = store.getAllCodigos(def.table);
        for (const codigo of codigos) {
          if (codigo.toLowerCase().includes(q)) {
            results.push({ table: def.table, codigo });
          }
          if (results.length >= 200) break;
        }
        if (results.length >= 200) break;
      }
      return { query: q, results, total: results.length };
    }
  );
}

function getStoreViewerHtml(): string {
  const tables = TABLE_REGISTRY.map((d) => d.table);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Store Viewer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
    background: #0d1117; color: #c9d1d9; min-height: 100vh;
  }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Header */
  .header {
    background: #161b22; border-bottom: 1px solid #30363d;
    padding: 12px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  .header h1 { font-size: 18px; color: #f0f6fc; white-space: nowrap; }
  .token-group { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 260px; }
  .token-group input {
    flex: 1; max-width: 360px; padding: 6px 10px; border-radius: 6px;
    border: 1px solid #30363d; background: #0d1117; color: #c9d1d9;
    font-size: 13px; font-family: inherit;
  }
  .btn {
    padding: 6px 14px; border-radius: 6px; border: 1px solid #30363d;
    background: #21262d; color: #c9d1d9; cursor: pointer; font-size: 13px;
    font-family: inherit; white-space: nowrap;
  }
  .btn:hover { background: #30363d; }
  .btn-primary { background: #238636; border-color: #2ea043; color: #fff; }
  .btn-primary:hover { background: #2ea043; }

  /* Layout */
  .main { display: flex; height: calc(100vh - 53px); }
  .sidebar {
    width: 300px; min-width: 220px; background: #161b22;
    border-right: 1px solid #30363d; display: flex; flex-direction: column;
    overflow: hidden;
  }
  .content { flex: 1; overflow: auto; padding: 20px; }

  /* Stats */
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat-card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 16px 20px; min-width: 140px; flex: 1;
  }
  .stat-card .label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-card .value { font-size: 28px; font-weight: 600; color: #f0f6fc; margin-top: 4px; }
  .stat-card .mem { font-size: 12px; color: #8b949e; margin-top: 2px; }

  /* Sidebar sections */
  .sidebar-section { padding: 12px; border-bottom: 1px solid #30363d; }
  .sidebar-section h3 { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .search-input {
    width: 100%; padding: 6px 10px; border-radius: 6px;
    border: 1px solid #30363d; background: #0d1117; color: #c9d1d9;
    font-size: 13px; font-family: inherit;
  }
  .table-tabs { display: flex; gap: 4px; }
  .table-tab {
    padding: 4px 10px; border-radius: 4px; border: 1px solid #30363d;
    background: #0d1117; color: #8b949e; cursor: pointer; font-size: 12px;
    font-family: inherit;
  }
  .table-tab.active { background: #238636; border-color: #2ea043; color: #fff; }

  /* Codigo list */
  .codigo-list { flex: 1; overflow-y: auto; }
  .codigo-item {
    padding: 6px 12px; cursor: pointer; font-size: 13px;
    border-bottom: 1px solid #21262d; font-family: monospace;
  }
  .codigo-item:hover { background: #21262d; }
  .codigo-item.active { background: #1f6feb33; color: #58a6ff; }
  .codigo-count { padding: 8px 12px; font-size: 11px; color: #8b949e; }

  /* Detail panel */
  .detail-header {
    display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;
  }
  .detail-header h2 { font-size: 16px; color: #f0f6fc; }
  .badge {
    font-size: 11px; padding: 2px 8px; border-radius: 10px;
    background: #30363d; color: #8b949e;
  }
  .json-block {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 16px; overflow-x: auto; font-size: 13px; line-height: 1.5;
    font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace;
    white-space: pre-wrap; word-break: break-word;
  }
  .json-key { color: #79c0ff; }
  .json-string { color: #a5d6ff; }
  .json-number { color: #d2a8ff; }
  .json-bool { color: #ff7b72; }
  .json-null { color: #8b949e; }

  .table-section { margin-bottom: 20px; }
  .table-section h3 {
    font-size: 13px; color: #8b949e; text-transform: uppercase;
    letter-spacing: 0.5px; margin-bottom: 8px;
    display: flex; align-items: center; gap: 8px;
  }
  .table-section h3 .badge { font-size: 10px; }

  .empty-state {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: #484f58; font-size: 14px; text-align: center;
  }
  .empty-state p { margin-top: 8px; }

  .search-results .result-item {
    padding: 8px 12px; cursor: pointer; font-size: 13px;
    border-bottom: 1px solid #21262d; display: flex; gap: 8px; align-items: center;
  }
  .search-results .result-item:hover { background: #21262d; }
  .search-results .result-table { color: #8b949e; font-size: 11px; min-width: 70px; }
  .search-results .result-codigo { color: #c9d1d9; font-family: monospace; }

  .error-msg { color: #f85149; font-size: 13px; margin-top: 8px; }
  .loading { color: #8b949e; font-size: 13px; }

  @media (max-width: 700px) {
    .main { flex-direction: column; height: auto; }
    .sidebar { width: 100%; min-width: 0; max-height: 40vh; }
    .content { padding: 12px; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>Store Viewer</h1>
  <div class="token-group">
    <input id="tokenInput" type="password" placeholder="Bearer token..." />
    <button class="btn btn-primary" onclick="connect()">Connect</button>
    <button class="btn" onclick="refreshStats()">Refresh</button>
  </div>
</div>

<div class="main">
  <div class="sidebar">
    <div class="sidebar-section">
      <h3>Search (codigo)</h3>
      <input class="search-input" id="globalSearch" placeholder="Search across all tables..."
        oninput="onGlobalSearch(this.value)" />
    </div>
    <div class="sidebar-section">
      <h3>Tables</h3>
      <div class="table-tabs" id="tableTabs"></div>
    </div>
    <div class="sidebar-section" style="padding-bottom:4px;">
      <input class="search-input" id="codigoFilter" placeholder="Filter codigos..."
        oninput="filterCodigos(this.value)" />
    </div>
    <div class="codigo-count" id="codigoCount"></div>
    <div class="codigo-list" id="codigoList"></div>
    <div class="search-results" id="searchResults" style="display:none;flex:1;overflow-y:auto;"></div>
  </div>

  <div class="content" id="contentPanel">
    <div id="statsPanel"></div>
    <div id="detailPanel"></div>
  </div>
</div>

<script>
const TABLES = ${JSON.stringify(tables)};
let token = localStorage.getItem("store-viewer-token") || "";
let currentTable = "";
let allCodigos = [];
let currentCodigo = "";

// Init
document.getElementById("tokenInput").value = token;
renderTableTabs();

if (token) connect();
else showEmpty("Enter your Bearer token and click Connect");

async function apiFetch(path) {
  if (!token) throw new Error("No token");
  const res = await fetch(path, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(res.status + ": " + body);
  }
  return res.json();
}

function connect() {
  token = document.getElementById("tokenInput").value.trim();
  localStorage.setItem("store-viewer-token", token);
  refreshStats();
}

async function refreshStats() {
  if (!token) return showEmpty("Enter your Bearer token and click Connect");
  const panel = document.getElementById("statsPanel");
  panel.innerHTML = '<div class="loading">Loading stats...</div>';
  document.getElementById("detailPanel").innerHTML = "";
  try {
    const data = await apiFetch("/store/api/stats");
    let html = '<div class="stats">';
    for (const [table, count] of Object.entries(data.tables)) {
      var mem = data.memory && data.memory[table] ? data.memory[table] : 0;
      html += '<div class="stat-card"><div class="label">' + esc(table) +
              '</div><div class="value">' + count +
              '</div><div class="mem">' + formatBytes(mem) + '</div></div>';
    }
    var totalMem = data.memoryTotal || 0;
    html += '<div class="stat-card"><div class="label">Total</div><div class="value">' +
            data.total + '</div><div class="mem">' + formatBytes(totalMem) + '</div></div>';
    html += '</div>';
    panel.innerHTML = html;
    if (currentTable) selectTable(currentTable);
    else if (TABLES.length) selectTable(TABLES[0]);
  } catch (e) {
    panel.innerHTML = '<div class="error-msg">Error: ' + esc(e.message) + '</div>';
  }
}

function renderTableTabs() {
  const container = document.getElementById("tableTabs");
  container.innerHTML = TABLES.map(function(t) {
    return '<button class="table-tab" data-table="' + t + '" onclick="selectTable(\\''+t+'\\')\">' + t + '</button>';
  }).join("");
}

async function selectTable(table) {
  currentTable = table;
  currentCodigo = "";
  document.querySelectorAll(".table-tab").forEach(function(el) {
    el.classList.toggle("active", el.dataset.table === table);
  });
  document.getElementById("codigoFilter").value = "";
  document.getElementById("globalSearch").value = "";
  showSearchResults(false);

  const list = document.getElementById("codigoList");
  list.innerHTML = '<div class="loading" style="padding:12px">Loading...</div>';
  document.getElementById("codigoCount").textContent = "";
  try {
    const data = await apiFetch("/store/api/tables/" + encodeURIComponent(table));
    allCodigos = data.codigos;
    renderCodigos(allCodigos);
  } catch (e) {
    list.innerHTML = '<div class="error-msg" style="padding:12px">' + esc(e.message) + '</div>';
  }
}

function renderCodigos(codigos) {
  const list = document.getElementById("codigoList");
  document.getElementById("codigoCount").textContent = codigos.length + " codigos";
  if (!codigos.length) {
    list.innerHTML = '<div style="padding:12px;color:#484f58">No codigos found</div>';
    return;
  }
  const maxRender = 500;
  const slice = codigos.slice(0, maxRender);
  list.innerHTML = slice.map(function(c) {
    return '<div class="codigo-item" data-codigo="' + esc(c) +
           '" onclick="selectCodigo(\\''+escJs(c)+'\\')\">' + esc(c) + '</div>';
  }).join("") + (codigos.length > maxRender
    ? '<div style="padding:8px 12px;color:#484f58;font-size:11px">Showing ' + maxRender + ' of ' + codigos.length + '</div>'
    : '');
}

function filterCodigos(q) {
  q = q.trim().toLowerCase();
  if (!q) return renderCodigos(allCodigos);
  renderCodigos(allCodigos.filter(function(c) { return c.toLowerCase().includes(q); }));
}

async function selectCodigo(codigo) {
  currentCodigo = codigo;
  document.querySelectorAll(".codigo-item").forEach(function(el) {
    el.classList.toggle("active", el.dataset.codigo === codigo);
  });
  await loadAllTablesForCodigo(codigo);
}

async function loadAllTablesForCodigo(codigo) {
  const panel = document.getElementById("detailPanel");
  panel.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const results = await Promise.all(
      TABLES.map(function(t) { return apiFetch("/store/api/tables/" + encodeURIComponent(t) + "/" + encodeURIComponent(codigo)); })
    );
    let html = '<div class="detail-header"><h2>' + esc(codigo) + '</h2></div>';
    results.forEach(function(r) {
      const isEmpty = r.data === null || (Array.isArray(r.data) && r.data.length === 0);
      const count = Array.isArray(r.data) ? r.data.length : (r.data ? 1 : 0);
      html += '<div class="table-section"><h3>' + esc(r.table) +
              ' <span class="badge">' + r.storeKind + '</span>' +
              ' <span class="badge">' + count + ' record' + (count !== 1 ? 's' : '') + '</span></h3>';
      if (isEmpty) {
        html += '<div class="json-block" style="color:#484f58">No data</div>';
      } else {
        html += '<div class="json-block">' + syntaxHighlight(r.data) + '</div>';
      }
      html += '</div>';
    });
    panel.innerHTML = html;
  } catch (e) {
    panel.innerHTML = '<div class="error-msg">Error: ' + esc(e.message) + '</div>';
  }
}

// Global search
let searchTimeout = null;
function onGlobalSearch(q) {
  clearTimeout(searchTimeout);
  q = q.trim();
  if (!q) { showSearchResults(false); return; }
  showSearchResults(true);
  searchTimeout = setTimeout(function() { doGlobalSearch(q); }, 300);
}

async function doGlobalSearch(q) {
  const container = document.getElementById("searchResults");
  container.innerHTML = '<div class="loading" style="padding:12px">Searching...</div>';
  try {
    const data = await apiFetch("/store/api/search?q=" + encodeURIComponent(q));
    if (!data.results.length) {
      container.innerHTML = '<div style="padding:12px;color:#484f58">No results</div>';
      return;
    }
    container.innerHTML = data.results.map(function(r) {
      return '<div class="result-item" onclick="jumpToResult(\\''+escJs(r.table)+'\\',\\''+escJs(r.codigo)+'\\')\">' +
             '<span class="result-table">' + esc(r.table) + '</span>' +
             '<span class="result-codigo">' + esc(r.codigo) + '</span></div>';
    }).join("") + '<div style="padding:8px 12px;color:#484f58;font-size:11px">' + data.total + ' results</div>';
  } catch (e) {
    container.innerHTML = '<div class="error-msg" style="padding:12px">' + esc(e.message) + '</div>';
  }
}

function jumpToResult(table, codigo) {
  document.getElementById("globalSearch").value = "";
  showSearchResults(false);
  selectTable(table).then(function() { selectCodigo(codigo); });
}

function showSearchResults(show) {
  document.getElementById("searchResults").style.display = show ? "block" : "none";
  document.getElementById("codigoList").style.display = show ? "none" : "block";
  document.getElementById("codigoCount").style.display = show ? "none" : "block";
}

function showEmpty(msg) {
  document.getElementById("statsPanel").innerHTML = "";
  document.getElementById("detailPanel").innerHTML =
    '<div class="empty-state"><div><p>' + esc(msg) + '</p></div></div>';
}

// Syntax highlight JSON
function syntaxHighlight(obj) {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"([^"]+)"\\s*:/g, '<span class="json-key">"$1"</span>:')
    .replace(/: "([^"]*)"(,?)/g, ': <span class="json-string">"$1"</span>$2')
    .replace(/: (\\d+\\.?\\d*)(,?)/g, ': <span class="json-number">$1</span>$2')
    .replace(/: (true|false)(,?)/g, ': <span class="json-bool">$1</span>$2')
    .replace(/: (null)(,?)/g, ': <span class="json-null">$1</span>$2');
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(2) + ' MB';
}

function esc(s) { var d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }
function escJs(s) { return String(s).replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "\\\\'"); }
</script>

</body>
</html>`;
}
