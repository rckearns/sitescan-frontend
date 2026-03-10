import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, GeoJSON, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";

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

// Returns { label, color } for how old a posted_date is, or null if unknown
function postedAge(dateStr) {
  if (!dateStr) return null;
  const days = Math.floor((Date.now() - new Date(dateStr)) / (1000 * 60 * 60 * 24));
  if (isNaN(days) || days < 0) return null;
  if (days === 0) return { label: "Today",          color: "#22c55e" };
  if (days === 1) return { label: "Yesterday",       color: "#22c55e" };
  if (days <= 7)  return { label: `${days}d ago`,    color: "#22c55e" };
  if (days <= 30) return { label: `${Math.ceil(days/7)}w ago`,  color: C.textSub };
  if (days <= 90) return { label: `${Math.ceil(days/30)}mo ago`, color: C.textMuted };
  return           { label: `${Math.ceil(days/30)}mo ago`,       color: "#3d4f5e" }; // very old, dim
}

const fmtEst = (v) => {
  if (!v) return null;
  if (v >= 1e6) return `~$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `~$${(v / 1e3).toFixed(0)}K`;
  return `~$${v.toLocaleString()}`;
};

function buildValueMedians(projects) {
  const buckets = {};
  for (const p of projects) {
    if (!p.value || p.value <= 0) continue;
    const key = `${p.category || "unknown"}__${p.work_class || "unknown"}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(p.value);
  }
  const medians = {};
  for (const [key, vals] of Object.entries(buckets)) {
    const sorted = [...vals].sort((a, b) => a - b);
    medians[key] = sorted[Math.floor(sorted.length / 2)];
  }
  return medians;
}

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

// Return a neighbourhood name from lat/lng using Charleston bounding boxes
function getNeighborhood(lat, lng) {
  if (!lat || !lng) return null;
  if (lat >= 32.755 && lat <= 32.810 && lng >= -79.975 && lng <= -79.900) return "Downtown";
  if (lat >= 32.730 && lat <= 32.790 && lng >= -80.075 && lng <= -79.970) return "West Ashley";
  if (lat >= 32.700 && lat <= 32.762 && lng >= -80.005 && lng <= -79.910) return "James Island";
  if (lat >= 32.830 && lat <= 32.960 && lng >= -80.110 && lng <= -79.870) return "North Charleston";
  if (lat >= 32.775 && lat <= 32.920 && lng >= -79.910 && lng <= -79.730) return "Mt Pleasant";
  if (lat >= 32.620 && lat <= 32.740 && lng >= -80.130 && lng <= -79.940) return "Johns Island";
  if (lat >= 32.835 && lat <= 32.880 && lng >= -79.935 && lng <= -79.865) return "Daniel Island";
  if (lat >= 32.640 && lat <= 32.680 && lng >= -79.975 && lng <= -79.920) return "Folly Beach";
  return null;
}

// Strip trailing city/state from a raw address string
function cleanAddress(address) {
  if (!address) return null;
  return address
    .replace(/,?\s*charleston,?\s*sc\b.*$/i, "")
    .replace(/,?\s*south carolina\b.*$/i, "")
    .trim() || null;
}

// Group a sorted project list by normalised address.
// Returns an array of { address, displayAddress, lat, lng, projects[] } objects.
// Single-project "groups" are included — callers decide how to render them.
// Charleston permit helpers
function isSubpermit(project) {
  if (project.source_id !== "charleston-permits") return false;
  const text = `${project.title} ${project.description}`.toLowerCase();
  return text.includes("subpermit") || text.includes("sub-permit") || text.includes("sub permit");
}

function getWorkClass(project) {
  if (project.source_id !== "charleston-permits") return null;
  // Description format: "description | work_class | permit_type"
  const parts = (project.description || "").split(" | ");
  if (parts.length >= 2) {
    const wc = parts[1].trim();
    if (wc) return wc;
  }
  return null;
}

// Generic permit descriptions that carry no useful info beyond the category
const _GENERIC_TITLE = /^(new construction|building permit|commercial|residential|renovation|tenant improvement|addition|alteration|remodel|repair|demolition|interior|exterior|miscellaneous|other)[\s.]*$/i;

function getDisplayTitle(project) {
  if (!project.title) return project.title;

  // For permit sources, strip the " — address" suffix the backend appends
  // (address is already shown in the location tag)
  const permitSources = new Set([
    "charleston-permits","north-charleston-permits","mt-pleasant-permits",
    "charlotte-permits","charlotte-land-dev",
  ]);
  let title = project.title;
  if (permitSources.has(project.source_id)) {
    title = title.split(" — ")[0].trim();
  }

  // Fall back to category+workclass only if the description is truly generic
  if (_GENERIC_TITLE.test(title)) {
    const wc = getWorkClass(project);
    const cat = project.category;
    if (cat && cat !== "residential") {
      const catLabel = cat.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      return wc ? `${catLabel} — ${wc}` : catLabel;
    }
  }

  return title;
}

// Procurement boilerplate openers that add no useful info for a GC
const _BID_BOILERPLATE = /^(this is (a |an )?(combined synopsis|sources sought|pre-?solicitation|request for (proposal|quote|information)|rfp|rfq|rfi|notice of intent|amendment)|the (government|department|agency|city|county|state) is (requesting|seeking|issuing|soliciting)|synopsis\/solicitation|pre-solicitation notice|combined synopsis\/solicitation|notice type:|set-aside:|naics code:|product service code:|response date:|solicitation number:)/i;

function getDescText(project) {
  if (!project.description) return null;

  if (project.source_id === "charleston-permits") {
    const text = project.description.split(" | ")[0].trim();
    return text && text.length > 4 ? text : null;
  }

  // For bid sources: skip boilerplate opener sentences, show first meaningful content
  const BID_SOURCES = new Set(["sam-gov", "scbo", "charleston-city-bids", "charlotte-cip", "charlotte-ncdot"]);
  if (BID_SOURCES.has(project.source_id)) {
    // Split on sentence boundaries and skip boilerplate openers
    const sentences = project.description.split(/(?<=[.!?])\s+/);
    const meaningful = sentences.find(s => s.length > 20 && !_BID_BOILERPLATE.test(s.trim()));
    if (meaningful) {
      // Return first ~300 chars of useful content
      return meaningful.length > 300 ? meaningful.slice(0, 297) + "…" : meaningful;
    }
    // Fall back to first 300 chars if no clean sentence found
    return project.description.slice(0, 300) + (project.description.length > 300 ? "…" : "");
  }

  return project.description.length > 4 ? project.description : null;
}

// Category priority for picking the most informative permit from a group
const _CAT_PRIORITY = [
  "office", "hotel", "multi-family", "restaurant", "industrial",
  "institutional", "retail", "mixed-use", "commercial",
  "structural", "masonry", "historic-restoration", "government",
];

function getPrimaryPermit(projects) {
  const withValue = [...projects].sort((a, b) => (b.value || 0) - (a.value || 0));
  if (withValue[0]?.value) return withValue[0];
  return [...projects].sort((a, b) => {
    const ai = _CAT_PRIORITY.indexOf(a.category);
    const bi = _CAT_PRIORITY.indexOf(b.category);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  })[0];
}

function groupByAddress(projects) {
  const order = [];
  const map = new Map();

  for (const p of projects) {
    const raw = (p.address || "").trim();
    const key = raw.toUpperCase().replace(/\s+/g, " ");
    if (key.length > 3) {
      if (map.has(key)) {
        map.get(key).projects.push(p);
      } else {
        const grp = { address: key, displayAddress: raw, lat: p.latitude, lng: p.longitude, projects: [p] };
        map.set(key, grp);
        order.push(grp);
      }
    } else {
      // No usable address — treat as its own group with null address
      order.push({ address: null, displayAddress: null, lat: p.latitude, lng: p.longitude, projects: [p] });
    }
  }
  return order;
}

// ─── PARCEL OPPORTUNITY HELPERS ───────────────────────────────────────────────

// Score 0–100: how underimproved is this parcel relative to its land value?
// Vacant land = 95 (max opportunity), full build = ~5.
function parcelOppScore(props) {
  const genuse = (props.GENUSE || "").toLowerCase();
  if (genuse.includes("undevelopable")) return 3;

  const land = parseFloat(props.LAND_APPR) || 0;
  const imp  = parseFloat(props.IMP_APPR)  || 0;

  if (land === 0 && imp === 0) return 50;   // unknown
  if (imp === 0)  return 95;                // vacant land → maximum opportunity
  if (land === 0) return 15;               // improvements only, no land value recorded

  const impRatio = imp / (land + imp);
  return Math.max(3, Math.round((1 - impRatio) * 100));
}

function parcelColor(score) {
  if (score >= 80) return "#f0a030";  // orange — vacant/underbuilt
  if (score >= 55) return "#7ec8e3";  // sky   — mixed
  if (score >= 30) return "#4a90d9";  // blue  — moderate build
  return "#3a5f85";                   // slate — fully developed (visible on dark map)
}

const catIcons = {
  "historic-restoration": "🏛️",
  masonry: "🧱",
  structural: "🏗️",
  government: "⚖️",
  commercial: "🏢",
  hotel: "🏨",
  "multi-family": "🏘️",
  "mixed-use": "🏙️",
  office: "🖥️",
  restaurant: "🍽️",
  retail: "🛍️",
  industrial: "🏭",
  institutional: "🏫",
};

const sourceLabels = {
  "sam-gov": "SAM.gov",
  "charleston-permits": "CHS Permits",
  "north-charleston-permits": "N. Charleston",
  "mt-pleasant-permits": "Mt. Pleasant",
  scbo: "SCBO",
  "charleston-city-bids": "CHS Bids",
  "charlotte-permits": "Charlotte",
  "charlotte-land-dev": "CLT Land Dev",
  "charlotte-cip": "CLT CIP",
  "charlotte-ncdot": "CLT NCDOT",
};

const sourceColors = {
  "charleston-permits":        C.orange,
  "north-charleston-permits":  C.orange,
  "mt-pleasant-permits":       C.orange,
  "charlotte-permits":         C.orange,
  "charlotte-land-dev":        C.orange,
  "sam-gov":                   C.blue,
  "scbo":                      C.blue,
  "charleston-city-bids":      C.blue,
  "charlotte-cip":             C.sky,
  "charlotte-ncdot":           C.sky,
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
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: ${C.bg}; }
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700;800&display=swap');
      `}</style>
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

// ─── PROJECT CARD ─────────────────────────────────────────────────────────────
// One card per project (address group). Shows the most informative permit.

function ProjectCard({ group, onSave, savedIds, animDelay, onDismiss, valueMedians = {} }) {
  const { lat, lng, projects } = group;
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const primary = getPrimaryPermit(projects);
  const displayTitle = getDisplayTitle(primary);
  const workClass = getWorkClass(primary);
  const hood = getNeighborhood(lat, lng);
  const maxValue = Math.max(...projects.map((p) => p.value || 0)) || null;
  const estValue = !maxValue
    ? valueMedians[`${primary.category || "unknown"}__${primary.work_class || "unknown"}`] || null
    : null;
  const isSaved = savedIds.has(primary.id);
  const descText = getDescText(primary);

  // Location: neighborhood for CHS permits, else agency/location
  const locationTag = primary.source_id === "charleston-permits"
    ? hood
    : primary.location || hood;

  // Deadline urgency
  const deadlineTag = (() => {
    if (!primary.deadline) return null;
    const days = Math.ceil((new Date(primary.deadline) - Date.now()) / (1000 * 60 * 60 * 24));
    if (days < 0) return null; // already passed
    if (days <= 7)  return { label: days === 0 ? "Due today" : `Due in ${days}d`, color: "#ef4444" };
    if (days <= 30) return { label: `Due in ${days}d`, color: "#f59e0b" };
    return null; // far out, not urgent enough to surface
  })();

  return (
    <div style={{ marginBottom: 6, animation: `fadeIn 0.3s ease ${animDelay}s both` }}>
      <div
        onClick={() => setExpanded(!expanded)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ ...styles.projectRow, borderLeft: `3px solid ${(maxValue || estValue) ? (sourceColors[primary.source_id] || C.border) : C.border}`, position: "relative", opacity: (maxValue || estValue) ? 1 : 0.65 }}
      >
        {hovered && (
          <button
            onClick={(e) => { e.stopPropagation(); onDismiss(primary.id); }}
            title="Hide this project"
            style={{
              position: "absolute", top: 8, right: 8, background: "none",
              border: "none", color: "#444", fontSize: 16, cursor: "pointer",
              lineHeight: 1, padding: "2px 5px", borderRadius: 4,
              transition: "color 0.1s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "#444"; }}
          >
            ✕
          </button>
        )}
        <div style={styles.projectHeader}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={styles.projectTitle}>
              <span style={{ marginRight: 8 }}>{catIcons[primary.category] || "📋"}</span>
              {displayTitle}
            </div>
            <div style={styles.projectMeta}>
              {primary.category && (
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 3,
                  background: `${C.blue}18`, color: C.blue, textTransform: "capitalize",
                  letterSpacing: "0.03em", flexShrink: 0,
                }}>
                  {primary.category.replace(/-/g, " ")}
                </span>
              )}
              {workClass && (
                <span style={{
                  marginLeft: 5, fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 3,
                  background: "#ffffff0a", color: C.textMuted, textTransform: "capitalize",
                  letterSpacing: "0.03em", flexShrink: 0,
                }}>
                  {workClass}
                </span>
              )}
              {locationTag && (
                <span style={{ marginLeft: 10, color: C.textSub }}>{locationTag}</span>
              )}
              {primary.contractor && (
                <span style={{ marginLeft: 12, color: C.textMuted }}>👷 {primary.contractor}</span>
              )}
              {primary.agency && (
                <span style={{ marginLeft: locationTag ? 12 : 0, color: C.textSub }}>
                  🏢 {primary.agency.split("|")[0]}
                </span>
              )}
              <span style={{ marginLeft: 8 }}>
                <span style={{
                  fontSize: 10, padding: "1px 7px", borderRadius: 3,
                  background: `${sourceColors[primary.source_id] || "#ffffff"}0f`,
                  color: sourceColors[primary.source_id] || "#666",
                  fontWeight: 600, letterSpacing: "0.02em",
                }}>
                  {sourceLabels[primary.source_id] || primary.source_id}
                </span>
              </span>
              {(() => { const age = postedAge(primary.posted_date); return age ? (
                <span style={{ marginLeft: 8, fontSize: 11, color: age.color, whiteSpace: "nowrap" }}>
                  {age.label}
                </span>
              ) : null; })()}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
            {deadlineTag && (
              <span style={{
                fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                background: `${deadlineTag.color}20`, color: deadlineTag.color,
                border: `1px solid ${deadlineTag.color}40`, whiteSpace: "nowrap",
              }}>
                ⏱ {deadlineTag.label}
              </span>
            )}
            <div style={{ width: 80, textAlign: "right" }}>
              {maxValue ? (
                <div style={{ color: C.orange, fontWeight: 700, fontSize: 14, fontFamily: "'JetBrains Mono', monospace" }}>
                  {fmt$(maxValue)}
                </div>
              ) : estValue ? (
                <div style={{ color: C.textMuted, fontWeight: 400, fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}
                  title="Estimated from similar projects">
                  {fmtEst(estValue)}
                </div>
              ) : (
                <div style={{ color: C.textMuted, fontWeight: 400, fontSize: 14, fontFamily: "'JetBrains Mono', monospace" }}>—</div>
              )}
            </div>
            <div style={{ width: 110, display: "flex", justifyContent: "flex-end" }}>
              <StatusPill status={primary.status} />
            </div>
          </div>
        </div>

        {expanded && (
          <div style={styles.projectExpanded}>
            {descText && (
              <div style={{ marginBottom: 16 }}>
                <div style={styles.detailLabel}>Description</div>
                <div style={{ color: "#aaa", fontSize: 13, lineHeight: 1.6 }}>{descText}</div>
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }}>
              <div>
                <div style={styles.detailLabel}>Posted</div>
                <div style={styles.detailValue}>{fmtDate(primary.posted_date)}</div>
              </div>
              {primary.deadline && (
                <div>
                  <div style={styles.detailLabel}>Deadline</div>
                  <div style={styles.detailValue}>{fmtDate(primary.deadline)}</div>
                </div>
              )}
              {primary.permit_number && (
                <div>
                  <div style={styles.detailLabel}>Permit #</div>
                  <div style={styles.detailValue}>{primary.permit_number}</div>
                </div>
              )}
              {primary.solicitation_number && (
                <div>
                  <div style={styles.detailLabel}>Solicitation #</div>
                  <div style={styles.detailValue}>{primary.solicitation_number}</div>
                </div>
              )}
              {primary.contractor && (
                <div>
                  <div style={styles.detailLabel}>Contractor</div>
                  <div style={styles.detailValue}>{primary.contractor}</div>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {primary.source_url && (
                <a href={primary.source_url} target="_blank" rel="noopener"
                  style={styles.linkBtn} onClick={(e) => e.stopPropagation()}>
                  View Source →
                </a>
              )}
              {!isSaved && (
                <button style={styles.saveBtn}
                  onClick={(e) => { e.stopPropagation(); onSave(primary.id); }}>
                  ★ Save
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// ─── STATS BAR ──────────────────────────────────────────────────────────────

function StatsBar({ stats }) {
  if (!stats) return null;
  return (
    <div className="stats-grid">
      <div style={{ ...styles.statBox, borderLeft: `3px solid ${C.blue}` }}>
        <div style={styles.statNumber}>{stats.total_projects}</div>
        <div style={styles.statLabel}>Active Projects</div>
      </div>
      <div style={{ ...styles.statBox, borderLeft: `3px solid ${C.orange}` }}>
        <div style={{ ...styles.statNumber, color: C.orange }}>{fmt$(stats.total_pipeline_value)}</div>
        <div style={styles.statLabel}>Pipeline Value</div>
      </div>
      <div style={{ ...styles.statBox, borderLeft: `3px solid ${C.sky}` }}>
        <div style={{ ...styles.statNumber, color: C.sky }}>{stats.new_this_week}</div>
        <div style={styles.statLabel}>New This Week</div>
      </div>
      <div style={{ ...styles.statBox, borderLeft: `3px solid #22c55e` }}>
        <div style={{ ...styles.statNumber, color: "#22c55e" }}>{stats.bids_open}</div>
        <div style={styles.statLabel}>Bids Open</div>
      </div>
    </div>
  );
}

