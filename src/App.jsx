import { useState, useEffect, useCallback, useRef } from "react";

const API = (import.meta.env.VITE_API_URL || "https://sitescan-backend-production-423e.up.railway.app") + "/api/v1";

// ─── BRAND COLORS ────────────────────────────────────────────────────────────
const C = {
  bg:        "#080f1a",   // near-black navy
  surface:   "#0c1524",  // card background
  surfaceHi: "#101d30",  // elevated card
  border:    "#1a2f50",  // subtle border
  borderHi:  "#1e3a64",  // hover border
  navy:      "#1e3a6e",  // deep navy
  blue:      "#4a9fd4",  // mid blue
  sky:       "#7ec8e3",  // sky blue (logo highlight)
  orange:    "#f0a030",  // orange accent (logo)
  orangeHi:  "#f7b84b",  // orange hover
  text:      "#e8f0fa",  // primary text
  textSub:   "#6b8aaa",  // secondary text
  textMuted: "#3d5a7a",  // muted
};

// ─── HELPERS ────────────────────────────────────────────────────────────────

const fmt$ = (v) => {
  if (!v) return "—";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
};

const fmtDate = (d) => {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const matchColor = (s) => {
  if (s >= 90) return C.orange;
  if (s >= 75) return C.blue;
  if (s >= 60) return C.sky;
  if (s >= 45) return "#5b8fa8";
  return C.textMuted;
};

const catIcons = {
  "historic-restoration": "🏛️",
  masonry: "🧱",
  structural: "🏗️",
  government: "⚖️",
  commercial: "🏢",
  residential: "🏠",
};

const sourceLabels = {
  "sam-gov": "SAM.gov",
  "charleston-permits": "CHS Permits",
  scbo: "SCBO",
  "charleston-city-bids": "CHS Bids",
};

const statusColors = {
  Open: C.orange,
  Active: C.orange,
  "Accepting Bids": C.sky,
  Closed: C.textMuted,
  Issued: C.blue,
  Finaled: C.textMuted,
  "In Review": "#c9943a",
};

async function api(path, opts = {}) {
  const token = localStorage.getItem("sitescan_token");
  const headers = { "Content-Type": "application/json", ...opts.headers };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  if (res.status === 401) {
    localStorage.removeItem("sitescan_token");
    window.location.reload();
  }
  return res.json();
}

// ─── AUTH SCREEN ────────────────────────────────────────────────────────────

function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const body = mode === "register"
        ? { email, password, full_name: name, company: "" }
        : { email, password };
      const data = await api(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (data.access_token) {
        localStorage.setItem("sitescan_token", data.access_token);
        onAuth(data.access_token);
      } else {
        setError(data.detail || "Auth failed");
      }
    } catch (err) {
      setError("Connection failed — is the server running?");
    }
    setLoading(false);
  };

  return (
    <div style={styles.authWrap}>
      {/* ── FORM SIDE ── */}
      <div style={styles.authFormSide}>
        <div style={styles.authCard}>
          <div style={styles.authLogo}>
            <span style={{ fontSize: 32, fontWeight: 800, color: C.text, fontFamily: "'DM Sans', sans-serif", letterSpacing: -1 }}>
              Ya
            </span>
            <span style={{ fontSize: 32, fontWeight: 800, color: C.orange, fontFamily: "'DM Sans', sans-serif", letterSpacing: -1 }}>
              bodle
            </span>
          </div>
          <p style={{ color: C.textSub, fontSize: 12, marginBottom: 28, textAlign: "center", letterSpacing: "0.05em", textTransform: "uppercase" }}>
            development opportunity intelligence
          </p>
          <div style={styles.authTabs}>
            <button
              style={{ ...styles.authTab, ...(mode === "login" ? styles.authTabActive : {}) }}
              onClick={() => setMode("login")}
            >
              Sign In
            </button>
            <button
              style={{ ...styles.authTab, ...(mode === "register" ? styles.authTabActive : {}) }}
              onClick={() => setMode("register")}
            >
              Register
            </button>
          </div>
          {error && <div style={styles.authError}>{error}</div>}
          <div>
            {mode === "register" && (
              <input
                style={styles.input}
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
            <input
              style={styles.input}
              placeholder="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit(e)}
            />
            <button style={styles.authBtn} onClick={submit} disabled={loading}>
              {loading ? "..." : mode === "login" ? "Sign In" : "Create Account"}
            </button>
          </div>
        </div>
      </div>

      {/* ── BRAND PANEL ── */}
      <div style={styles.authBrand}>
        <img src="/yabodle-logo.png" alt="Yabodle" style={{ maxWidth: 340, width: "55%" }} />
      </div>
    </div>
  );
}

// ─── MATCH BADGE ────────────────────────────────────────────────────────────

function MatchBadge({ score }) {
  const c = matchColor(score);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: `${c}18`,
        color: c,
        border: `1px solid ${c}40`,
        borderRadius: 20,
        padding: "3px 10px",
        fontSize: 12,
        fontWeight: 700,
        fontFamily: "'JetBrains Mono', monospace",
        minWidth: 44,
      }}
    >
      {score}%
    </span>
  );
}