// ─── PROFILE TAB ────────────────────────────────────────────────────────────

const ALL_CATEGORIES = [
  { id: "healthcare", label: "Healthcare" },
  { id: "education", label: "Education" },
  { id: "government", label: "Government" },
  { id: "institutional", label: "Institutional" },
  { id: "office", label: "Office" },
  { id: "retail", label: "Retail" },
  { id: "restaurant", label: "Restaurant" },
  { id: "hotel", label: "Hotel" },
  { id: "multi-family", label: "Multi-Family" },
  { id: "mixed-use", label: "Mixed Use" },
  { id: "industrial", label: "Industrial" },
  { id: "renovation", label: "Renovation" },
  { id: "historic-restoration", label: "Historic Restoration" },
  { id: "commercial", label: "Commercial" },
  { id: "other", label: "Other" },
];
const ALL_STATUSES = ["Open", "Active", "Accepting Bids", "Issued", "In Review", "Finaled"];
const ALL_SOURCES = [
  { id: "sam-gov", label: "SAM.gov" },
  { id: "charleston-permits", label: "CHS Permits" },
  { id: "north-charleston-permits", label: "N. Charleston" },
  { id: "mt-pleasant-permits", label: "Mt. Pleasant" },
  { id: "scbo", label: "SCBO" },
  { id: "charleston-city-bids", label: "CHS City Bids" },
  { id: "charlotte-permits", label: "Charlotte" },
  { id: "charlotte-land-dev", label: "CLT Land Dev" },
  { id: "charlotte-cip", label: "CLT CIP" },
  { id: "charlotte-ncdot", label: "CLT NCDOT" },
];
const CLIENT_TYPES = [
  { id: "developer",  label: "Developer" },
  { id: "government", label: "Government" },
  { id: "higher-ed",  label: "Higher Ed" },
  { id: "broker",     label: "Broker" },
];
const CLIENT_TYPE_SOURCES = {
  developer:  new Set(["charleston-permits","north-charleston-permits","mt-pleasant-permits","charlotte-permits","charlotte-land-dev"]),
  government: new Set(["sam-gov","scbo","charleston-city-bids","charlotte-cip","charlotte-ncdot"]),
};
const CLIENT_TYPE_CATEGORIES = {
  "higher-ed": new Set(["institutional","healthcare","education"]),
  broker:      new Set(["commercial","office","retail","renovation"]),
};
function projectMatchesClientTypes(project, clientTypes) {
  if (!clientTypes.length) return true;
  return clientTypes.some(ct =>
    CLIENT_TYPE_SOURCES[ct]?.has(project.source_id) ||
    CLIENT_TYPE_CATEGORIES[ct]?.has(project.category)
  );
}

// Trade-only permit categories — subcontractor pulls, not GC-level projects.
// Excluded from the default feed; shown only when explicitly filtered for.
const TRADE_CATEGORIES = new Set([
  "fire-sprinkler", "electrical", "plumbing", "mechanical", "painting", "roofing",
]);

// Civil/infrastructure and sub-permit titles to exclude from the default GC feed.
const CIVIL_INFRA_RE = /\b(culvert|resurfacing|road\s+(resurface|widening|repair|improvement)|highway\s+construction|roundabout|bridge\s+(repair|replacement|construction|project)|pavement\s+(marking|replacement)|traffic\s+signal|water\s+main|sewer\s+main|utility\s+(relocation|undergrounding))\b|^(phasing\s+permit|phased\s+permit|parking\s+garage\s+for\s|roof\s+permit\s+for\s)/i;