// ─── STATUS PILL ────────────────────────────────────────────────────────────

function StatusPill({ status }) {
  const c = statusColors[status] || "#6b7280";
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: c,
        background: `${c}15`,
        border: `1px solid ${c}30`,
        borderRadius: 4,
        padding: "2px 8px",
      }}
    >
      {status}
    </span>
  );
}

// ─── PROJECT ROW ────────────────────────────────────────────────────────────

function ProjectRow({ project, onSave, saved }) {
  const [expanded, setExpanded] = useState(false);
  const p = project;

  return (
    <div style={styles.projectRow} onClick={() => setExpanded(!expanded)}>
      <div style={styles.projectHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.projectTitle}>
            <span style={{ marginRight: 8 }}>{catIcons[p.category] || "📋"}</span>
            {p.title}
          </div>
          <div style={styles.projectMeta}>
            <span>📍 {p.location || "—"}</span>
            {p.agency && <span style={{ marginLeft: 12 }}>🏢 {p.agency}</span>}
            <span style={{ marginLeft: 12 }}>
              <span style={{ fontSize: 9, padding: "1px 6px", background: "#ffffff08", borderRadius: 3, color: "#888" }}>
                {sourceLabels[p.source_id] || p.source_id}
              </span>
            </span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <MatchBadge score={p.match_score} />
          <div style={{ textAlign: "right", minWidth: 70 }}>
            <div style={{ color: "#34d399", fontWeight: 700, fontSize: 14, fontFamily: "'JetBrains Mono', monospace" }}>
              {fmt$(p.value)}
            </div>
          </div>
          <StatusPill status={p.status} />
        </div>
      </div>
      {expanded && (
        <div style={styles.projectExpanded}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div>
              <div style={styles.detailLabel}>Category</div>
              <div style={styles.detailValue}>{catIcons[p.category]} {p.category}</div>
            </div>
            <div>
              <div style={styles.detailLabel}>Posted</div>
              <div style={styles.detailValue}>{fmtDate(p.posted_date)}</div>
            </div>
            <div>
              <div style={styles.detailLabel}>Deadline</div>
              <div style={styles.detailValue}>{fmtDate(p.deadline)}</div>
            </div>
            {p.permit_number && (
              <div>
                <div style={styles.detailLabel}>Permit #</div>
                <div style={styles.detailValue}>{p.permit_number}</div>
              </div>
            )}
            {p.solicitation_number && (
              <div>
                <div style={styles.detailLabel}>Solicitation #</div>
                <div style={styles.detailValue}>{p.solicitation_number}</div>
              </div>
            )}
            {p.contractor && (
              <div>
                <div style={styles.detailLabel}>Contractor</div>
                <div style={styles.detailValue}>{p.contractor}</div>
              </div>
            )}
            {p.naics_code && (
              <div>
                <div style={styles.detailLabel}>NAICS</div>
                <div style={styles.detailValue}>{p.naics_code}</div>
              </div>
            )}
          </div>
          {p.description && (
            <div style={{ marginBottom: 16 }}>
              <div style={styles.detailLabel}>Description</div>
              <div style={{ color: "#aaa", fontSize: 13, lineHeight: 1.5, maxHeight: 120, overflow: "auto" }}>
                {p.description}
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {p.source_url && (
              <a
                href={p.source_url}
                target="_blank"
                rel="noopener"
                style={styles.linkBtn}
                onClick={(e) => e.stopPropagation()}
              >
                View Source →
              </a>
            )}
            {!saved && (
              <button
                style={styles.saveBtn}
                onClick={(e) => { e.stopPropagation(); onSave(p.id); }}
              >
                ★ Save
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── STATS BAR ──────────────────────────────────────────────────────────────

function StatsBar({ stats }) {
  if (!stats) return null;
  return (
    <div style={styles.statsBar}>
      <div style={styles.statBox}>
        <div style={styles.statNumber}>{stats.total_projects}</div>
        <div style={styles.statLabel}>Projects</div>
      </div>
      <div style={styles.statBox}>
        <div style={{ ...styles.statNumber, color: C.orange }}>{fmt$(stats.total_pipeline_value)}</div>
        <div style={styles.statLabel}>Pipeline Value</div>
      </div>
      <div style={styles.statBox}>
        <div style={{ ...styles.statNumber, color: C.sky }}>{stats.avg_match_score}%</div>
        <div style={styles.statLabel}>Avg Match</div>
      </div>
      <div style={styles.statBox}>
        <div style={{ ...styles.statNumber, color: C.blue }}>{stats.high_match_count}</div>
        <div style={styles.statLabel}>High Match (80%+)</div>
      </div>
    </div>
  );
}

// ─── SCAN BUTTON ────────────────────────────────────────────────────────────

function ScanButton({ onScan }) {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState(null);

  const doScan = async () => {
    setScanning(true);
    setResult(null);
    try {
      const data = await api("/scan/trigger", { method: "POST" });
      setResult(data.message);
      onScan();
    } catch (err) {
      setResult("Scan failed");
    }
    setScanning(false);
    setTimeout(() => setResult(null), 5000);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <button style={styles.scanBtn} onClick={doScan} disabled={scanning}>
        {scanning ? (
          <span>
            <span style={styles.spinner} /> Scanning...
          </span>
        ) : (
          "⚡ Run Scan"
        )}
      </button>
      {result && <span style={{ color: C.orange, fontSize: 12 }}>{result}</span>}
    </div>
  );
}

// ─── FILTER BAR ─────────────────────────────────────────────────────────────

function FilterBar({ filters, setFilters, categories, sources }) {
  return (
    <div style={styles.filterBar}>
      <input
        style={styles.searchInput}
        placeholder="Search projects..."
        value={filters.search || ""}
        onChange={(e) => setFilters({ ...filters, search: e.target.value })}
      />
      <select
        style={styles.select}
        value={filters.category || ""}
        onChange={(e) => setFilters({ ...filters, category: e.target.value })}
      >
        <option value="">All Categories</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {catIcons[c] || ""} {c}
          </option>
        ))}
      </select>
      <select
        style={styles.select}
        value={filters.source || ""}
        onChange={(e) => setFilters({ ...filters, source: e.target.value })}
      >
        <option value="">All Sources</option>
        {sources.map((s) => (
          <option key={s} value={s}>
            {sourceLabels[s] || s}
          </option>
        ))}
      </select>
      <select
        style={styles.select}
        value={filters.minMatch || 0}
        onChange={(e) => setFilters({ ...filters, minMatch: Number(e.target.value) })}
      >
        <option value={0}>Any Match</option>
        <option value={50}>50%+</option>
        <option value={60}>60%+</option>
        <option value={75}>75%+</option>
        <option value={90}>90%+</option>
      </select>
      <select
        style={styles.select}
        value={filters.sortBy || "match_score"}
        onChange={(e) => setFilters({ ...filters, sortBy: e.target.value })}
      >
        <option value="match_score">Sort: Match</option>
        <option value="value">Sort: Value</option>
        <option value="posted_date">Sort: Recent</option>
      </select>
    </div>
  );
}

// ─── SAVED PROJECTS TAB ─────────────────────────────────────────────────────

function SavedTab({ saved, onUnsave }) {
  if (!saved.length) {
    return (
      <div style={{ textAlign: "center", padding: 60, color: "#555" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>★</div>
        <div>No saved projects yet. Click "★ Save" on any project to track it.</div>
      </div>
    );
  }
  return (
    <div>
      {saved.map((s) => (
        <div key={s.id} style={styles.projectRow}>
          <div style={styles.projectHeader}>
            <div style={{ flex: 1 }}>
              <div style={styles.projectTitle}>
                {catIcons[s.project.category] || "📋"} {s.project.title}
              </div>
              <div style={styles.projectMeta}>
                📍 {s.project.location} · Saved {fmtDate(s.saved_at)}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <MatchBadge score={s.project.match_score} />
              <div style={{ color: "#34d399", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
                {fmt$(s.project.value)}
              </div>
              <button
                style={{ ...styles.saveBtn, background: "#dc2626" }}
                onClick={() => onUnsave(s.id)}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── SCAN HISTORY TAB ───────────────────────────────────────────────────────

function HistoryTab({ history }) {
  if (!history.length) {
    return (
      <div style={{ textAlign: "center", padding: 60, color: "#555" }}>
        No scan history yet. Run your first scan!
      </div>
    );
  }
  return (
    <div style={{ overflow: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Source", "Status", "Found", "New", "Started", "Duration"].map((h) => (
              <th key={h} style={styles.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id} style={styles.tr}>
              <td style={styles.td}>{sourceLabels[h.source_id] || h.source_id}</td>
              <td style={styles.td}>
                <span style={{ color: h.status === "success" ? "#22c55e" : h.status === "error" ? "#ef4444" : "#eab308" }}>
                  {h.status}
                </span>
              </td>
              <td style={styles.td}>{h.projects_found}</td>
              <td style={styles.td}>{h.projects_new}</td>
              <td style={styles.td}>{fmtDate(h.started_at)}</td>
              <td style={styles.td}>
                {h.finished_at
                  ? `${((new Date(h.finished_at) - new Date(h.started_at)) / 1000).toFixed(1)}s`
                  : "..."}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── MAIN APP ───────────────────────────────────────────────────────────────

export default function SiteScanApp() {
  const [authed, setAuthed] = useState(!!localStorage.getItem("sitescan_token"));
  const [tab, setTab] = useState("scanner");
  const [projects, setProjects] = useState([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState(null);
  const [saved, setSaved] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    search: "", category: "", source: "", minMatch: 0, sortBy: "match_score",
  });
  const [categories, setCategories] = useState([]);
  const [sources, setSources] = useState([]);
  const debounceRef = useRef(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        sort_by: filters.sortBy,
        sort_dir: "desc",
        limit: "100",
        min_match: String(filters.minMatch),
      });
      if (filters.search) params.set("search", filters.search);
      if (filters.category) params.set("categories", filters.category);
      if (filters.source) params.set("sources", filters.source);

      const data = await api(`/projects?${params}`);
      setProjects(data.projects || []);
      setTotal(data.total || 0);

      // Extract unique categories and sources
      const cats = [...new Set((data.projects || []).map((p) => p.category))];
      const srcs = [...new Set((data.projects || []).map((p) => p.source_id))];
      if (cats.length) setCategories(cats);
      if (srcs.length) setSources(srcs);
    } catch (err) {
      console.error("Load projects failed:", err);
    }
    setLoading(false);
  }, [filters]);

  const loadStats = async () => {
    try {
      const data = await api("/projects/stats/summary");
      setStats(data);
    } catch (err) {}
  };

  const loadSaved = async () => {
    try {
      const data = await api("/projects/saved/list");
      setSaved(Array.isArray(data) ? data : []);
    } catch (err) {}
  };

  const loadHistory = async () => {
    try {
      const data = await api("/scan/history?limit=30");
      setHistory(Array.isArray(data) ? data : []);
    } catch (err) {}
  };

  const saveProject = async (projectId) => {
    await api("/projects/save", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId }),
    });
    loadSaved();
  };

  const unsaveProject = async (savedId) => {
    await api(`/projects/saved/${savedId}`, { method: "DELETE" });
    loadSaved();
  };

  const handleScanComplete = () => {
    loadProjects();
    loadStats();
    loadHistory();
  };

  const logout = () => {
    localStorage.removeItem("sitescan_token");
    setAuthed(false);
  };

  useEffect(() => {
    if (!authed) return;
    loadStats();
    loadSaved();
    loadHistory();
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(loadProjects, 300);
    return () => clearTimeout(debounceRef.current);
  }, [filters, authed, loadProjects]);

  if (!authed) return <AuthScreen onAuth={() => setAuthed(true)} />;

  const savedIds = new Set(saved.map((s) => s.project_id));

  return (
    <div style={styles.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;500;600;700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #080f1a; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #080f1a; }
        ::-webkit-scrollbar-thumb { background: #1a2f50; border-radius: 3px; }
        input::placeholder { color: #3d5a7a; }
        select option { background: #0c1524; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      {/* HEADER */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logo}>
            <span style={{ color: C.text, fontFamily: "'DM Sans', sans-serif", fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>
              Ya
            </span>
            <span style={{ color: C.orange, fontFamily: "'DM Sans', sans-serif", fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>
              bodle
            </span>
            <span style={{ fontSize: 9, color: C.textMuted, marginLeft: 8, fontFamily: "'Space Mono', monospace", letterSpacing: 1, textTransform: "uppercase" }}>
              beta
            </span>
          </div>
          <nav style={styles.nav}>
            {[
              { id: "scanner", label: "Scanner", icon: "⚡" },
              { id: "saved", label: `Saved (${saved.length})`, icon: "★" },
              { id: "history", label: "History", icon: "📊" },
            ].map((t) => (
              <button
                key={t.id}
                style={{ ...styles.navBtn, ...(tab === t.id ? styles.navBtnActive : {}) }}
                onClick={() => setTab(t.id)}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </nav>
        </div>
        <div style={styles.headerRight}>
          <ScanButton onScan={handleScanComplete} />
          <button style={styles.logoutBtn} onClick={logout}>Sign Out</button>
        </div>
      </header>

      {/* MAIN */}
      <main style={styles.main}>
        {tab === "scanner" && (
          <>
            <StatsBar stats={stats} />
            <FilterBar
              filters={filters}
              setFilters={setFilters}
              categories={categories}
              sources={sources}
            />
            <div style={styles.resultHeader}>
              <span style={{ color: "#888", fontSize: 13 }}>
                {total} project{total !== 1 ? "s" : ""} found
                {filters.search && ` matching "${filters.search}"`}
              </span>
            </div>
            {loading ? (
              <div style={{ textAlign: "center", padding: 60, color: "#555" }}>
                <div style={styles.spinner} />
                <div style={{ marginTop: 12 }}>Loading projects...</div>
              </div>
            ) : projects.length === 0 ? (
              <div style={{ textAlign: "center", padding: 60, color: "#555" }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
                <div>No projects found. Try running a scan or adjusting filters.</div>
              </div>
            ) : (
              <div>
                {projects.map((p, i) => (
                  <div
                    key={p.id}
                    style={{ animation: `fadeIn 0.3s ease ${i * 0.03}s both` }}
                  >
                    <ProjectRow
                      project={p}
                      onSave={saveProject}
                      saved={savedIds.has(p.id)}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {tab === "saved" && <SavedTab saved={saved} onUnsave={unsaveProject} />}
        {tab === "history" && <HistoryTab history={history} />}
      </main>
    </div>
  );
}

// ─── STYLES ─────────────────────────────────────────────────────────────────

const styles = {
  app: {
    fontFamily: "'DM Sans', -apple-system, sans-serif",
    background: C.bg,
    color: C.text,
    minHeight: "100vh",
  },
  // Auth
  authWrap: {
    display: "flex",
    flexDirection: "row",
    minHeight: "100vh",
  },
  authFormSide: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 48px",
    flexShrink: 0,
    background: `radial-gradient(ellipse at 30% 50%, #0e2040 0%, ${C.bg} 70%)`,
  },
  authCard: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 16,
    padding: 40,
    width: 380,
    boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
  },
  authBrand: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: `linear-gradient(135deg, #060d18 0%, #0d1e38 50%, #060d18 100%)`,
    borderLeft: `1px solid ${C.border}`,
  },
  authLogo: {
    textAlign: "center",
    marginBottom: 4,
  },
  authTabs: {
    display: "flex",
    gap: 4,
    marginBottom: 20,
    background: C.bg,
    borderRadius: 8,
    padding: 3,
    border: `1px solid ${C.border}`,
  },
  authTab: {
    flex: 1,
    padding: "8px 0",
    background: "none",
    border: "none",
    color: C.textSub,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    borderRadius: 6,
    fontFamily: "'DM Sans', sans-serif",
  },
  authTabActive: {
    background: C.navy,
    color: C.text,
  },
  authError: {
    background: "#dc262615",
    border: "1px solid #dc262640",
    color: "#f87171",
    padding: "8px 12px",
    borderRadius: 8,
    fontSize: 12,
    marginBottom: 16,
  },
  authBtn: {
    width: "100%",
    padding: "12px 0",
    background: `linear-gradient(135deg, ${C.orange}, ${C.orangeHi})`,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif",
    marginTop: 8,
    letterSpacing: "0.02em",
  },
  input: {
    width: "100%",
    padding: "11px 14px",
    background: C.bg,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    color: C.text,
    fontSize: 14,
    marginBottom: 10,
    outline: "none",
    fontFamily: "'DM Sans', sans-serif",
  },
  // Header
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 24px",
    borderBottom: `1px solid ${C.border}`,
    background: C.surface,
    position: "sticky",
    top: 0,
    zIndex: 100,
    boxShadow: "0 2px 16px rgba(0,0,0,0.3)",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 32,
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  logo: { display: "flex", alignItems: "baseline" },
  nav: { display: "flex", gap: 2 },
  navBtn: {
    padding: "8px 14px",
    background: "none",
    border: "none",
    color: C.textSub,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    borderRadius: 6,
    fontFamily: "'DM Sans', sans-serif",
    transition: "all 0.15s",
  },
  navBtnActive: {
    background: C.navy,
    color: C.text,
  },
  scanBtn: {
    padding: "8px 18px",
    background: `linear-gradient(135deg, #c47d10, ${C.orange})`,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif",
    letterSpacing: "0.02em",
  },
  logoutBtn: {
    padding: "8px 12px",
    background: "none",
    border: `1px solid ${C.border}`,
    color: C.textSub,
    fontSize: 12,
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif",
  },
  // Main
  main: {
    maxWidth: 1200,
    margin: "0 auto",
    padding: "20px 24px",
  },
  // Stats
  statsBar: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 12,
    marginBottom: 20,
  },
  statBox: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    padding: "16px 20px",
    textAlign: "center",
  },
  statNumber: {
    fontSize: 22,
    fontWeight: 800,
    color: C.text,
    fontFamily: "'Space Mono', monospace",
  },
  statLabel: {
    fontSize: 11,
    color: C.textSub,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginTop: 4,
  },
  // Filters
  filterBar: {
    display: "flex",
    gap: 8,
    marginBottom: 16,
    flexWrap: "wrap",
  },
  searchInput: {
    flex: 1,
    minWidth: 200,
    padding: "9px 14px",
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    color: C.text,
    fontSize: 13,
    outline: "none",
    fontFamily: "'DM Sans', sans-serif",
  },
  select: {
    padding: "9px 12px",
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    color: C.text,
    fontSize: 12,
    outline: "none",
    fontFamily: "'DM Sans', sans-serif",
    cursor: "pointer",
  },
  resultHeader: {
    marginBottom: 12,
    paddingBottom: 8,
    borderBottom: `1px solid ${C.border}`,
  },
  // Projects
  projectRow: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    marginBottom: 6,
    padding: "14px 18px",
    cursor: "pointer",
    transition: "border-color 0.15s, background 0.15s",
  },
  projectHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
  },
  projectTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: C.text,
    marginBottom: 4,
    lineHeight: 1.3,
  },
  projectMeta: {
    fontSize: 12,
    color: C.textSub,
  },
  projectExpanded: {
    marginTop: 16,
    paddingTop: 16,
    borderTop: `1px solid ${C.border}`,
  },
  detailLabel: {
    fontSize: 10,
    color: C.textMuted,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 3,
  },
  detailValue: {
    fontSize: 13,
    color: C.textSub,
  },
  linkBtn: {
    display: "inline-block",
    padding: "6px 14px",
    background: `${C.blue}18`,
    border: `1px solid ${C.blue}40`,
    borderRadius: 6,
    color: C.sky,
    fontSize: 12,
    fontWeight: 600,
    textDecoration: "none",
    cursor: "pointer",
  },
  saveBtn: {
    padding: "6px 14px",
    background: `${C.orange}18`,
    border: `1px solid ${C.orange}40`,
    borderRadius: 6,
    color: C.orange,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif",
  },
  // Table
  th: {
    textAlign: "left",
    padding: "10px 14px",
    fontSize: 10,
    color: C.textMuted,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    borderBottom: `1px solid ${C.border}`,
  },
  tr: {
    borderBottom: `1px solid ${C.border}`,
  },
  td: {
    padding: "10px 14px",
    fontSize: 13,
    color: C.textSub,
  },
  // Misc
  spinner: {
    display: "inline-block",
    width: 14,
    height: 14,
    border: `2px solid ${C.border}`,
    borderTopColor: C.orange,
    borderRadius: "50%",
    animation: "spin 0.6s linear infinite",
    verticalAlign: "middle",
  },
};