// Lowcountry region filtering
const LOWCOUNTRY_RE = /\b(charleston|mt\.?\s*pleasant|mount\s+pleasant|goose\s+creek|summerville|hanahan|isle\s+of\s+palms|sullivan'?s\s+island|james\s+island|johns\s+island|daniel\s+island|folly\s+beach|ladson|moncks\s+corner|berkeley\s+county|dorchester\s+county|north\s+charleston|seabrook|kiawah)\b/i;
const LOWCOUNTRY_PERMIT_SOURCES = new Set([
  "charleston-permits", "north-charleston-permits", "mt-pleasant-permits", "charleston-city-bids",
]);
const CHARLOTTE_SOURCES = new Set([
  "charlotte-permits", "charlotte-land-dev", "charlotte-cip", "charlotte-ncdot",
]);
function projectInLowcountry(project) {
  if (LOWCOUNTRY_PERMIT_SOURCES.has(project.source_id)) return true;
  if (CHARLOTTE_SOURCES.has(project.source_id)) return false;
  const text = `${project.title || ""} ${project.description || ""}`;
  return LOWCOUNTRY_RE.test(text);
}

function ProfileTab({ lastScanAt, onScan }) {
  const [defaults, setDefaults] = useState({ clientTypes: [], minValue: 0, categories: [], statuses: [] });
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const [connTesting, setConnTesting] = useState(false);
  const [connResult, setConnResult] = useState(null);
  const [dbResult, setDbResult] = useState(null);

  useEffect(() => {
    api("/auth/me").then((data) => setDefaults({
      clientTypes: data.criteria_client_types || [],
      minValue: data.criteria_min_value || 0,
      categories: data.criteria_categories || [],
      statuses: data.criteria_statuses || [],
    }));
  }, []);

  const toggle = (key, id) =>
    setDefaults((d) => {
      const arr = d[key] || [];
      return { ...d, [key]: arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id] };
    });

  const saveDefaults = async () => {
    setSaving(true);
    await api("/auth/me", { method: "PATCH", body: JSON.stringify({
      criteria_client_types: defaults.clientTypes,
      criteria_min_value: defaults.minValue || null,
      criteria_categories: defaults.categories,
      criteria_statuses: defaults.statuses,
    }) });
    setSaving(false);
    setSavedMsg("✓ Saved as defaults");
    setTimeout(() => setSavedMsg(""), 4000);
  };

  const chip = (active, color) => ({
    padding: "7px 14px", borderRadius: 8,
    border: `1px solid ${active ? color : C.border}`,
    background: active ? `${color}20` : "transparent",
    color: active ? color : C.textSub,
    fontSize: 12, fontWeight: 600, cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s",
  });
  const sectionLabel = { fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase",
    letterSpacing: "0.08em", marginBottom: 10, display: "block" };

  const doScan = async () => {
    setScanning(true);
    setScanMsg("");
    try {
      const data = await api("/scan/trigger", { method: "POST" });
      setScanMsg(data.message);
      onScan();
    } catch {
      setScanMsg("Scan failed");
    }
    setScanning(false);
    setTimeout(() => setScanMsg(""), 6000);
  };

  const doConnTest = async () => {
    setConnTesting(true);
    setConnResult(null);
    setDbResult(null);
    try {
      const data = await api("/scan/connectivity");
      setConnResult(data);
    } catch (e) {
      setConnResult({ error: e.message });
    }
    setConnTesting(false);
  };

  return (
    <div style={{ maxWidth: 620 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>Settings</h2>

      {/* Default filters */}
      <div style={{ marginBottom: 36 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 6 }}>Default Filters</h3>
        <p style={{ color: C.textSub, fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>
          Applied automatically when you log in. Override any time in the filter bar.
        </p>

        <span style={sectionLabel}>Client Type</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          {CLIENT_TYPES.map(({ id, label }) => (
            <button key={id} onClick={() => toggle("clientTypes", id)} style={chip(defaults.clientTypes.includes(id), C.orange)}>
              {label}
            </button>
          ))}
        </div>

        <span style={sectionLabel}>Minimum Value</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          {[0, 100000, 500000, 1000000, 5000000].map((v) => (
            <button key={v} onClick={() => setDefaults(d => ({ ...d, minValue: v }))} style={chip(defaults.minValue === v, C.sky)}>
              {v === 0 ? "Any" : v >= 1000000 ? `$${v / 1000000}M+` : `$${v / 1000}K+`}
            </button>
          ))}
        </div>

        <span style={sectionLabel}>Project Type</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          {ALL_CATEGORIES.map(({ id, label }) => (
            <button key={id} onClick={() => toggle("categories", id)} style={chip(defaults.categories.includes(id), C.blue)}>
              {label}
            </button>
          ))}
        </div>

        <span style={sectionLabel}>Status</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          {ALL_STATUSES.map((s) => (
            <button key={s} onClick={() => toggle("statuses", s)} style={chip(defaults.statuses.includes(s), C.sky)}>
              {s}
            </button>
          ))}
        </div>

        <button onClick={saveDefaults} disabled={saving} style={styles.authBtn}>
          {saving ? "Saving..." : "Save Defaults"}
        </button>
        {savedMsg && <span style={{ color: C.orange, fontSize: 13, marginLeft: 16 }}>{savedMsg}</span>}
      </div>

      <div style={{ borderTop: `1px solid ${C.border}`, margin: "0 0 32px" }} />

      {/* Manual scan */}
      <h3 style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 8 }}>Data Refresh</h3>
      <p style={{ color: C.textSub, fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
        Scans run automatically every 24 hours.
        {lastScanAt && <span> Last scan: <strong style={{ color: C.text }}>{fmtDate(lastScanAt)}</strong></span>}
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={doScan} disabled={scanning} style={{ ...styles.authBtn, background: C.navy, maxWidth: 180 }}>
          {scanning ? "Scanning..." : "⚡ Run Scan Now"}
        </button>
        <button onClick={doConnTest} disabled={connTesting} style={{ ...styles.authBtn, background: "transparent", border: `1px solid ${C.border}`, color: C.textSub, maxWidth: 180 }}>
          {connTesting ? "Testing..." : "Test Connectivity"}
        </button>
      </div>
      {scanMsg && <div style={{ color: C.orange, fontSize: 12, marginTop: 12 }}>{scanMsg}</div>}
      {connResult && (
        <div style={{ marginTop: 16, padding: 14, background: C.surface, borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12, fontFamily: "monospace" }}>
          {connResult.error ? (
            <div style={{ color: "#e05" }}>Error: {connResult.error}</div>
          ) : (
            <>
              <div style={{ marginBottom: 8, color: C.textSub, fontFamily: "'DM Sans', sans-serif", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>Connectivity Test</div>
              {connResult.scbo && (
                <div style={{ marginBottom: 10 }}>
                  <span style={{ color: connResult.scbo.parsed_project_count > 0 ? "#4c4" : "#e44" }}>
                    {connResult.scbo.parsed_project_count > 0 ? "✓" : "✗"} SCBO
                  </span>
                  {connResult.scbo.error
                    ? <span style={{ color: "#e44" }}> Error: {connResult.scbo.error}</span>
                    : <span>
                        {" — "}{connResult.scbo.response_bytes?.toLocaleString()} bytes
                        {connResult.scbo.raw_marker_count != null && `, ${connResult.scbo.raw_marker_count} raw / ${connResult.scbo.parsed_project_count ?? "?"} parsed`}
                      </span>
                  }
                  {" "}<span style={{ color: connResult.scbo.via_zenrows ? "#4c4" : "#e44" }}>(via: {connResult.scbo.via_zenrows ? "ZenRows ✓" : "direct — no key!"})</span>
                </div>
              )}
              {connResult.arcgis && (
                <div style={{ marginBottom: 6 }}>
                  <span style={{ color: connResult.arcgis.error || connResult.arcgis.layer20_error ? "#e44" : "#4c4" }}>
                    {connResult.arcgis.error || connResult.arcgis.layer20_error ? "✗" : "✓"} ArcGIS
                  </span>
                  {connResult.arcgis.error
                    ? <span style={{ color: "#e44" }}> Error: {connResult.arcgis.error}</span>
                    : <span>
                        {" "}L20: {connResult.arcgis.layer20_features ?? "?"} feats
                        {connResult.arcgis.layer20_error && <span style={{ color: "#e44" }}> ({JSON.stringify(connResult.arcgis.layer20_error)})</span>}
                        {" "}| L21: {connResult.arcgis.layer21_features ?? "?"} feats
                        {connResult.arcgis.layer21_error && <span style={{ color: "#e44" }}> ({JSON.stringify(connResult.arcgis.layer21_error)})</span>}
                        {connResult.arcgis.layer21_sample_statuses?.length > 0 && <span style={{ color: C.textMuted }}> [{connResult.arcgis.layer21_sample_statuses.join(", ")}]</span>}
                      </span>
                  }
                </div>
              )}
              {connResult.energov && (
                <div>
                  <span style={{ color: connResult.energov.contractors?.length > 0 ? "#4c4" : "#e44" }}>
                    {connResult.energov.contractors?.length > 0 ? "✓" : "✗"} EnerGov
                  </span>
                  {connResult.energov.error
                    ? <span style={{ color: "#e44" }}> Error: {connResult.energov.error}</span>
                    : <span> — {connResult.energov.contacts_found} contacts, contractors: [{connResult.energov.contractors?.join(", ") || "none"}]</span>
                  }
                </div>
              )}
            </>
          )}
        </div>
      )}
      <button onClick={async () => { const d = await api("/scan/debug-permits?address=CALHOUN"); setDbResult(d); }} style={{ marginTop: 10, background: "transparent", border: `1px solid ${C.border}`, color: C.textMuted, fontSize: 11, padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>
        Check Emanuel DB State
      </button>
      {dbResult && (
        <div style={{ marginTop: 10, padding: 12, background: C.surface, borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 11, fontFamily: "monospace", maxHeight: 220, overflowY: "auto" }}>
          {dbResult.map((p, i) => (
            <div key={i} style={{ marginBottom: 6, borderBottom: `1px solid ${C.border}`, paddingBottom: 4 }}>
              <span style={{ color: p.contractor !== "(empty)" ? "#4c4" : "#e44" }}>{p.contractor !== "(empty)" ? "✓" : "✗"}</span>
              {" "}<span style={{ color: C.text }}>{p.address}</span>
              {" "}<span style={{ color: C.textMuted }}>contractor: {p.contractor}</span>
              {" "}<span style={{ color: C.textMuted }}>[active:{String(p.is_active)}, cat:{p.category}]</span>
            </div>
          ))}
          {dbResult.length === 0 && <span style={{ color: "#e44" }}>No Calhoun permits found in DB</span>}
        </div>
      )}
    </div>
  );
}

// ─── CITY SELECTOR ──────────────────────────────────────────────────────────

const CITIES = [
  // Southeast
  { id: "charleston-sc",  label: "Charleston, SC",   icon: "🌊", active: true },
  { id: "columbia-sc",    label: "Columbia, SC",     icon: "🏛️" },
  { id: "greenville-sc",  label: "Greenville, SC",   icon: "🌿" },
  { id: "charlotte-nc",   label: "Charlotte, NC",    icon: "🏙️", active: true },
  { id: "raleigh-nc",     label: "Raleigh, NC",      icon: "🔬" },
  { id: "atlanta-ga",     label: "Atlanta, GA",      icon: "🍑" },
  { id: "savannah-ga",    label: "Savannah, GA",     icon: "🌳" },
  { id: "jacksonville-fl",label: "Jacksonville, FL", icon: "🌞" },
  { id: "orlando-fl",     label: "Orlando, FL",      icon: "🎡" },
  { id: "tampa-fl",       label: "Tampa, FL",        icon: "⚡" },
  { id: "miami-fl",       label: "Miami, FL",        icon: "🌴" },
  { id: "nashville-tn",   label: "Nashville, TN",    icon: "🎸" },
  { id: "memphis-tn",     label: "Memphis, TN",      icon: "🎵" },
  { id: "birmingham-al",  label: "Birmingham, AL",   icon: "🔩" },
  { id: "new-orleans-la", label: "New Orleans, LA",  icon: "🎷" },
  // Northeast
  { id: "new-york-ny",    label: "New York, NY",     icon: "🗽" },
  { id: "boston-ma",      label: "Boston, MA",       icon: "🦞" },
  { id: "philadelphia-pa",label: "Philadelphia, PA", icon: "🔔" },
  { id: "washington-dc",  label: "Washington, DC",   icon: "🏛️" },
  { id: "baltimore-md",   label: "Baltimore, MD",    icon: "🦀" },
  // Midwest
  { id: "chicago-il",     label: "Chicago, IL",      icon: "🌬️" },
  { id: "detroit-mi",     label: "Detroit, MI",      icon: "🚗" },
  { id: "columbus-oh",    label: "Columbus, OH",     icon: "🌰" },
  { id: "indianapolis-in",label: "Indianapolis, IN", icon: "🏎️" },
  { id: "minneapolis-mn", label: "Minneapolis, MN",  icon: "❄️" },
  { id: "kansas-city-mo", label: "Kansas City, MO",  icon: "🥩" },
  { id: "st-louis-mo",    label: "St. Louis, MO",    icon: "⚾" },
  // South / Southwest
  { id: "dallas-tx",      label: "Dallas, TX",       icon: "🤠" },
  { id: "houston-tx",     label: "Houston, TX",      icon: "⭐" },
  { id: "san-antonio-tx", label: "San Antonio, TX",  icon: "🌵" },
  { id: "austin-tx",      label: "Austin, TX",       icon: "🎶" },
  { id: "oklahoma-city-ok",label:"Oklahoma City, OK",icon: "🌪️" },
  { id: "phoenix-az",     label: "Phoenix, AZ",      icon: "☀️" },
  { id: "tucson-az",      label: "Tucson, AZ",       icon: "🌵" },
  { id: "las-vegas-nv",   label: "Las Vegas, NV",    icon: "🎰" },
  { id: "albuquerque-nm", label: "Albuquerque, NM",  icon: "🎈" },
  // West
  { id: "los-angeles-ca", label: "Los Angeles, CA",  icon: "🎬" },
  { id: "san-diego-ca",   label: "San Diego, CA",    icon: "🌮" },
  { id: "san-francisco-ca",label:"San Francisco, CA",icon: "🌉" },
  { id: "sacramento-ca",  label: "Sacramento, CA",   icon: "🌾" },
  { id: "portland-or",    label: "Portland, OR",     icon: "🌲" },
  { id: "seattle-wa",     label: "Seattle, WA",      icon: "☕" },
  { id: "denver-co",      label: "Denver, CO",       icon: "⛰️" },
  { id: "salt-lake-city-ut",label:"Salt Lake City, UT",icon:"⛷️" },
];

function CitySelector() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 11px",
          background: open ? C.surfaceHi : "transparent",
          border: `1px solid ${open ? C.borderHi : C.border}`,
          borderRadius: 8,
          color: C.text,
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "'DM Sans', sans-serif",
          transition: "all 0.15s",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ fontSize: 13 }}>🌊</span>
        Charleston, SC
        <span style={{ color: C.textMuted, fontSize: 9, marginLeft: 2 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: "absolute",
          top: "calc(100% + 6px)",
          right: 0,
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          padding: "6px",
          zIndex: 300,
          minWidth: 220,
          maxHeight: 360,
          overflowY: "auto",
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
        }}>
          <div style={{ padding: "4px 10px 8px", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, borderBottom: `1px solid ${C.border}`, marginBottom: 4 }}>
            Select Market
          </div>
          {CITIES.map((city) => (
            <div
              key={city.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "7px 10px",
                borderRadius: 6,
                background: city.active ? `${C.blue}12` : "transparent",
                cursor: city.active ? "default" : "not-allowed",
              }}
            >
              <span style={{ fontSize: 13, color: city.active ? C.text : C.textSub, fontWeight: city.active ? 600 : 400 }}>
                {city.icon} {city.label}
              </span>
              {city.active ? (
                <span style={{ fontSize: 9, fontWeight: 700, color: C.blue, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Active
                </span>
              ) : (
                <span style={{
                  fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em",
                  color: C.textMuted, background: `${C.textMuted}15`,
                  border: `1px solid ${C.textMuted}25`, padding: "2px 6px", borderRadius: 4,
                }}>
                  Soon
                </span>
              )}
            </div>
          ))}
        </div>
      )}
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

function FilterBar({ filters, setFilters }) {
  const [showMore, setShowMore] = useState(false);

  const toggleDir = () =>
    setFilters((f) => ({ ...f, sortDir: f.sortDir === "desc" ? "asc" : "desc" }));
  const toggle = (key, id) =>
    setFilters((f) => {
      const arr = f[key] || [];
      return { ...f, [key]: arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id] };
    });

  const btnBase = {
    padding: "9px 11px", background: C.surface, border: `1px solid ${C.border}`,
    borderRadius: 8, color: C.textSub, fontSize: 16, cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif", minWidth: 38, textAlign: "center",
    transition: "border-color 0.15s, color 0.15s",
  };
  const chip = (active, color) => ({
    padding: "6px 13px", borderRadius: 8,
    border: `1px solid ${active ? color : C.border}`,
    background: active ? `${color}20` : "transparent",
    color: active ? color : C.textSub,
    fontSize: 12, fontWeight: 600, cursor: "pointer",
    fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s",
  });
  const rowLabel = { fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase",
    letterSpacing: "0.08em", marginRight: 8, alignSelf: "center", whiteSpace: "nowrap" };

  const moreCount = (filters.categories || []).length + (filters.statuses || []).length;

  return (
    <div style={{ ...styles.filterBar, flexWrap: "wrap", gap: 6 }}>
      {/* Client type + region */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "1 1 100%", alignItems: "center" }}>
        <span style={rowLabel}>Client</span>
        {CLIENT_TYPES.map(({ id, label }) => (
          <button key={id} onClick={() => toggle("clientTypes", id)} style={chip((filters.clientTypes || []).includes(id), C.orange)}>
            {label}
          </button>
        ))}
        <span style={{ color: C.textMuted, alignSelf: "center", margin: "0 2px" }}>·</span>
        <button onClick={() => setFilters(f => ({ ...f, lowcountry: !f.lowcountry }))}
          style={chip(!!filters.lowcountry, C.sky)}>
          Lowcountry
        </button>
      </div>
      {/* Min value + More filters toggle on same row */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "1 1 100%", alignItems: "center" }}>
        <span style={rowLabel}>Min Value</span>
        {[0, 100000, 500000, 1000000, 5000000].map((v) => (
          <button key={v} onClick={() => setFilters(f => ({ ...f, minValue: v }))}
            style={chip((filters.minValue || 0) === v, C.sky)}>
            {v === 0 ? "Any" : v >= 1000000 ? `$${v / 1000000}M+` : `$${v / 1000}K+`}
          </button>
        ))}
        <button
          onClick={() => setShowMore(v => !v)}
          style={{
            marginLeft: "auto", padding: "6px 13px", borderRadius: 8, cursor: "pointer",
            border: `1px solid ${showMore || moreCount > 0 ? C.blue : C.border}`,
            background: showMore ? `${C.blue}20` : "transparent",
            color: showMore || moreCount > 0 ? C.blue : C.textSub,
            fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans', sans-serif",
            transition: "all 0.15s", whiteSpace: "nowrap",
          }}
        >
          {showMore ? "▲ Less" : "▼ More"}{moreCount > 0 ? ` (${moreCount})` : ""}
        </button>
      </div>
      {/* Project type + Status — collapsed by default */}
      {showMore && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "1 1 100%", alignItems: "center" }}>
            <span style={rowLabel}>Type</span>
            {ALL_CATEGORIES.map(({ id, label }) => (
              <button key={id} onClick={() => toggle("categories", id)} style={chip((filters.categories || []).includes(id), C.blue)}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "1 1 100%", alignItems: "center" }}>
            <span style={rowLabel}>Status</span>
            {ALL_STATUSES.map((s) => (
              <button key={s} onClick={() => toggle("statuses", s)} style={chip((filters.statuses || []).includes(s), C.sky)}>
                {s}
              </button>
            ))}
          </div>
        </>
      )}
      {/* Search + sort */}
      <input
        style={{ ...styles.searchInput, flex: "1 1 200px" }}
        placeholder="Search projects..."
        value={filters.search || ""}
        onChange={(e) => setFilters({ ...filters, search: e.target.value })}
      />
      <select
        style={styles.select}
        value={filters.sortBy || "value"}
        onChange={(e) => setFilters({ ...filters, sortBy: e.target.value })}
      >
        <option value="value">Sort: Value</option>
        <option value="posted_date">Sort: Recent</option>
      </select>
      <button
        onClick={toggleDir}
        title={filters.sortDir === "desc" ? "High → Low" : "Low → High"}
        style={btnBase}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.borderHi; e.currentTarget.style.color = C.text; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textSub; }}
      >
        {filters.sortDir === "desc" ? "↓" : "↑"}
      </button>
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
              <div style={{ color: C.orange, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
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

// ─── PERMIT CONTRACTOR DATA ──────────────────────────────────────────────────

// Normalize a company name for fuzzy LLR lookup: lowercase, strip legal
// suffixes and punctuation, collapse whitespace.
function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/\b(llc|l\.l\.c\.?|inc\.?|corp\.?|co\.?|ltd\.?|lp|l\.p\.?|pc|p\.c\.?|lllp|dba|d\/b\/a)\b\.?/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TRADE_RULES = [
  { trade: "Demolition",        keywords: ["demo", "demolition"] },
  { trade: "Sitework",          keywords: ["excavat", "grading", "earthwork", "sitework", "paving", "asphalt"] },
  { trade: "Framing",           keywords: ["framing", "framer", "rough carp", "rough-carp", "lumber"] },
  { trade: "Structural Steel",  keywords: ["steel", "ironwork", "iron work"] },
  { trade: "Masonry",           keywords: ["mason", "masonry", "brick", "stone", "tuckpoint"] },
  { trade: "Concrete",          keywords: ["concrete", "cement"] },
  { trade: "Roofing",           keywords: ["roof", "roofing"] },
  { trade: "Windows & Glazing", keywords: ["window", "glass", "glazing", "curtain wall", "storefront"] },
  { trade: "Drywall",           keywords: ["drywall", "gypsum", "sheetrock", "wallboard"] },
  { trade: "Plumbing",          keywords: ["plumb", "plumbing"] },
  { trade: "HVAC / Mechanical", keywords: ["hvac", "mechanical", "heating", "cooling", "air condition", "controls", "building automation", "lennox"] },
  { trade: "Electrical",        keywords: ["electric", "electrical"] },
  { trade: "Low Voltage",       keywords: ["low voltage", "low-voltage", "data", "cabling", "security system", "access control", "camera", "cctv", "av ", "audio visual", "audiovisual", "fire & security", "fire and security", "integrated security", "security integrat"] },
  { trade: "Fire / Sprinkler",  keywords: ["sprinkler", "fire suppression", "fire protection", "fire alarm", "suppression", "ansul"] },
  { trade: "Painting",          keywords: ["paint", "painting", "coating", "stucco"] },
];

const TRADE_SEQUENCE = [
  "General Contractor",
  "Demolition",
  "Sitework",
  "Framing",
  "Structural Steel",
  "Masonry",
  "Concrete",
  "Roofing",
  "Windows & Glazing",
  "Drywall",
  "Plumbing",
  "HVAC / Mechanical",
  "Electrical",
  "Low Voltage",
  "Fire / Sprinkler",
  "Painting",
];

const TRADE_ICONS = {
  "Roofing": "🏠",
  "Masonry": "🧱",
  "Concrete": "🪨",
  "Structural Steel": "⚙️",
  "Framing": "🪵",
  "Electrical": "⚡",
  "Low Voltage": "📡",
  "Plumbing": "🔧",
  "HVAC / Mechanical": "💨",
  "Sitework": "🚜",
  "Windows & Glazing": "🪟",
  "Drywall": "🔩",
  "Painting": "🎨",
  "Demolition": "💥",
  "Fire / Sprinkler": "🔥",
  "General Contractor": "🏗️",
};

// Exact-prefix overrides for well-known companies whose names don't contain
// clear trade keywords. Matched case-insensitively against the start of the name.
const TRADE_OVERRIDES = {
  "vsc":              "Fire / Sprinkler", // VSC fire alarm
  "johnson controls": "Low Voltage",
  "siemens":          "Low Voltage",
  "honeywell":        "Low Voltage",
  "carrier":          "HVAC / Mechanical",
  "trane":            "HVAC / Mechanical",
  "york ":            "HVAC / Mechanical",
  "daikin":           "HVAC / Mechanical",
  "tyco":             "Fire / Sprinkler",
  "simplex":          "Fire / Sprinkler",
  "kidde":            "Fire / Sprinkler",
  // GC firms with non-obvious names or mixed permit appearances
  "cf evans":         "General Contractor",
  "trident":          "General Contractor",
  // Electrical firms whose names don't contain "electric"
  "feyen":            "Electrical",
  // Plumbing firms
  "horizon":          "Plumbing",
  // HVAC / Mechanical firms (including those that also do plumbing)
  "cr hipp":          "HVAC / Mechanical",
  // Sitework firms
  "anson":            "Sitework",
  // Fire/Sprinkler firms with non-obvious names
  "mt pleasant radio": "Fire / Sprinkler",
  "american repeater": "Fire / Sprinkler",
  // Concrete firms (precast = concrete products, not masonry)
  "lithko":           "Concrete",
  "gate precast":     "Concrete",
};

// Map backend permit categories → frontend trade bucket names
const CATEGORY_TO_TRADE = {
  "fire-sprinkler": "Fire / Sprinkler",
  "electrical":     "Electrical",
  "plumbing":       "Plumbing",
  "mechanical":     "HVAC / Mechanical",
  "roofing":        "Roofing",
};

// Map SC LLR classification codes → frontend trade bucket names
const LLR_CLASS_TO_TRADE = {
  "CT":  "Concrete",
  "CP":  "Concrete",
  "MS":  "Masonry",
  "SF":  "Structural Steel",
  "WF":  "Framing",
  "NR":  "Drywall",
  "GD":  "Sitework",
  "RF":  "Roofing",
  "GG":  "Windows & Glazing",
  "AC":  "HVAC / Mechanical",
  "HT":  "HVAC / Mechanical",
  "EL":  "Electrical",
  "PB":  "Plumbing",
  "MM":  "Structural Steel",
  "AP":  "Sitework",
};

function inferContractorTrade(sub) {
  const lower = sub.name.toLowerCase().trim();

  // 0. Company-name overrides (well-known companies with non-obvious names).
  // Match on normalized name so punctuation/suffixes don't block matches,
  // and accept any non-alphanumeric character (space, comma, slash, etc.)
  // after the prefix so partial names don't spuriously match longer ones.
  const normalized = normalizeName(sub.name);
  for (const [prefix, trade] of Object.entries(TRADE_OVERRIDES)) {
    const normPrefix = normalizeName(prefix);
    if (
      normalized === normPrefix ||
      (normalized.startsWith(normPrefix) && !/[a-z0-9]/.test(normalized[normPrefix.length]))
    ) {
      return trade;
    }
  }

  // 1. Primary: use the most common permit category across the contractor's projects
  if (sub.projects && sub.projects.length > 0) {
    const counts = {};
    for (const p of sub.projects) {
      const mapped = CATEGORY_TO_TRADE[p.category];
      if (mapped) counts[mapped] = (counts[mapped] || 0) + 1;
    }
    if (Object.keys(counts).length > 0) {
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    }
  }

  // 2. Fallback: keyword match on company name
  for (const { trade, keywords } of TRADE_RULES) {
    if (keywords.some((k) => lower.includes(k))) return trade;
  }
  return "General Contractor";
}

// Card for a contractor that exists only in the SC LLR license directory,
// not yet observed in permit data.
function DirectoryBadgeCard({ entry }) {
  return (
    <div style={{
      padding: "10px 16px",
      borderTop: `1px solid ${C.border}`,
      display: "flex",
      alignItems: "center",
      gap: 10,
      opacity: 0.8,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.textSub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {entry.company_name}
        </div>
        {entry.city && (
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>
            {entry.city}, SC
          </div>
        )}
      </div>
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        color: C.blue,
        background: `${C.blue}18`,
        border: `1px solid ${C.blue}30`,
        borderRadius: 8,
        padding: "2px 7px",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}>
        LLR Licensed
      </div>
    </div>
  );
}

function PermitContractorCard({ sub, marketShare, tradeTotal }) {
  const [open, setOpen] = useState(false);
  const pct = marketShare != null ? marketShare : 0;
  const shareColor = pct >= 25 ? C.orange : pct >= 10 ? C.blue : C.textMuted;
  const hasMedian = sub.median_project_value != null && sub.median_project_value > 0;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
      <div
        style={{ padding: "13px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}
        onClick={() => setOpen((v) => !v)}
      >
        {/* Left: name + stats */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: C.text, marginBottom: 5 }}>{sub.name}</div>

          {/* Market share bar */}
          {tradeTotal > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <div style={{ flex: 1, height: 4, background: `${C.border}`, borderRadius: 2, overflow: "hidden" }}>
                <div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: shareColor, borderRadius: 2, transition: "width 0.4s ease" }} />
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: shareColor, fontFamily: "'JetBrains Mono', monospace", minWidth: 38, textAlign: "right" }}>
                {pct.toFixed(1)}%
              </span>
            </div>
          )}

          {/* Stats row: median (primary) · permits · total */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 16px", fontSize: 12 }}>
            {hasMedian && (
              <span style={{ color: C.text, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                {fmt$(sub.median_project_value)} <span style={{ color: C.textMuted, fontWeight: 400, fontFamily: "'DM Sans', sans-serif" }}>median</span>
              </span>
            )}
            <span style={{ color: C.textMuted }}>
              {sub.project_count} permit{sub.project_count !== 1 ? "s" : ""}
            </span>
            {sub.total_scope_value > 0 && (
              <span style={{ color: C.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
                {fmt$(sub.total_scope_value)} total
              </span>
            )}
          </div>
        </div>

        <span style={{ color: C.textMuted, fontSize: 11, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${C.border}` }}>
          {sub.projects.map((p, i) => (
            <div
              key={p.id}
              style={{
                padding: "10px 18px",
                borderBottom: i < sub.projects.length - 1 ? `1px solid ${C.border}33` : "none",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: C.text, fontWeight: 600, marginBottom: 2 }}>{p.title}</div>
                <div style={{ fontSize: 11, color: C.textSub, display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
                  {p.address && <span>{cleanAddress(p.address)}</span>}
                  {p.permit_number && <span>Permit {p.permit_number}</span>}
                  <span style={{ fontSize: 10, padding: "1px 5px", background: "#ffffff08", borderRadius: 3, color: "#888" }}>
                    {catIcons[p.category] || "📋"} {p.category}
                  </span>
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ color: C.orange, fontWeight: 700, fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>
                  {fmt$(p.value)}
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{fmtDate(p.posted_date)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MEDIAN_THRESHOLDS = [
  { label: "Any size",   value: 0 },
  { label: "> $10K median",  value: 10000 },
  { label: "> $25K median",  value: 25000 },
  { label: "> $50K median",  value: 50000 },
  { label: "> $100K median", value: 100000 },
  { label: "> $250K median", value: 250000 },
  { label: "> $500K median", value: 500000 },
];

function PermitContractorsSection() {
  const [allData, setAllData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dirData, setDirData] = useState(null);      // SC LLR directory entries
  const [dirStatus, setDirStatus] = useState(null);  // {has_api_key, total_entries}
  const [dirRefreshing, setDirRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("total_scope_value");
  const [minMedian, setMinMedian] = useState(25000);
  const [openTrades, setOpenTrades] = useState(new Set());

  const toggleTrade = (trade) => setOpenTrades((prev) => {
    const next = new Set(prev);
    if (next.has(trade)) next.delete(trade);
    else next.add(trade);
    return next;
  });

  useEffect(() => {
    if (!allData && !loading) {
      setLoading(true);
      api("/projects/subcontractors?source=charleston-permits")
        .then((d) => setAllData(d))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
    // Load directory status + data (silently — directory may be empty)
    api("/directory/status").then((s) => setDirStatus(s)).catch(() => {});
    api("/directory/contractors?active_only=true&limit=2000")
      .then((entries) => setDirData(entries))
      .catch(() => {});
  }, []);

  const triggerDirRefresh = () => {
    if (dirRefreshing) return;
    setDirRefreshing(true);
    api("/directory/refresh", { method: "POST" })
      .then(() => {
        setTimeout(() => {
          api("/directory/status").then(setDirStatus).catch(() => {});
          setDirRefreshing(false);
        }, 3000);
      })
      .catch(() => setDirRefreshing(false));
  };

  // Filter by search + min median, then sort
  const filteredSubs = useMemo(() => {
    if (!allData) return [];
    let subs = allData.subcontractors;
    if (search) {
      const q = search.toLowerCase();
      subs = subs.filter((s) => s.name.toLowerCase().includes(q));
    }
    if (minMedian > 0) {
      subs = subs.filter((s) => (s.median_project_value || 0) >= minMedian);
    }
    return [...subs].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "project_count") return b.project_count - a.project_count;
      if (sortBy === "median") return (b.median_project_value || 0) - (a.median_project_value || 0);
      return (b.total_scope_value || 0) - (a.total_scope_value || 0);
    });
  }, [allData, search, sortBy, minMedian]);

  // Group by inferred trade from filtered+sorted list
  // Returns { trade: { subs: [...permitSubs], dirOnly: [...dirEntries] } }
  const tradeGroups = useMemo(() => {
    if (!filteredSubs.length && !loading && (!dirData || !dirData.length)) return {};

    // Build a normalized-name → trade map from SC LLR directory.
    // This gives authoritative classification for any contractor whose name
    // matches an LLR-licensed entry, bypassing permit-category inference.
    const llrByName = new Map();
    if (dirData) {
      for (const entry of dirData) {
        const trade = LLR_CLASS_TO_TRADE[entry.classification];
        if (trade) llrByName.set(normalizeName(entry.company_name), trade);
      }
    }

    // Build set of permit-contractor names (lowercased) for dedup
    const permitNames = new Set(filteredSubs.map((s) => s.name.toLowerCase().trim()));

    const groups = {};
    const ensureTrade = (trade) => {
      if (!groups[trade]) groups[trade] = { subs: [], dirOnly: [] };
    };

    // Permit-based contractors — LLR match takes priority over inference
    for (const sub of filteredSubs) {
      const llrTrade = llrByName.get(normalizeName(sub.name));
      const trade = llrTrade || inferContractorTrade(sub);
      ensureTrade(trade);
      groups[trade].subs.push(sub);
    }

    // Directory-only entries (not already visible in permit data)
    if (dirData && search === "") {
      for (const entry of dirData) {
        const nameLower = entry.company_name.toLowerCase().trim();
        if (permitNames.has(nameLower)) continue; // already in permit results
        const trade = LLR_CLASS_TO_TRADE[entry.classification] || "General Contractor";
        ensureTrade(trade);
        groups[trade].dirOnly.push(entry);
      }
    }

    // Sort by construction sequence; unknown trades go after the known list
    return Object.fromEntries(
      Object.entries(groups).sort(([a], [b]) => {
        const ai = TRADE_SEQUENCE.indexOf(a);
        const bi = TRADE_SEQUENCE.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      })
    );
  }, [filteredSubs, dirData, loading, search]);

  const emptyState = (
    <div style={{ textAlign: "center", padding: 32, color: C.textMuted, border: `1px dashed ${C.border}`, borderRadius: 10, fontSize: 13 }}>
      No contractor data found in permit records.
    </div>
  );

  const inputStyle = {
    padding: "7px 12px",
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 7,
    color: C.text,
    fontSize: 13,
    outline: "none",
    fontFamily: "'DM Sans', sans-serif",
    minWidth: 200,
  };

  const selectStyle = {
    ...inputStyle,
    minWidth: 160,
    cursor: "pointer",
  };

  return (
    <div>
      {/* Directory status bar */}
      {dirStatus && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "8px 14px", marginBottom: 14,
          background: `${C.navy}30`, border: `1px solid ${C.border}`, borderRadius: 8,
          fontSize: 12, color: C.textSub,
        }}>
          <span style={{ flex: 1 }}>
            {dirStatus.total_entries > 0
              ? `SC LLR directory: ${dirStatus.total_entries} licensed contractors`
              : "SC LLR directory: not yet loaded"}
          </span>
          {dirStatus.has_api_key ? (
            <button
              onClick={triggerDirRefresh}
              disabled={dirRefreshing}
              style={{
                padding: "4px 10px", fontSize: 11, cursor: "pointer",
                background: dirRefreshing ? C.surface : C.blue,
                color: dirRefreshing ? C.textMuted : "#fff",
                border: `1px solid ${C.blue}`,
                borderRadius: 6, fontFamily: "'DM Sans', sans-serif",
              }}
            >
              {dirRefreshing ? "Refreshing…" : "Refresh LLR"}
            </button>
          ) : (
            <span style={{ color: C.textMuted, fontSize: 11 }}>
              Set TWOCAPTCHA_API_KEY to enable auto-refresh
            </span>
          )}
        </div>
      )}

      {/* Search + sort + median filter */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 20 }}>
        <input
          placeholder="Search contractors…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={inputStyle}
        />
        <select value={minMedian} onChange={(e) => setMinMedian(Number(e.target.value))} style={selectStyle}>
          {MEDIAN_THRESHOLDS.map(({ label, value }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={selectStyle}>
          <option value="total_scope_value">Sort: Total Value</option>
          <option value="median">Sort: Median Size</option>
          <option value="project_count">Sort: Permit Count</option>
          <option value="name">Sort: Name A–Z</option>
        </select>
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: 40, color: C.textMuted }}>Loading…</div>
      )}

      {!loading && filteredSubs.length === 0 && allData && (
        search ? (
          <div style={{ textAlign: "center", padding: 32, color: C.textMuted, fontSize: 13 }}>
            No contractors matching "{search}"
          </div>
        ) : emptyState
      )}

      {!loading && Object.keys(tradeGroups).length > 0 && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(460px, 1fr))",
          gap: 24,
          alignItems: "start",
        }}>
          {Object.entries(tradeGroups).map(([trade, group]) => {
            const { subs, dirOnly } = group;
            const isOpen = openTrades.has(trade);
            const tradeTotal = subs.reduce((sum, s) => sum + (s.total_scope_value || 0), 0);
            const totalCount = subs.length + dirOnly.length;
            return (
              <div key={trade} style={{
                background: C.surface,
                border: `1px solid ${C.border}`,
                borderRadius: 12,
                overflow: "hidden",
              }}>
                <div
                  onClick={() => toggleTrade(trade)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "12px 16px",
                    cursor: "pointer",
                    borderBottom: isOpen ? `1px solid ${C.border}` : "none",
                    background: isOpen ? `${C.navy}40` : "transparent",
                    userSelect: "none",
                  }}
                >
                  <span style={{ fontSize: 16 }}>{TRADE_ICONS[trade] || "📋"}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.text, flex: 1 }}>
                    {trade}
                  </span>
                  {tradeTotal > 0 && (
                    <span style={{ fontSize: 11, color: C.orange, fontFamily: "'JetBrains Mono', monospace", marginRight: 4 }}>
                      {fmt$(tradeTotal)}
                    </span>
                  )}
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: C.blue,
                    background: `${C.blue}18`, border: `1px solid ${C.blue}30`,
                    borderRadius: 10, padding: "2px 8px",
                  }}>
                    {totalCount}
                  </span>
                  <span style={{ color: C.textMuted, fontSize: 11, marginLeft: 4 }}>
                    {isOpen ? "▲" : "▼"}
                  </span>
                </div>
                {isOpen && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    {subs.map((sub) => {
                      const marketShare = tradeTotal > 0 ? (sub.total_scope_value || 0) / tradeTotal * 100 : 0;
                      return (
                        <PermitContractorCard key={sub.name} sub={sub} marketShare={marketShare} tradeTotal={tradeTotal} />
                      );
                    })}
                    {dirOnly.length > 0 && (
                      <>
                        {subs.length > 0 && (
                          <div style={{ padding: "6px 16px", fontSize: 10, color: C.textMuted, background: `${C.navy}20`, borderTop: `1px solid ${C.border}`, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                            LLR Licensed — Not yet in permits
                          </div>
                        )}
                        {dirOnly.map((entry) => (
                          <DirectoryBadgeCard key={`${entry.id}-${entry.classification}`} entry={entry} />
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// ─── CONTRACTORS TAB ────────────────────────────────────────────────────────

const BLANK_FORM = { name: "", specialty: "", phone: "", email: "", website: "", notes: "" };

function ContractorCard({ c, onEdit, onDelete }) {
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: "14px 18px",
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 12,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 3 }}>{c.name}</div>
        {c.specialty && (
          <div style={{ fontSize: 11, color: C.blue, fontWeight: 600, marginBottom: 4 }}>
            {c.specialty}
          </div>
        )}
        <div style={{ fontSize: 12, color: C.textSub, display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
          {c.phone && <span>📞 {c.phone}</span>}
          {c.email && <span>✉ {c.email}</span>}
          {c.website && (
            <a href={c.website.startsWith("http") ? c.website : `https://${c.website}`}
              target="_blank" rel="noopener"
              style={{ color: C.sky, textDecoration: "none" }}
              onClick={(e) => e.stopPropagation()}
            >
              🌐 {c.website.replace(/^https?:\/\//, "")}
            </a>
          )}
        </div>
        {c.notes && (
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, fontStyle: "italic" }}>
            {c.notes}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <button onClick={() => onEdit(c)} style={{
          padding: "4px 10px", background: "transparent",
          border: `1px solid ${C.border}`, borderRadius: 6,
          color: C.textSub, fontSize: 11, cursor: "pointer",
          fontFamily: "'DM Sans', sans-serif",
        }}>Edit</button>
        <button onClick={() => onDelete(c.id)} style={{
          padding: "4px 10px", background: "transparent",
          border: `1px solid #dc262640`, borderRadius: 6,
          color: "#f87171", fontSize: 11, cursor: "pointer",
          fontFamily: "'DM Sans', sans-serif",
        }}>✕</button>
      </div>
    </div>
  );
}

function ContractorForm({ initial, type, onSave, onCancel }) {
  const [form, setForm] = useState(initial || BLANK_FORM);
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    await onSave({ ...form, type });
    setSaving(false);
  };

  const inputStyle = {
    width: "100%", padding: "9px 12px",
    background: C.bg, border: `1px solid ${C.border}`,
    borderRadius: 7, color: C.text, fontSize: 13,
    outline: "none", fontFamily: "'DM Sans', sans-serif",
    marginBottom: 8,
  };

  return (
    <div style={{
      background: C.surfaceHi, border: `1px solid ${C.borderHi}`,
      borderRadius: 10, padding: "16px 18px", marginBottom: 10,
    }}>
      <input style={inputStyle} placeholder="Name *" value={form.name} onChange={(e) => set("name", e.target.value)} />
      <input style={inputStyle} placeholder="Specialty / trade (e.g. masonry, MEP, roofing)" value={form.specialty} onChange={(e) => set("specialty", e.target.value)} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <input style={{ ...inputStyle, marginBottom: 0 }} placeholder="Phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        <input style={{ ...inputStyle, marginBottom: 0 }} placeholder="Email" value={form.email} onChange={(e) => set("email", e.target.value)} />
      </div>
      <input style={{ ...inputStyle, marginTop: 8 }} placeholder="Website" value={form.website} onChange={(e) => set("website", e.target.value)} />
      <textarea
        style={{ ...inputStyle, resize: "vertical", minHeight: 56 }}
        placeholder="Notes"
        value={form.notes}
        onChange={(e) => set("notes", e.target.value)}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={submit}
          disabled={saving || !form.name.trim()}
          style={{
            padding: "8px 18px", background: `linear-gradient(135deg, ${C.orange}, ${C.orangeHi})`,
            border: "none", borderRadius: 7, color: "#fff",
            fontSize: 13, fontWeight: 700, cursor: "pointer",
            fontFamily: "'DM Sans', sans-serif", opacity: form.name.trim() ? 1 : 0.5,
          }}
        >
          {saving ? "Saving…" : initial ? "Save Changes" : "Add"}
        </button>
        <button onClick={onCancel} style={{
          padding: "8px 14px", background: "transparent",
          border: `1px solid ${C.border}`, borderRadius: 7,
          color: C.textSub, fontSize: 13, cursor: "pointer",
          fontFamily: "'DM Sans', sans-serif",
        }}>Cancel</button>
      </div>
    </div>
  );
}

function ContractorSection({ type, label, contractors, onAdd, onEdit, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const list = contractors.filter((c) => c.type === type);

  const handleAdd = async (data) => {
    await onAdd(data);
    setAdding(false);
  };

  const handleEdit = async (data) => {
    await onEdit(editingId, data);
    setEditingId(null);
  };

  return (
    <div style={{ flex: 1, minWidth: 300 }}>
      {/* Section header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 12,
      }}>
        <div>
          <span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{label}</span>
          <span style={{
            marginLeft: 10, fontSize: 11, fontWeight: 700, color: C.blue,
            background: `${C.blue}18`, border: `1px solid ${C.blue}30`,
            borderRadius: 10, padding: "2px 8px",
          }}>
            {list.length}
          </span>
        </div>
        <button
          onClick={() => { setAdding(true); setEditingId(null); }}
          style={{
            padding: "6px 14px",
            background: `${C.orange}18`, border: `1px solid ${C.orange}40`,
            borderRadius: 7, color: C.orange, fontSize: 12,
            fontWeight: 700, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
          }}
        >
          + Add
        </button>
      </div>

      {/* Add form */}
      {adding && (
        <ContractorForm
          type={type}
          onSave={handleAdd}
          onCancel={() => setAdding(false)}
        />
      )}

      {/* List */}
      {list.length === 0 && !adding ? (
        <div style={{
          textAlign: "center", padding: "32px 20px",
          color: C.textMuted, fontSize: 13,
          border: `1px dashed ${C.border}`, borderRadius: 10,
        }}>
          No {label.toLowerCase()} yet. Click + Add to get started.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map((c) => (
            editingId === c.id ? (
              <ContractorForm
                key={c.id}
                initial={c}
                type={type}
                onSave={handleEdit}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <ContractorCard
                key={c.id}
                c={c}
                onEdit={(c) => { setEditingId(c.id); setAdding(false); }}
                onDelete={onDelete}
              />
            )
          ))}
        </div>
      )}
    </div>
  );
}

function ContractorsTab() {
  const [contractors, setContractors] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api("/contractors");
      setContractors(Array.isArray(data) ? data : []);
    } catch (e) { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async (data) => {
    const created = await api("/contractors", { method: "POST", body: JSON.stringify(data) });
    setContractors((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
  };

  const handleEdit = async (id, data) => {
    const updated = await api(`/contractors/${id}`, { method: "PATCH", body: JSON.stringify(data) });
    setContractors((prev) => prev.map((c) => (c.id === id ? updated : c)));
  };

  const handleDelete = async (id) => {
    await api(`/contractors/${id}`, { method: "DELETE" });
    setContractors((prev) => prev.filter((c) => c.id !== id));
  };

  if (loading) {
    return <div style={{ textAlign: "center", padding: 60, color: C.textMuted }}>Loading…</div>;
  }

  return <PermitContractorsSection />;
}


// ─── COMPANY PROFILE TAB ─────────────────────────────────────────────────────

function OrgInfoForm({ org, onSaved }) {
  const [form, setForm] = useState({
    legal_name: org.legal_name || "",
    entity_type: org.entity_type || "",
    address_street: org.address_street || "",
    address_city: org.address_city || "",
    address_state: org.address_state || "SC",
    address_zip: org.address_zip || "",
    phone: org.phone || "",
    fax: org.fax || "",
    email: org.email || "",
    website: org.website || "",
    contractor_license_number: org.contractor_license_number || "",
    license_classifications: (org.license_classifications || []).join(", "),
    insurance_company: org.insurance_company || "",
    insurance_agent_name: org.insurance_agent_name || "",
    insurance_agent_phone: org.insurance_agent_phone || "",
    bonding_company: org.bonding_company || "",
    bonding_agent_name: org.bonding_agent_name || "",
    bonding_agent_phone: org.bonding_agent_phone || "",
    bonding_capacity: org.bonding_capacity || "",
    emr: org.emr || "",
    safety_meeting_frequency: org.safety_meeting_frequency || "",
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    const payload = { ...form, license_classifications: form.license_classifications.split(",").map((s) => s.trim()).filter(Boolean) };
    await api("/profile/org", { method: "PUT", body: JSON.stringify(payload) });
    setSaving(false);
    setMsg("✓ Saved");
    setTimeout(() => setMsg(""), 3000);
    onSaved();
  };

  const inp = { width: "100%", padding: "10px 12px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 14, outline: "none", fontFamily: "'DM Sans', sans-serif", boxSizing: "border-box" };
  const lbl = { fontSize: 12, color: C.textSub, marginBottom: 4, display: "block" };
  const grp = { marginBottom: 14 };
  const g2 = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };
  const g3 = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 };
  const g4 = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 };
  const divider = { borderTop: `1px solid ${C.border}`, marginTop: 4, paddingTop: 14, marginBottom: 14 };
  const sectionLabel = { fontSize: 12, color: C.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 };

  return (
    <div>
      <div style={g2}>
        <div style={grp}><label style={lbl}>Legal Business Name</label><input style={inp} value={form.legal_name} onChange={set("legal_name")} /></div>
        <div style={grp}><label style={lbl}>Entity Type</label><input style={inp} value={form.entity_type} onChange={set("entity_type")} placeholder="Corporation, LLC, etc." /></div>
      </div>
      <div style={grp}><label style={lbl}>Street Address</label><input style={inp} value={form.address_street} onChange={set("address_street")} /></div>
      <div style={g3}>
        <div style={grp}><label style={lbl}>City</label><input style={inp} value={form.address_city} onChange={set("address_city")} /></div>
        <div style={grp}><label style={lbl}>State</label><input style={inp} value={form.address_state} onChange={set("address_state")} /></div>
        <div style={grp}><label style={lbl}>ZIP</label><input style={inp} value={form.address_zip} onChange={set("address_zip")} /></div>
      </div>
      <div style={g2}>
        <div style={grp}><label style={lbl}>Phone</label><input style={inp} value={form.phone} onChange={set("phone")} /></div>
        <div style={grp}><label style={lbl}>Fax</label><input style={inp} value={form.fax} onChange={set("fax")} /></div>
      </div>
      <div style={g2}>
        <div style={grp}><label style={lbl}>Email</label><input style={inp} value={form.email} onChange={set("email")} /></div>
        <div style={grp}><label style={lbl}>Website</label><input style={inp} value={form.website} onChange={set("website")} /></div>
      </div>
      <div style={g2}>
        <div style={grp}><label style={lbl}>SC License Number</label><input style={inp} value={form.contractor_license_number} onChange={set("contractor_license_number")} /></div>
        <div style={grp}><label style={lbl}>Classifications (comma-separated)</label><input style={inp} value={form.license_classifications} onChange={set("license_classifications")} placeholder="General, Mechanical, etc." /></div>
      </div>
      <div style={divider}>
        <div style={sectionLabel}>Insurance</div>
        <div style={g3}>
          <div style={grp}><label style={lbl}>Company</label><input style={inp} value={form.insurance_company} onChange={set("insurance_company")} /></div>
          <div style={grp}><label style={lbl}>Agent Name</label><input style={inp} value={form.insurance_agent_name} onChange={set("insurance_agent_name")} /></div>
          <div style={grp}><label style={lbl}>Agent Phone</label><input style={inp} value={form.insurance_agent_phone} onChange={set("insurance_agent_phone")} /></div>
        </div>
      </div>
      <div style={divider}>
        <div style={sectionLabel}>Bonding</div>
        <div style={g4}>
          <div style={grp}><label style={lbl}>Company</label><input style={inp} value={form.bonding_company} onChange={set("bonding_company")} /></div>
          <div style={grp}><label style={lbl}>Agent Name</label><input style={inp} value={form.bonding_agent_name} onChange={set("bonding_agent_name")} /></div>
          <div style={grp}><label style={lbl}>Agent Phone</label><input style={inp} value={form.bonding_agent_phone} onChange={set("bonding_agent_phone")} /></div>
          <div style={grp}><label style={lbl}>Capacity</label><input style={inp} value={form.bonding_capacity} onChange={set("bonding_capacity")} placeholder="$5,000,000" /></div>
        </div>
      </div>
      <div style={g2}>
        <div style={grp}><label style={lbl}>EMR</label><input style={inp} value={form.emr} onChange={set("emr")} placeholder="0.85" /></div>
        <div style={grp}><label style={lbl}>Safety Meeting Frequency</label><input style={inp} value={form.safety_meeting_frequency} onChange={set("safety_meeting_frequency")} placeholder="Weekly" /></div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
        <button onClick={save} disabled={saving} style={{ padding: "10px 24px", background: C.orange, color: "#000", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>
          {saving ? "Saving…" : "Save"}
        </button>
        {msg && <span style={{ color: C.sky, fontSize: 14 }}>{msg}</span>}
      </div>
    </div>
  );
}

function PrincipalsSection({ org, onChanged }) {
  const blank = { name: "", title: "", other_businesses: "", order: 0 };
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    if (form.id) await api(`/profile/org/principals/${form.id}`, { method: "PATCH", body: JSON.stringify(form) });
    else await api("/profile/org/principals", { method: "POST", body: JSON.stringify(form) });
    setSaving(false); setForm(null); onChanged();
  };

  const del = async (id) => { await api(`/profile/org/principals/${id}`, { method: "DELETE" }); onChanged(); };

  const inp = { width: "100%", padding: "9px 11px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 14, outline: "none", fontFamily: "'DM Sans', sans-serif", boxSizing: "border-box" };
  const lbl = { fontSize: 12, color: C.textSub, marginBottom: 4, display: "block" };
  const btn = (primary) => ({ padding: "8px 20px", background: primary ? C.orange : "none", color: primary ? "#000" : C.textSub, border: primary ? "none" : `1px solid ${C.border}`, borderRadius: 8, fontWeight: primary ? 700 : 400, fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" });

  return (
    <div>
      {!(org.principals || []).length && !form && <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 12 }}>No principals added yet.</div>}
      {(org.principals || []).map((p) => (
        <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: C.bg, borderRadius: 8, marginBottom: 8 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: C.text }}>{p.name || "(no name)"}</div>
            <div style={{ fontSize: 12, color: C.textSub }}>{p.title}</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setForm({ ...p })} style={{ background: "none", border: "none", color: C.textSub, cursor: "pointer", fontSize: 16 }}>✏️</button>
            <button onClick={() => del(p.id)} style={{ background: "none", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 16 }}>🗑️</button>
          </div>
        </div>
      ))}
      {form !== null ? (
        <div style={{ background: C.bg, border: `1px solid ${C.borderHi}`, borderRadius: 8, padding: 16, marginBottom: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div><label style={lbl}>Name</label><input style={inp} value={form.name} onChange={set("name")} /></div>
            <div><label style={lbl}>Title</label><input style={inp} value={form.title} onChange={set("title")} /></div>
          </div>
          <div style={{ marginBottom: 12 }}><label style={lbl}>Other Businesses</label><textarea style={{ ...inp, resize: "vertical", minHeight: 60 }} value={form.other_businesses} onChange={set("other_businesses")} /></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} disabled={saving} style={btn(true)}>{saving ? "Saving…" : form.id ? "Update" : "Add"}</button>
            <button onClick={() => setForm(null)} style={btn(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setForm({ ...blank })} style={{ padding: "8px 16px", background: "none", border: `1px solid ${C.border}`, borderRadius: 8, color: C.sky, cursor: "pointer", fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>+ Add Principal</button>
      )}
    </div>
  );
}

function ProjectRefsSection({ org, onChanged }) {
  const blank = { project_name: "", owner_name: "", owner_contact: "", owner_phone: "", contract_value: "", completion_date: "", scope_of_work: "", description: "", your_role: "", ref_type: "general" };
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    const payload = { ...form, contract_value: form.contract_value ? parseFloat(form.contract_value) : null };
    if (form.id) await api(`/profile/org/projects/${form.id}`, { method: "PATCH", body: JSON.stringify(payload) });
    else await api("/profile/org/projects", { method: "POST", body: JSON.stringify(payload) });
    setSaving(false); setForm(null); onChanged();
  };

  const del = async (id) => { await api(`/profile/org/projects/${id}`, { method: "DELETE" }); onChanged(); };

  const inp = { width: "100%", padding: "9px 11px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 14, outline: "none", fontFamily: "'DM Sans', sans-serif", boxSizing: "border-box" };
  const lbl = { fontSize: 12, color: C.textSub, marginBottom: 4, display: "block" };
  const btn = (primary) => ({ padding: "8px 20px", background: primary ? C.orange : "none", color: primary ? "#000" : C.textSub, border: primary ? "none" : `1px solid ${C.border}`, borderRadius: 8, fontWeight: primary ? 700 : 400, fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" });

  const RefList = ({ type, label }) => {
    const items = (org.project_refs || []).filter((r) => r.ref_type === type);
    return (
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{label}</div>
        {!items.length && <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 8 }}>None added yet.</div>}
        {items.map((r) => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: C.bg, borderRadius: 8, marginBottom: 8 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: C.text }}>{r.project_name || "(no name)"}</div>
              <div style={{ fontSize: 12, color: C.textSub }}>{r.owner_name}{r.contract_value ? ` · $${Number(r.contract_value).toLocaleString()}` : ""}{r.completion_date ? ` · ${r.completion_date}` : ""}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setForm({ ...r, contract_value: r.contract_value || "" })} style={{ background: "none", border: "none", color: C.textSub, cursor: "pointer", fontSize: 16 }}>✏️</button>
              <button onClick={() => del(r.id)} style={{ background: "none", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 16 }}>🗑️</button>
            </div>
          </div>
        ))}
        {!form && <button onClick={() => setForm({ ...blank, ref_type: type })} style={{ padding: "8px 16px", background: "none", border: `1px solid ${C.border}`, borderRadius: 8, color: C.sky, cursor: "pointer", fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>+ Add {type === "state" ? "State" : "General"} Project</button>}
      </div>
    );
  };

  return (
    <div>
      <RefList type="general" label="General Projects" />
      <RefList type="state" label="State Agency Projects" />
      {form !== null && (
        <div style={{ background: C.bg, border: `1px solid ${C.borderHi}`, borderRadius: 8, padding: 16, marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.sky, marginBottom: 12 }}>{form.id ? "Edit" : "Add"} {form.ref_type === "state" ? "State Agency" : "General"} Project</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div><label style={lbl}>Project Name</label><input style={inp} value={form.project_name} onChange={set("project_name")} /></div>
            <div><label style={lbl}>Owner Name</label><input style={inp} value={form.owner_name} onChange={set("owner_name")} /></div>
            <div><label style={lbl}>Owner Contact</label><input style={inp} value={form.owner_contact} onChange={set("owner_contact")} /></div>
            <div><label style={lbl}>Owner Phone</label><input style={inp} value={form.owner_phone} onChange={set("owner_phone")} /></div>
            <div><label style={lbl}>Contract Value ($)</label><input style={inp} type="number" value={form.contract_value} onChange={set("contract_value")} /></div>
            <div><label style={lbl}>Completion Date</label><input style={inp} value={form.completion_date} onChange={set("completion_date")} placeholder="March 2024" /></div>
            <div><label style={lbl}>Your Role</label><input style={inp} value={form.your_role} onChange={set("your_role")} placeholder="GC, Prime, Sub" /></div>
          </div>
          <div style={{ marginBottom: 12 }}><label style={lbl}>Scope of Work</label><textarea style={{ ...inp, resize: "vertical", minHeight: 60 }} value={form.scope_of_work} onChange={set("scope_of_work")} /></div>
          <div style={{ marginBottom: 12 }}><label style={lbl}>Description</label><textarea style={{ ...inp, resize: "vertical", minHeight: 60 }} value={form.description} onChange={set("description")} /></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} disabled={saving} style={btn(true)}>{saving ? "Saving…" : form.id ? "Update" : "Add"}</button>
            <button onClick={() => setForm(null)} style={btn(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function PersonnelSection({ org, onChanged }) {
  const blank = { name: "", role: "pm", resume_summary: "", projects: [] };
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setEditing((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    if (editing.id) await api(`/profile/org/personnel/${editing.id}`, { method: "PATCH", body: JSON.stringify(editing) });
    else await api("/profile/org/personnel", { method: "POST", body: JSON.stringify(editing) });
    setSaving(false); setEditing(null); onChanged();
  };

  const del = async (id) => { await api(`/profile/org/personnel/${id}`, { method: "DELETE" }); onChanged(); };

  const inp = { width: "100%", padding: "9px 11px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 14, outline: "none", fontFamily: "'DM Sans', sans-serif", boxSizing: "border-box" };
  const lbl = { fontSize: 12, color: C.textSub, marginBottom: 4, display: "block" };
  const btn = (primary) => ({ padding: "8px 20px", background: primary ? C.orange : "none", color: primary ? "#000" : C.textSub, border: primary ? "none" : `1px solid ${C.border}`, borderRadius: 8, fontWeight: primary ? 700 : 400, fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" });

  const RoleCard = ({ role, roleLabel }) => {
    const people = (org.personnel || []).filter((p) => p.role === role);
    return (
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: C.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>{roleLabel}</div>
        {!people.length && <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 8 }}>Not added yet.</div>}
        {people.map((p) => (
          <div key={p.id} style={{ background: C.bg, borderRadius: 8, padding: "12px 14px", marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: C.text }}>{p.name || "(no name)"}</div>
                {p.resume_summary && <div style={{ fontSize: 12, color: C.textSub, marginTop: 4, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.resume_summary}</div>}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setEditing({ ...p })} style={{ background: "none", border: "none", color: C.textSub, cursor: "pointer", fontSize: 16 }}>✏️</button>
                <button onClick={() => del(p.id)} style={{ background: "none", border: "none", color: C.textMuted, cursor: "pointer", fontSize: 16 }}>🗑️</button>
              </div>
            </div>
          </div>
        ))}
        {!editing && <button onClick={() => setEditing({ ...blank, role })} style={{ padding: "8px 16px", background: "none", border: `1px solid ${C.border}`, borderRadius: 8, color: C.sky, cursor: "pointer", fontSize: 13, fontFamily: "'DM Sans', sans-serif" }}>+ Add {roleLabel}</button>}
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: editing ? 16 : 0 }}>
        <RoleCard role="pm" roleLabel="Project Manager" />
        <RoleCard role="super" roleLabel="Superintendent" />
      </div>
      {editing !== null && (
        <div style={{ background: C.bg, border: `1px solid ${C.borderHi}`, borderRadius: 8, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.sky, marginBottom: 12 }}>{editing.id ? "Edit" : "Add"} {editing.role === "pm" ? "Project Manager" : "Superintendent"}</div>
          <div style={{ marginBottom: 12 }}><label style={lbl}>Name</label><input style={inp} value={editing.name} onChange={set("name")} /></div>
          <div style={{ marginBottom: 12 }}><label style={lbl}>Resume Summary</label><textarea style={{ ...inp, resize: "vertical", minHeight: 80 }} value={editing.resume_summary} onChange={set("resume_summary")} /></div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} disabled={saving} style={btn(true)}>{saving ? "Saving…" : editing.id ? "Update" : "Add"}</button>
            <button onClick={() => setEditing(null)} style={btn(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SOQSection({ org }) {
  const pms    = (org.personnel || []).filter((p) => p.role === "pm");
  const supers = (org.personnel || []).filter((p) => p.role === "super");
  const genProjects   = (org.project_refs || []).filter((r) => r.ref_type === "general");
  const stateProjects = (org.project_refs || []).filter((r) => r.ref_type === "state");

  const [pmId,      setPmId]      = useState(pms[0]?.id    || "");
  const [superId,   setSuperId]   = useState(supers[0]?.id || "");
  const [genIds,    setGenIds]    = useState([]);
  const [stateIds,  setStateIds]  = useState([]);
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState("");

  const toggleCheck = (list, setList, id, max) => setList((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < max ? [...prev, id] : prev);

  const generate = async () => {
    if (!pmId || !superId) { setErr("Select a Project Manager and Superintendent first."); return; }
    setGenerating(true); setErr("");
    try {
      const token = localStorage.getItem("sitescan_token");
      const res = await fetch(`${API}/profile/soq/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pm_id: Number(pmId), super_id: Number(superId), general_project_ids: genIds, state_project_ids: stateIds }),
      });
      if (!res.ok) { const j = await res.json(); throw new Error(j.detail || "Generation failed"); }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = `SOQ_${(org.legal_name || "Company").replace(/\s+/g, "_")}.docx`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setErr(e.message); }
    setGenerating(false);
  };

  const sel = { padding: "10px 12px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 14, width: "100%", fontFamily: "'DM Sans', sans-serif" };
  const lbl = { fontSize: 12, color: C.textSub, marginBottom: 4, display: "block" };
  const sectionLbl = { fontSize: 12, color: C.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 };

  const CheckList = ({ items, selected, onToggle, max, label }) => (
    <div style={{ marginBottom: 20 }}>
      <div style={sectionLbl}>{label} <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(select up to {max})</span></div>
      {!items.length && <div style={{ color: C.textMuted, fontSize: 13 }}>No project references added yet.</div>}
      {items.map((r) => (
        <label key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: selected.includes(r.id) ? C.surfaceHi : C.bg, borderRadius: 8, marginBottom: 6, cursor: "pointer", border: `1px solid ${selected.includes(r.id) ? C.borderHi : C.border}` }}>
          <input type="checkbox" checked={selected.includes(r.id)} onChange={() => onToggle(r.id)} style={{ accentColor: C.orange }} disabled={!selected.includes(r.id) && selected.length >= max} />
          <div>
            <div style={{ fontSize: 14, color: C.text, fontWeight: 600 }}>{r.project_name || "(no name)"}</div>
            <div style={{ fontSize: 12, color: C.textSub }}>{r.owner_name}{r.contract_value ? ` · $${Number(r.contract_value).toLocaleString()}` : ""}</div>
          </div>
        </label>
      ))}
    </div>
  );

  return (
    <div>
      {(!pms.length || !supers.length) && (
        <div style={{ background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: C.textSub }}>
          Add a Project Manager and Superintendent under Key Personnel before generating.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <div><label style={lbl}>Project Manager</label><select style={sel} value={pmId} onChange={(e) => setPmId(e.target.value)}><option value="">— Select PM —</option>{pms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div><label style={lbl}>Superintendent</label><select style={sel} value={superId} onChange={(e) => setSuperId(e.target.value)}><option value="">— Select Superintendent —</option>{supers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
      </div>
      <CheckList items={genProjects}   selected={genIds}   onToggle={(id) => toggleCheck(genIds,   setGenIds,   id, 3)} max={3} label="General Projects" />
      <CheckList items={stateProjects} selected={stateIds} onToggle={(id) => toggleCheck(stateIds, setStateIds, id, 3)} max={3} label="State Agency Projects" />
      {err && <div style={{ color: "#e05050", fontSize: 13, marginBottom: 12 }}>{err}</div>}
      <button onClick={generate} disabled={generating} style={{ padding: "11px 28px", background: C.orange, color: "#000", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>
        {generating ? "Generating…" : "⬇ Download SOQ .docx"}
      </button>
    </div>
  );
}

function ProfileSection({ id, openSection, onToggle, title, icon, children }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 16, overflow: "hidden" }}>
      <div style={{ padding: "14px 18px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: openSection === id ? `1px solid ${C.border}` : "none" }} onClick={() => onToggle(id)}>
        <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{icon} {title}</span>
        <span style={{ color: C.textMuted, fontSize: 12 }}>{openSection === id ? "▲" : "▼"}</span>
      </div>
      <div style={{ padding: 18, display: openSection === id ? "block" : "none" }}>{children}</div>
    </div>
  );
}

function BidAssistSection() {
  const [rfqText,   setRfqText]   = useState("");
  const [narrative, setNarrative] = useState("");
  const [loading,   setLoading]   = useState(false);
  const [parsing,   setParsing]   = useState(false);
  const [err,       setErr]       = useState("");
  const [copied,    setCopied]    = useState(false);
  const fileRef = useRef(null);

  const uploadPdf = async (fileList) => {
    setParsing(true); setErr("");
    try {
      const token = localStorage.getItem("sitescan_token");
      const form = new FormData();
      Array.from(fileList).forEach((f) => form.append("files", f));
      const res = await fetch(`${API}/profile/bid-assist/parse-pdf`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "PDF parsing failed");
      setRfqText(data.text);
    } catch (e) { setErr(e.message || "PDF parsing failed"); }
    setParsing(false);
  };

  const generate = async () => {
    if (!rfqText.trim()) { setErr("Paste an RFQ or upload a PDF first."); return; }
    setLoading(true); setErr(""); setNarrative("");
    try {
      const data = await api("/profile/bid-assist", {
        method: "POST",
        body: JSON.stringify({ rfq_text: rfqText }),
      });
      if (data.detail) throw new Error(data.detail);
      setNarrative(data.narrative);
    } catch (e) { setErr(e.message || "Generation failed"); }
    setLoading(false);
  };

  const copy = () => {
    navigator.clipboard.writeText(narrative);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const ta  = { padding: "10px 12px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, fontSize: 14, width: "100%", fontFamily: "'DM Sans', sans-serif", boxSizing: "border-box", resize: "vertical" };
  const ghostBtn = (extra) => ({ padding: "9px 18px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", color: C.text, ...extra });

  return (
    <div>
      <div style={{ fontSize: 13, color: C.textSub, marginBottom: 12 }}>
        Paste an RFQ or upload a PDF — Claude will write a tailored bid narrative using your company profile.
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button onClick={() => fileRef.current?.click()} disabled={parsing} style={ghostBtn({ opacity: parsing ? 0.7 : 1 })}>
          {parsing ? "Parsing PDFs…" : "📎 Upload PDF(s)"}
        </button>
        <input ref={fileRef} type="file" accept=".pdf" multiple style={{ display: "none" }}
          onChange={(e) => { if (e.target.files?.length) uploadPdf(e.target.files); e.target.value = ""; }} />
        {rfqText && <button onClick={() => { setRfqText(""); setNarrative(""); }} style={ghostBtn({ color: C.textMuted })}>Clear</button>}
      </div>
      <textarea
        style={{ ...ta, minHeight: 160 }}
        placeholder="Paste RFQ text, project scope, or solicitation description here…"
        value={rfqText}
        onChange={(e) => setRfqText(e.target.value)}
      />
      {err && <div style={{ color: "#e05050", fontSize: 13, margin: "8px 0" }}>{err}</div>}
      <button
        onClick={generate}
        disabled={loading || parsing}
        style={{ marginTop: 12, padding: "11px 28px", background: C.orange, color: "#000", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 15, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", opacity: (loading || parsing) ? 0.7 : 1 }}
      >
        {loading ? "Generating…" : "✨ Generate Narrative"}
      </button>
      {narrative && (
        <div style={{ marginTop: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Generated Narrative</span>
            <button onClick={copy} style={{ padding: "5px 14px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, color: copied ? "#4caf50" : C.textSub, fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>
              {copied ? "✓ Copied" : "Copy"}
            </button>
          </div>
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "16px 18px", fontSize: 14, color: C.text, lineHeight: 1.75, whiteSpace: "pre-wrap" }}>
            {narrative}
          </div>
        </div>
      )}
    </div>
  );
}

function CompanyTab() {
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openSection, setOpenSection] = useState("info");

  const loadOrg = async () => {
    try { const data = await api("/profile/org"); setOrg(data); } catch (e) { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { loadOrg(); }, []);

  if (loading) return <div style={{ textAlign: "center", padding: 60, color: C.textMuted }}>Loading…</div>;
  if (!org || org.detail) return <div style={{ textAlign: "center", padding: 60, color: C.textMuted }}>Could not load company profile. Please refresh.</div>;

  const toggle = (id) => setOpenSection((s) => s === id ? null : id);

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px" }}>
      <ProfileSection id="info"       openSection={openSection} onToggle={toggle} title="Company Info"        icon="🏢"><OrgInfoForm       org={org} onSaved={loadOrg}   /></ProfileSection>
      <ProfileSection id="principals" openSection={openSection} onToggle={toggle} title="Principals"          icon="👤"><PrincipalsSection org={org} onChanged={loadOrg} /></ProfileSection>
      <ProfileSection id="projects"   openSection={openSection} onToggle={toggle} title="Project References"  icon="📋"><ProjectRefsSection org={org} onChanged={loadOrg} /></ProfileSection>
      <ProfileSection id="personnel"  openSection={openSection} onToggle={toggle} title="Key Personnel"       icon="🧑‍💼"><PersonnelSection  org={org} onChanged={loadOrg} /></ProfileSection>
      <ProfileSection id="soq"        openSection={openSection} onToggle={toggle} title="Generate SOQ"        icon="📄"><SOQSection         org={org} /></ProfileSection>
      <ProfileSection id="bid-assist" openSection={openSection} onToggle={toggle} title="Bid Assist"          icon="✨"><BidAssistSection /></ProfileSection>
    </div>
  );
}


// ─── SCAN HISTORY TAB ───────────────────────────────────────────────────────

function HistoryTab({ history, onRefresh }) {
  const hasRunning = history.some((h) => !h.finished_at || h.status === "running");

  // Poll every 15s while any scan is in-progress
  useEffect(() => {
    if (!hasRunning) return;
    const t = setInterval(onRefresh, 15000);
    return () => clearInterval(t);
  }, [hasRunning, onRefresh]);

  if (!history.length) {
    return (
      <div style={{ textAlign: "center", padding: 60, color: "#555" }}>
        No scan history yet. Run your first scan!
      </div>
    );
  }
  return (
    <div style={{ overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        {hasRunning && (
          <span style={{ fontSize: 12, color: "#eab308" }}>⟳ Scan in progress…</span>
        )}
        <button
          onClick={onRefresh}
          style={{ marginLeft: "auto", fontSize: 11, padding: "4px 10px", background: "transparent", border: "1px solid #333", borderRadius: 4, color: "#aaa", cursor: "pointer" }}
        >
          Refresh
        </button>
      </div>
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
                  : "running…"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── PARCEL LAYER ─────────────────────────────────────────────────────────────

function ParcelLayer({ show, onStatus }) {
  const map = useMap();
  const [data, setData] = useState(null);
  const [fetchKey, setFetchKey] = useState(0);
  const abortRef = useRef(null);
  const timerRef = useRef(null);

  const doFetch = useCallback(() => {
    const zoom = map.getZoom();
    if (zoom < 12) {
      setData(null);
      onStatus?.({ zoom, count: 0, loading: false, error: null });
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const b = map.getBounds();
    const params = new URLSearchParams({
      west:  String(b.getWest()),
      south: String(b.getSouth()),
      east:  String(b.getEast()),
      north: String(b.getNorth()),
      limit: "800",
    });

    const token = localStorage.getItem("sitescan_token");
    onStatus?.({ zoom, count: 0, loading: true, error: null });

    fetch(`${API}/projects/map/parcels?${params}`, {
      signal: ctrl.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!ctrl.signal.aborted) {
          if (!d.features) {
            console.error("[Parcels] Unexpected response — no features array:", d);
            onStatus?.({ zoom, count: 0, loading: false, error: "Bad response from parcels API" });
            return;
          }
          setData(d);
          setFetchKey((n) => n + 1);
          onStatus?.({ zoom, count: d.features.length, loading: false, error: null });
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          console.error("[Parcels] Fetch failed:", e);
          onStatus?.({ zoom, count: 0, loading: false, error: e.message });
        }
      });
  }, [map, onStatus]);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(doFetch, 600);
  }, [doFetch]);

  useMapEvents({
    moveend: () => show && schedule(),
    zoomend: () => { if (show) { clearTimeout(timerRef.current); doFetch(); } },
  });

  useEffect(() => {
    if (show) {
      doFetch();
    } else {
      if (abortRef.current) abortRef.current.abort();
      clearTimeout(timerRef.current);
      setData(null);
      onStatus?.({ count: 0, loading: false, zoom: map.getZoom() });
    }
  }, [show]); // eslint-disable-line

  if (!show || !data) return null;

  return (
    <GeoJSON
      key={fetchKey}
      data={data}
      style={(feat) => {
        const score = parcelOppScore(feat.properties);
        const c = parcelColor(score);
        return {
          fillColor: c,
          fillOpacity: 0.55,
          color: "#ffffff",   // white stroke so parcel borders are always visible
          weight: 0.8,
          opacity: 0.5,
        };
      }}
      onEachFeature={(feat, layer) => {
        const p = feat.properties;
        const score = parcelOppScore(p);
        const addr = [p.HOUSE, p.STREET].filter(Boolean).join(" ") || "No address";
        const oppLabel = score >= 80 ? "🔥 High" : score >= 55 ? "📈 Medium" : "✓ Low";
        layer.bindPopup(`
          <div style="font-family:'DM Sans',sans-serif;min-width:230px;font-size:13px">
            <div style="font-weight:700;margin-bottom:3px;color:#111;font-size:14px">${addr}</div>
            <div style="color:#777;font-size:11px;margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">${p.GENUSE || "Unknown use"}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;margin-bottom:12px">
              <div>
                <div style="color:#999;font-size:10px;text-transform:uppercase;letter-spacing:.05em">Land Value</div>
                <strong>$${Number(p.LAND_APPR||0).toLocaleString()}</strong>
              </div>
              <div>
                <div style="color:#999;font-size:10px;text-transform:uppercase;letter-spacing:.05em">Improvements</div>
                <strong>$${Number(p.IMP_APPR||0).toLocaleString()}</strong>
              </div>
              <div>
                <div style="color:#999;font-size:10px;text-transform:uppercase;letter-spacing:.05em">Total Appraisal</div>
                <strong>$${Number(p.APPRVAL||0).toLocaleString()}</strong>
              </div>
              <div>
                <div style="color:#999;font-size:10px;text-transform:uppercase;letter-spacing:.05em">Year Built</div>
                <strong>${p.YRBUILT || "—"}</strong>
              </div>
            </div>
            <div style="background:${parcelColor(score)}20;border:1px solid ${parcelColor(score)}50;border-radius:6px;padding:7px 12px;text-align:center;font-weight:700;color:${parcelColor(score)};font-size:13px;margin-bottom:8px">
              ${oppLabel} Opportunity · ${score}%
            </div>
            <div style="color:#aaa;font-size:10px">Owner: ${p.OWNER || "—"}</div>
            <div style="color:#aaa;font-size:10px">TMS: ${p.TMS || "—"}</div>
          </div>
        `);
      }}
    />
  );
}

// ─── MAP TAB ────────────────────────────────────────────────────────────────

const CHARLESTON_CENTER = [32.7765, -79.9311];

function MapTab({ mapHeight = "calc(100vh - 230px)" }) {
  const [points, setPoints] = useState([]);
  const [mapLoading, setMapLoading] = useState(true);
  const [showParcels, setShowParcels] = useState(false);
  const [parcelStatus, setParcelStatus] = useState({ count: 0, loading: false, zoom: 12 });

  useEffect(() => {
    setMapLoading(true);
    api("/projects/map/points")
      .then((data) => setPoints(Array.isArray(data) ? data : []))
      .finally(() => setMapLoading(false));
  }, []);

  const parcelStatusCb = useCallback((s) => setParcelStatus(s), []);

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        {/* Left: counts */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 13, color: C.textSub }}>
          <span>
            {mapLoading
              ? <span style={{ color: C.textMuted }}>Loading…</span>
              : <><strong style={{ color: C.text }}>{points.length}</strong> projects</>
            }
          </span>
          {showParcels && (
            <span style={{ fontSize: 12, color: C.textSub }}>
              {parcelStatus.loading
                ? "⌛ Loading parcels…"
                : parcelStatus.error
                  ? <span style={{ color: "#ef4444" }}>⚠ Parcel error: {parcelStatus.error}</span>
                  : parcelStatus.zoom < 12
                    ? <span style={{ color: C.textMuted }}>🔍 Zoom in for parcels</span>
                    : <><strong style={{ color: C.text }}>{parcelStatus.count}</strong> parcels in view</>
              }
            </span>
          )}
        </div>

        {/* Right: toggle + legend */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={() => setShowParcels((v) => !v)}
            style={{
              padding: "5px 12px",
              background: showParcels ? `${C.orange}20` : "transparent",
              border: `1px solid ${showParcels ? C.orange : C.border}`,
              borderRadius: 6,
              color: showParcels ? C.orange : C.textSub,
              fontSize: 12, fontWeight: 600, cursor: "pointer",
              fontFamily: "'DM Sans', sans-serif",
              transition: "all 0.15s",
            }}
          >
            🏘️ Parcels {showParcels ? "on" : "off"}
          </button>

          {showParcels ? (
            <div style={{ display: "flex", gap: 10, fontSize: 11, color: C.textSub }}>
              {[
                { label: "Vacant / Underbuilt", color: "#f0a030", shape: "square" },
                { label: "Mixed",               color: "#7ec8e3", shape: "square" },
                { label: "Developed",           color: "#2d6a9f", shape: "square" },
              ].map(({ label, color, shape }) => (
                <span key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: shape === "square" ? 2 : "50%", background: color }} />
                  {label}
                </span>
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", gap: 14, fontSize: 11, color: C.textSub }}>
              {[
                { label: "90%+", color: C.orange },
                { label: "75%+", color: C.blue },
                { label: "60%+", color: C.sky },
                { label: "<60%", color: C.textMuted },
              ].map(({ label, color }) => (
                <span key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%", background: color }} />
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Map */}
      <div style={{ borderRadius: 12, overflow: "hidden", border: `1px solid ${C.border}` }}>
        <MapContainer
          center={CHARLESTON_CENTER}
          zoom={12}
          style={{ height: mapHeight, width: "100%" }}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            maxZoom={19}
          />
          {/* Parcel heat map layer (rendered below project dots) */}
          <ParcelLayer show={showParcels} onStatus={parcelStatusCb} />
          {/* Project dots on top */}
          {points.map((p) => (
            <CircleMarker
              key={p.id}
              center={[p.latitude, p.longitude]}
              radius={9}
              pathOptions={{
                fillColor: matchColor(p.match_score),
                fillOpacity: 0.85,
                color: "#fff",
                weight: 1.5,
                opacity: 0.6,
              }}
            >
              <Popup>
                <div style={{ minWidth: 210, fontFamily: "'DM Sans', sans-serif", fontSize: 13 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4, lineHeight: 1.3, color: "#111" }}>
                    {catIcons[p.category] || "📋"} {p.title}
                  </div>
                  <div style={{ fontSize: 11, color: "#777", marginBottom: 10 }}>
                    📍 {p.location}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    <span style={{
                      background: matchColor(p.match_score),
                      color: "#fff",
                      borderRadius: 10,
                      padding: "2px 9px",
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: "'Space Mono', monospace",
                    }}>
                      {p.match_score}%
                    </span>
                    <span style={{ color: "#c47d10", fontWeight: 700, fontSize: 12 }}>{fmt$(p.value)}</span>
                    <span style={{ fontSize: 10, color: "#888", background: "#f0f0f0", borderRadius: 4, padding: "1px 6px" }}>
                      {p.status}
                    </span>
                  </div>
                  {p.source_url && (
                    <a
                      href={p.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 11, color: "#4a9fd4", textDecoration: "none", fontWeight: 600 }}
                    >
                      View Source →
                    </a>
                  )}
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}

// ─── MAIN APP ───────────────────────────────────────────────────────────────

export default function SiteScanApp() {
  const [authed, setAuthed] = useState(!!localStorage.getItem("sitescan_token"));
  const [tab, setTab] = useState("scanner");
  const [showMap, setShowMap] = useState(false);
  const [projects, setProjects] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalUnfiltered, setTotalUnfiltered] = useState(0);
  const [stats, setStats] = useState(null);
  const [saved, setSaved] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    search: "", category: "", source: "", clientTypes: [], minValue: 100000, categories: [], statuses: [], sortBy: "value", sortDir: "desc", lowcountry: false,
  });
  const [categories, setCategories] = useState([]);
  const [sources, setSources] = useState([]);
  const [dismissedIds, setDismissedIds] = useState(new Set());
  const [valueMedians, setValueMedians] = useState({});
  const debounceRef = useRef(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        sort_by: filters.sortBy,
        sort_dir: filters.sortDir || "desc",
        limit: "1000",
      });
      if (filters.search) params.set("search", filters.search);
      if (filters.category) params.set("categories", filters.category);
      if (filters.source) params.set("sources", filters.source);

      const data = await api(`/projects?${params}`);
      const allProjects = data.projects || [];
      const filtered = allProjects.filter(p => {
        if (!projectMatchesClientTypes(p, filters.clientTypes || [])) return false;
        if ((filters.minValue || 0) > 0 && p.value && p.value < filters.minValue) return false;
        if ((filters.categories || []).length) {
          if (!filters.categories.includes(p.category)) return false;
        } else {
          if (TRADE_CATEGORIES.has(p.category)) return false;
          if (CIVIL_INFRA_RE.test(p.title || "")) return false;
        }
        if ((filters.statuses || []).length && !filters.statuses.includes(p.status)) return false;
        if (filters.lowcountry && !projectInLowcountry(p)) return false;
        return true;
      });
      setProjects(filtered);
      setTotal(filtered.length);
      setTotalUnfiltered(allProjects.length);
      setValueMedians(buildValueMedians(allProjects));

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

  const handleCriteriaChange = () => {
    loadProjects();
    loadStats();
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
    // Pre-populate filters from saved profile preferences
    api("/auth/me").then((data) => {
      setFilters((f) => ({
        ...f,
        clientTypes: data.criteria_client_types?.length ? data.criteria_client_types : f.clientTypes,
        minValue: data.criteria_min_value || f.minValue,
        categories: data.criteria_categories?.length ? data.criteria_categories : f.categories,
        statuses: data.criteria_statuses?.length ? data.criteria_statuses : f.statuses,
      }));
    }).catch(() => {});
  }, [authed]);

  // Poll history every 30s — if the most recent entry has no finished_at, a scan
  // is in progress; reload projects/stats too once it completes.
  const prevRunningRef = useRef(false);
  useEffect(() => {
    if (!authed) return;
    const t = setInterval(async () => {
      const data = await api("/scan/history?limit=30").catch(() => null);
      if (!data) return;
      setHistory(Array.isArray(data) ? data : []);
      const isRunning = data.some((h) => !h.finished_at || h.status === "running");
      if (prevRunningRef.current && !isRunning) {
        // Scan just finished — reload projects and stats
        loadProjects();
        loadStats();
      }
      prevRunningRef.current = isRunning;
    }, 30000);
    return () => clearInterval(t);
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(loadProjects, 300);
    return () => clearTimeout(debounceRef.current);
  }, [filters, authed, loadProjects]);

  if (!authed) return <AuthScreen onAuth={() => setAuthed(true)} />;

  const savedIds = new Set(saved.map((s) => s.project_id));

  // Compute live stats from the currently-loaded (filtered) projects so the
  // stats bar always reflects whatever search / match-filter criteria are active.
  const liveStats = total > 0
    ? {
        total_projects: total,
        total_pipeline_value: projects.reduce((s, p) => s + (p.value || 0), 0),
        new_this_week: projects.filter((p) => {
          const d = new Date(p.posted_date);
          return !isNaN(d) && (Date.now() - d) < 7 * 24 * 60 * 60 * 1000;
        }).length,
        bids_open: projects.filter((p) => ["Open", "Accepting Bids"].includes(p.status)).length,
        last_scan_at: stats?.last_scan_at,
      }
    : stats;

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
        .leaflet-popup-content-wrapper { border-radius: 10px !important; box-shadow: 0 8px 32px rgba(0,0,0,0.4) !important; padding: 0 !important; }
        .leaflet-popup-content { margin: 14px 16px !important; }
        .leaflet-popup-tip-container { margin-top: -1px; }
        .leaflet-container { font-family: 'DM Sans', sans-serif; }
        .leaflet-control-attribution { background: rgba(8,15,26,0.8) !important; color: #3d5a7a !important; }
        .leaflet-control-attribution a { color: #4a9fd4 !important; }
        .leaflet-control-zoom a { background: #0c1524 !important; color: #e8f0fa !important; border-color: #1a2f50 !important; }
        .leaflet-control-zoom a:hover { background: #101d30 !important; }
        /* ── Responsive layout ── */
        .header-wrap { width: 100%; max-width: 1400px; margin: 0 auto; display: flex; align-items: center; gap: 12px; }
        .app-nav { display: flex; gap: 2px; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; -ms-overflow-style: none; flex: 1; }
        .app-nav::-webkit-scrollbar { display: none; }
        .app-nav button { white-space: nowrap; flex-shrink: 0; }
        .app-main { max-width: 1400px; margin: 0 auto; padding: 20px 32px; box-sizing: border-box; width: 100%; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
        @media (max-width: 899px) {
          .header-wrap { flex-wrap: wrap; align-items: center; }
          .header-logo { order: 1; flex-shrink: 0; }
          .header-right { order: 2; margin-left: auto; }
          .app-nav { order: 3; width: 100%; }
          .app-main { padding: 16px; }
          .stats-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 480px) {
          .app-main { padding: 12px; }
          .stats-grid { gap: 8px; }
        }
      `}</style>

      {/* HEADER */}
      <header style={styles.header}>
        <div className="header-wrap">
          <div className="header-logo" style={styles.logo}>
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
          <nav className="app-nav">
            {[
              { id: "scanner",      label: "Scanner",                    icon: "⚡" },
              { id: "map",          label: "Map",                        icon: "🗺️" },
              { id: "saved",        label: `Saved (${saved.length})`,    icon: "★" },
              { id: "contractors",  label: "Contractors",                icon: "🤝" },
              { id: "company",      label: "Profile",                    icon: "🏢" },
              { id: "history",      label: "History",                    icon: "📊" },
              { id: "profile",      label: "Settings",                   icon: "⚙" },
            ].map((t) => (
              <button
                key={t.id}
                style={{ ...styles.navBtn, ...((t.id === "map" ? showMap : tab === t.id) ? styles.navBtnActive : {}) }}
                onClick={() => t.id === "map" ? setShowMap((v) => !v) : setTab(t.id)}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </nav>
          <div className="header-right" style={styles.headerRight}>
            <CitySelector />
            <button style={styles.logoutBtn} onClick={logout}>Sign Out</button>
          </div>
        </div>
      </header>

      {/* MAIN */}
      <main className="app-main">
        {tab === "scanner" && (
          <>
            <StatsBar stats={liveStats} />
            <FilterBar
              filters={filters}
              setFilters={setFilters}
            />
            <div style={styles.resultHeader}>
              <span style={{ color: "#888", fontSize: 13 }}>
                {totalUnfiltered > 0 && total < totalUnfiltered
                  ? <><span style={{ color: C.text, fontWeight: 600 }}>{total}</span> of {totalUnfiltered} projects</>
                  : <>{total} project{total !== 1 ? "s" : ""}</>
                }
                {filters.search && ` matching "${filters.search}"`}
              </span>
              {dismissedIds.size > 0 && (
                <span style={{ color: "#555", fontSize: 13, marginLeft: 12 }}>
                  · {dismissedIds.size} hidden{" "}
                  <button
                    onClick={() => setDismissedIds(new Set())}
                    style={{ background: "none", border: "none", color: C.blue, cursor: "pointer", fontSize: 13, padding: 0, fontFamily: "inherit" }}
                  >
                    Clear
                  </button>
                </span>
              )}
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
                {groupByAddress(projects.filter((p) => !isSubpermit(p) && !dismissedIds.has(p.id))).map((group, i) => (
                  <ProjectCard
                    key={group.address ?? `noaddr-${i}`}
                    group={group}
                    onSave={saveProject}
                    savedIds={savedIds}
                    animDelay={Math.min(i, 25) * 0.03}
                    onDismiss={(id) => setDismissedIds(s => new Set([...s, id]))}
                    valueMedians={valueMedians}
                  />
                ))}
              </div>
            )}
          </>
        )}
        {tab === "saved" && <SavedTab saved={saved} onUnsave={unsaveProject} />}
        {tab === "contractors" && <ContractorsTab />}
        {tab === "company" && <CompanyTab />}
        {tab === "history" && <HistoryTab history={history} onRefresh={loadHistory} />}
        {tab === "profile" && (
          <ProfileTab
            lastScanAt={stats?.last_scan_at}
            onScan={handleScanComplete}
          />
        )}
      </main>

      {/* MAP OVERLAY */}
      {showMap && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 200,
          display: "flex", flexDirection: "column",
          background: C.bg,
        }}>
          {/* Overlay header */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "10px 24px",
            borderBottom: `1px solid ${C.border}`,
            background: C.surface,
            boxShadow: "0 2px 16px rgba(0,0,0,0.3)",
            flexShrink: 0,
          }}>
            <span style={{ color: C.text, fontWeight: 700, fontSize: 15, fontFamily: "'DM Sans', sans-serif" }}>
              🗺️ Project Map — Charleston, SC
            </span>
            <button
              onClick={() => setShowMap(false)}
              style={{
                background: "none", border: `1px solid ${C.border}`,
                color: C.textSub, borderRadius: 6, padding: "5px 14px",
                cursor: "pointer", fontSize: 13, fontFamily: "'DM Sans', sans-serif",
              }}
            >
              ✕ Close
            </button>
          </div>
          {/* Map content */}
          <div style={{ flex: 1, padding: "16px 24px", overflow: "hidden", minHeight: 0 }}>
            <MapTab mapHeight="calc(100vh - 116px)" />
          </div>
        </div>
      )}
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
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: `radial-gradient(ellipse at 50% 40%, #0e2040 0%, ${C.bg} 65%)`,
    padding: "40px 16px",
    boxSizing: "border-box",
    overflowY: "auto",
  },
  authCard: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 16,
    padding: 40,
    width: "100%",
    maxWidth: 380,
    boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
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
    padding: "20px 32px",
    width: "100%",
    boxSizing: "border-box",
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
    borderRadius: 10,
    padding: "18px 22px",
    textAlign: "left",
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
    marginBottom: 8,
    padding: "16px 20px",
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
  criteriaLabel: {
    fontSize: 11,
    color: C.textMuted,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: 10,
    fontWeight: 600,
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
