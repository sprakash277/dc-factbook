import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { ComposableMap, Geographies, Geography, Marker, ZoomableGroup } from "react-simple-maps";
import { geoCentroid } from "d3-geo";
import statesTopo from "us-atlas/states-10m.json";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Cell } from "recharts";
import {
  Warehouse, Search, ArrowLeft, MapPin, Snowflake, Sparkles, Send, Plus, Minus, Locate, Filter,
  Pencil, Upload, X, Building2, Users, Gauge, Ruler, Truck, Factory, DoorOpen, Globe, FileText, LayoutGrid,
  Settings, ChevronDown, CheckCircle2, AlertCircle, SlidersHorizontal, Trash2,
} from "lucide-react";
import brandLogo from "./assets/kroger-logo.png";

const NAVY = "#0b1e3b", GOLD = "#c6a15b";
// Header brand — official Kroger blue
const HEADER_BG = "linear-gradient(135deg,#084999,#063a7a)";
const CENTER0 = [-97, 38.5];
// White pill holding the brand logo so the blue wordmark reads on the blue header
function BrandLogo({ h = 22 }) {
  return (
    <span className="inline-flex items-center rounded-lg bg-white px-2.5 py-1.5 shadow-sm">
      <img src={brandLogo} alt="Kroger" style={{ height: h, width: "auto", display: "block" }} />
    </span>
  );
}
const ABBR = { Alabama:"AL",Alaska:"AK",Arizona:"AZ",Arkansas:"AR",California:"CA",Colorado:"CO",Connecticut:"CT",Delaware:"DE","District of Columbia":"DC",Florida:"FL",Georgia:"GA",Hawaii:"HI",Idaho:"ID",Illinois:"IL",Indiana:"IN",Iowa:"IA",Kansas:"KS",Kentucky:"KY",Louisiana:"LA",Maine:"ME",Maryland:"MD",Massachusetts:"MA",Michigan:"MI",Minnesota:"MN",Mississippi:"MS",Missouri:"MO",Montana:"MT",Nebraska:"NE",Nevada:"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND",Ohio:"OH",Oklahoma:"OK",Oregon:"OR",Pennsylvania:"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD",Tennessee:"TN",Texas:"TX",Utah:"UT",Vermont:"VT",Virginia:"VA",Washington:"WA","West Virginia":"WV",Wisconsin:"WI",Wyoming:"WY" };
const REGIONS = {
  All: null,
  Midwest: ["OH","IN","IL","MI","WI","MN","IA","MO","KS","NE","SD","ND"],
  South: ["TX","OK","AR","LA","MS","AL","TN","KY","GA","FL","SC","NC","VA","WV","MD","DC","DE"],
  West: ["CA","OR","WA","NV","AZ","UT","CO","NM","ID","MT","WY","AK","HI"],
  Northeast: ["NY","NJ","PA","CT","RI","MA","VT","NH","ME"],
};

const readOrThrow = async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || "Request failed.");
  return body;
};
const jsonPost = (url, payload) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then(readOrThrow);

const api = {
  sitesAll: () => fetch("/api/site-data").then(readOrThrow),
  siteDataBatch: (rows) => jsonPost("/api/site-data/batch", { rows }),
  adminUsers: () => fetch("/api/admin/users").then(readOrThrow),
  adminConfig: () => fetch("/api/admin/config").then(readOrThrow),
  adminAssign: (email, is_site_admin) => jsonPost("/api/admin/users", { email, is_site_admin }),
  sites: () => fetch("/api/sites").then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.detail || "Could not load sites.");
    return body;
  }),
  detail: (id) => fetch("/api/sites/" + encodeURIComponent(id)).then((r) => (r.ok ? r.json() : null)),
  edit: (id, fields) => fetch("/api/sites/" + encodeURIComponent(id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields, editor: "app-user" }) }),
  ask: (question) => fetch("/api/genie/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) }).then((r) => r.json()),
  me: () => fetch("/api/me").then((r) => (r.ok ? r.json() : null)),
  config: () => fetch("/api/config").then((r) => (r.ok ? r.json() : null)),
  uploadParse: (file) => { const fd = new FormData(); fd.append("file", file); return fetch("/api/upload/parse", { method: "POST", body: fd }); },
  uploadCommit: (rows, create_if_missing) => fetch("/api/upload/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows, create_if_missing }) }),
};

// Shared identity — fetched once, cached across components. can_edit gates the write UI.
let _meCache = null, _mePromise = null;
function useMe() {
  const [me, setMe] = useState(_meCache);
  useEffect(() => {
    if (_meCache) { setMe(_meCache); return; }
    if (!_mePromise) _mePromise = api.me().then((m) => (_meCache = m || {})).catch(() => (_meCache = { name: "Signed-in user", authenticated: false, can_edit: false }));
    _mePromise.then(setMe);
  }, []);
  return me;
}

// Branding — fetched once, cached. Any account rebrands via APP_TITLE / APP_SUBTITLE env.
const DEFAULT_CONFIG = { title: "DC Fact Book", subtitle: "Distribution Network Directory" };
let _cfgCache = null, _cfgPromise = null;
function useConfig() {
  const [cfg, setCfg] = useState(_cfgCache || DEFAULT_CONFIG);
  useEffect(() => {
    if (_cfgCache) { setCfg(_cfgCache); return; }
    if (!_cfgPromise) _cfgPromise = api.config().then((c) => (_cfgCache = { ...DEFAULT_CONFIG, ...(c || {}) })).catch(() => (_cfgCache = DEFAULT_CONFIG));
    _cfgPromise.then(setCfg);
  }, []);
  return cfg;
}
const has = (v) => !(v === null || v === undefined || v === "");
const show = (v) => (has(v) ? v : "—");
const fmtN = (n) => (has(n) ? Number(n).toLocaleString() : "—");
const sqft = (n) => (has(n) ? Number(n).toLocaleString() + " sq ft" : "—");
const hexLerp = (a, b, t) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [ar, ag, ab] = p(a), [br, bg, bb] = p(b);
  const c = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
};

function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const navigate = useCallback((to) => {
    if (to === window.location.pathname) return;
    window.history.pushState({}, "", to); setPath(to); window.scrollTo(0, 0);
  }, []);
  return [path, navigate];
}
const navClick = (navigate, to) => (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
  e.preventDefault(); navigate(to);
};

function Fact({ label, value }) {
  return (
    <div className="rounded-xl border border-line bg-white p-3.5">
      <div className="text-[10px] font-bold uppercase tracking-[0.07em] text-muted">{label}</div>
      <div className="mt-1 text-[14px] font-semibold text-ink">{value}</div>
    </div>
  );
}

export default function App() {
  const [path, navigate] = useRoute();
  if (path === "/settings") return <SettingsPage navigate={navigate} />;
  const m = path.match(/^\/site\/(.+)$/);
  const siteId = m ? decodeURIComponent(m[1]) : null;
  return siteId ? <SiteDetailPage siteId={siteId} navigate={navigate} /> : <Landing navigate={navigate} />;
}

/* ============================ LANDING ============================ */
const FACET_DEFS = [
  { key: "state", label: "State" },
  { key: "area", label: "Area" },
  { key: "region", label: "Region" },
  { key: "automation_vendor", label: "Automation vs manual" },
  { key: "whs_union", label: "Warehouse union" },
  { key: "products", label: "Products" },
  { key: "divisions_serviced", label: "Divisions serviced" },
  { key: "function_local_regional", label: "Function" },
];

function DcMapPage({ navigate }) {
  const [sites, setSites] = useState([]);
  const [q, setQ] = useState("");
  const [siteSel, setSiteSel] = useState("all");
  const [sel, setSel] = useState({}); // facetKey -> Set(values)
  const [view, setView] = useState({ center: CENTER0, zoom: 1 });
  const [tip, setTip] = useState(null);
  const [hoverSt, setHoverSt] = useState(null);
  const wrapRef = useRef(null);

  const [loadState, setLoadState] = useState({ loaded: false, error: null });
  useEffect(() => {
    api.sites()
      .then((rows) => { setSites(Array.isArray(rows) ? rows : []); setLoadState({ loaded: true, error: null }); })
      .catch((e) => { setSites([]); setLoadState({ loaded: true, error: e.message || "Could not load sites." }); });
  }, []);

  const to = (s) => `/site/${encodeURIComponent(s.site_id)}`;

  // Show every facet (even empty ones); values populate from the data as it lands.
  const facets = useMemo(() => FACET_DEFS.map((f) => {
    const vals = [...new Set(sites.map((s) => s[f.key]).filter((v) => has(v)).map(String))].sort((a, b) => a.localeCompare(b));
    return { ...f, values: vals };
  }), [sites]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return sites.filter((s) => {
      if (siteSel !== "all" && s.site_id !== siteSel) return false;
      if (t && ![s.name, s.city, s.state].some((x) => (x || "").toLowerCase().includes(t))) return false;
      for (const f of facets) {
        const chosen = sel[f.key];
        if (chosen && chosen.size && !chosen.has(String(s[f.key]))) return false;
      }
      return true;
    });
  }, [sites, q, siteSel, sel, facets]);

  const kpi = useMemo(() => ({
    total: filtered.length,
    tot_sqft: filtered.reduce((a, s) => a + (Number(s.total_sqft) || 0), 0),
    exp: filtered.filter((s) => has(s.expansion_space)).length,
    states: new Set(filtered.map((s) => s.state).filter(Boolean)).size,
  }), [filtered]);

  // choropleth + markers driven by the filtered set
  const byState = useMemo(() => {
    const mm = {};
    filtered.forEach((s) => { if (s.state) { mm[s.state] = mm[s.state] || { count: 0, sqft: 0 }; mm[s.state].count++; mm[s.state].sqft += Number(s.total_sqft) || 0; } });
    return mm;
  }, [filtered]);
  const maxCount = useMemo(() => Math.max(1, ...Object.values(byState).map((v) => v.count)), [byState]);
  const maxSqft = useMemo(() => Math.max(1, ...sites.map((s) => Number(s.total_sqft) || 0)), [sites]);
  const shade = (st) => { const c = byState[st]?.count || 0; return c ? hexLerp("#dbe4ef", "#12305a", maxCount === 1 ? 1 : (c - 1) / (maxCount - 1)) : "#eef2f7"; };
  const rOf = (s) => 4 + Math.sqrt((Number(s.total_sqft) || 0) / maxSqft) * 5;
  const mapped = useMemo(() => filtered.filter((s) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)) && (s.lat || s.lon)), [filtered]);
  const selState = sel.state;

  const trackTip = (e) => {
    if (!tip || !wrapRef.current) return;
    const b = wrapRef.current.getBoundingClientRect();
    setTip((t) => (t ? { ...t, x: e.clientX - b.left, y: e.clientY - b.top } : t));
  };
  const clickState = (st, g) => {
    if (!st) return;
    const willSelect = !(selState && selState.has(st));
    toggle("state", st);
    const c = geoCentroid(g);
    setView(willSelect && Number.isFinite(c[0]) ? { center: c, zoom: 3.2 } : { center: CENTER0, zoom: 1 });
  };
  const resetMap = () => { setView({ center: CENTER0, zoom: 1 }); };
  const zoomBy = (f) => setView((v) => ({ ...v, zoom: Math.min(8, Math.max(1, v.zoom * f)) }));

  const toggle = (k, v) => setSel((p) => { const s = new Set(p[k] || []); s.has(v) ? s.delete(v) : s.add(v); return { ...p, [k]: s }; });
  const clearFacet = (k) => setSel((p) => ({ ...p, [k]: new Set() }));
  const activeCount = Object.values(sel).reduce((a, s) => a + (s ? s.size : 0), 0) + (siteSel !== "all" ? 1 : 0) + (q ? 1 : 0);
  const resetAll = () => { setSel({}); setSiteSel("all"); setQ(""); setView({ center: CENTER0, zoom: 1 }); };

  return (
    <div className="slide-in">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Sites", fmtN(kpi.total), "Number of distribution centers in the current filter."],
          ["Total footprint", kpi.tot_sqft ? fmtN(kpi.tot_sqft) + " sq ft" : "—", "Sum of building square footage across the filtered DCs."],
          ["Expansion-ready", fmtN(kpi.exp), "DCs flagged with land or capacity available to expand."],
          ["States covered", fmtN(kpi.states), "Distinct US states with at least one DC."],
        ].map(([l, v, help]) => (
          <div key={l} title={help} className="rounded-xl border border-line bg-white p-4 shadow-soft">
            <div className="text-[10px] font-bold uppercase tracking-[0.09em] text-muted">{l}</div>
            <div className="mt-1 text-2xl font-bold tracking-tight text-ink">{v}</div>
          </div>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        {/* MAP (SVG choropleth + navy bubbles) */}
        <div className="flex flex-col rounded-2xl border border-line bg-white p-3 shadow-soft lg:h-[80vh]">
          <div className="mb-1 flex flex-wrap items-center gap-3 px-1 pt-1">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-ink"><span className="h-2.5 w-2.5 rounded-full" style={{ background: NAVY }} />Distribution Center</span>
            <div className="ml-auto flex items-center gap-2 text-[10px] font-semibold text-muted">
              <span>sites / state</span>
              <span className="inline-flex h-2.5 w-24 rounded-full" style={{ background: "linear-gradient(90deg,#eef2f7,#dbe4ef,#12305a)" }} />
              <span>{maxCount}</span>
            </div>
          </div>
          {(activeCount > 0 || view.zoom > 1) && (
            <div className="mb-1 flex items-center gap-2 px-1 text-[11px] text-muted">
              <span>{filtered.length} of {sites.length} sites</span>
              <button onClick={resetMap} className="ml-auto inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 font-semibold hover:bg-canvas"><Locate size={11} /> Reset view</button>
            </div>
          )}
          {loadState.error && (
            <div role="alert" className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
              <div className="font-bold">No site data to show</div>
              <div className="mt-0.5">{loadState.error}</div>
            </div>
          )}
          {loadState.loaded && !loadState.error && sites.length === 0 && (
            <div className="mb-2 rounded-lg border border-line bg-white px-3 py-2 text-[12px] text-muted">
              No sites have been loaded yet.
            </div>
          )}
          <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden rounded-xl" style={{ background: "#eef2f7" }}
               onMouseMove={trackTip} onMouseLeave={() => setTip(null)}>
            <ComposableMap projection="geoAlbersUsa" projectionConfig={{ scale: 1010 }} width={800} height={560}
                           style={{ width: "100%", height: "100%", display: "block" }}>
              <defs>
                <filter id="landShadow" x="-8%" y="-8%" width="116%" height="124%">
                  <feDropShadow dx="0" dy="2" stdDeviation="3.5" floodColor="#0b1e3b" floodOpacity="0.12" />
                </filter>
              </defs>
              <rect x={0} y={0} width={800} height={560} fill="#eef2f7" />
              <ZoomableGroup center={view.center} zoom={view.zoom} minZoom={1} maxZoom={8}
                             filterZoomEvent={(e) => !(e && e.target && e.target.closest && e.target.closest("[data-site-marker]"))}
                             onMoveEnd={(pos) => setView((v) => ({ ...v, center: pos.coordinates, zoom: pos.zoom }))}>
                <g filter="url(#landShadow)">
                  <Geographies geography={statesTopo}>
                    {({ geographies }) => geographies.map((g2) => {
                      const st = ABBR[g2.properties.name];
                      const active = !!(selState && selState.has(st)), hovered = hoverSt === st;
                      const base = shade(st);
                      const fill = active ? hexLerp(base, "#0b1e3b", 0.4) : hovered ? hexLerp(base, "#0b1e3b", 0.22) : base;
                      return (
                        <Geography key={g2.rsmKey} geography={g2} className="geo-tr" fill={fill}
                          stroke={active || hovered ? "#0b1e3b" : "#b7c1cf"} strokeWidth={active ? 1.3 : hovered ? 1.0 : 0.7} strokeLinejoin="round"
                          onMouseEnter={() => { setHoverSt(st); setTip({ kind: "state", st, name: g2.properties.name, roll: byState[st], x: 0, y: 0 }); }}
                          onMouseLeave={() => { setHoverSt(null); setTip(null); }}
                          onClick={() => clickState(st, g2)}
                          style={{ default: { outline: "none", cursor: "pointer" }, hover: { outline: "none", cursor: "pointer" }, pressed: { outline: "none" } }} />
                      );
                    })}
                  </Geographies>
                </g>
                <Geographies geography={statesTopo}>
                  {({ geographies }) => geographies.map((g2) => {
                    const st = ABBR[g2.properties.name]; const c = geoCentroid(g2);
                    if (!st || !Number.isFinite(c[0])) return null;
                    const hasS = !!byState[st];
                    return (
                      <Marker key={"lbl-" + g2.rsmKey} coordinates={c}>
                        <text textAnchor="middle" dy={3} style={{ pointerEvents: "none", fontFamily: "Inter, sans-serif", fontSize: hasS ? 9 : 8, fontWeight: 700, fill: hasS ? "#0b1e3b" : "#7c8aa0", opacity: hasS ? 0.85 : 0.55, paintOrder: "stroke", stroke: "#ffffff", strokeWidth: 2.2 }}>{st}</text>
                      </Marker>
                    );
                  })}
                </Geographies>
                {mapped.map((s) => {
                  const r = rOf(s) / Math.sqrt(view.zoom);
                  return (
                    <Marker key={s.site_id} coordinates={[Number(s.lon), Number(s.lat)]}
                            onMouseEnter={() => setTip({ kind: "site", s, x: 0, y: 0 })} onMouseLeave={() => setTip(null)}>
                      <a href={to(s)} onClick={navClick(navigate, to(s))} style={{ cursor: "pointer" }}>
                        <g className="marker-enter">
                          <circle r={r + 3} fill={NAVY} opacity={0.16} />
                          <circle className="mk-dot" r={r} fill={NAVY} stroke="#fff" strokeWidth={1.4} />
                          {/* Enlarged transparent tap target so fingers hit it on mobile; data-site-marker
                              tells ZoomableGroup's filterZoomEvent to let the tap through d3-zoom instead
                              of swallowing it as a pan. onTouchEnd handles touch where onClick doesn't fire. */}
                          <circle data-site-marker r={Math.max(r + 12, 18)} fill="transparent" style={{ cursor: "pointer" }}
                                  onClick={navClick(navigate, to(s))}
                                  onTouchEnd={navClick(navigate, to(s))} />
                        </g>
                      </a>
                    </Marker>
                  );
                })}
              </ZoomableGroup>
            </ComposableMap>
            <div className="absolute right-3 top-3 flex flex-col gap-1">
              {[[Plus, () => zoomBy(1.5)], [Minus, () => zoomBy(1 / 1.5)], [Locate, resetMap]].map(([Ic, fn], i) => (
                <button key={i} onClick={fn} className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-white/90 text-ink shadow-soft backdrop-blur hover:bg-white"><Ic size={14} /></button>
              ))}
            </div>
            {tip && (tip.kind === "site" || tip.roll) && (
              <div className="tip-card pointer-events-none absolute z-10 w-56 rounded-xl border border-line bg-white p-3 shadow-soft"
                   style={{ left: Math.min(tip.x + 14, 560), top: Math.max(tip.y - 10, 6) }}>
                {tip.kind === "site" ? (
                  <>
                    <div className="text-[13px] font-bold text-ink">{tip.s.name}</div>
                    <div className="text-[11px] text-muted">{tip.s.city}, {tip.s.state}</div>
                    <div className="mt-1.5 flex justify-between text-[11px]"><span className="text-muted">Total</span><span className="font-semibold text-ink">{sqft(tip.s.total_sqft)}</span></div>
                    <div className="mt-0.5 flex justify-between gap-2 text-[11px]"><span className="text-muted">Expansion</span><span className="truncate text-right font-semibold text-gold-deep">{show(tip.s.expansion_space)}</span></div>
                    <div className="mt-1 text-[10px] text-muted">Click to open site page</div>
                  </>
                ) : (
                  <>
                    <div className="text-[13px] font-bold text-ink">{tip.name}</div>
                    <div className="mt-1 flex justify-between text-[11px]"><span className="text-muted">Sites</span><span className="font-semibold text-ink">{tip.roll.count}</span></div>
                    <div className="mt-0.5 flex justify-between text-[11px]"><span className="text-muted">Footprint</span><span className="font-semibold text-ink">{tip.roll.sqft ? sqft(tip.roll.sqft) : "—"}</span></div>
                    <div className="mt-1 text-[10px] text-muted">Click to filter & zoom</div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* FILTER RAIL */}
        <div className="flex max-h-[80vh] flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-soft lg:h-[80vh]">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Filter size={15} className="text-gold-deep" />
            <span className="text-[13px] font-semibold text-ink">Filters</span>
            {activeCount > 0 && (
              <button onClick={resetAll} className="ml-auto inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] font-semibold text-muted hover:bg-canvas">
                <X size={11} /> Clear ({activeCount})
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {/* Search */}
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search site, city, state…"
                     className="w-full rounded-lg border border-line py-2 pl-9 pr-3 text-[13px] focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/20" />
            </div>
            {/* Site filter */}
            <div>
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-muted">Site filter</div>
              <select value={siteSel} onChange={(e) => setSiteSel(e.target.value)}
                      className="w-full rounded-lg border border-line px-3 py-2 text-[13px] focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/20">
                <option value="all">All sites</option>
                {[...sites].sort((a, b) => (a.name || "").localeCompare(b.name || "")).map((s) => (
                  <option key={s.site_id} value={s.site_id}>{s.name}</option>
                ))}
              </select>
            </div>

            {facets.map((f) => {
              const chosen = sel[f.key] || new Set();
              const empty = f.values.length === 0;
              return (
                <div key={f.key} className="border-t border-line pt-3">
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-muted">{f.label}</div>
                  <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[12px] font-semibold text-ink hover:bg-canvas">
                      <input type="checkbox" checked={chosen.size === 0} onChange={() => clearFacet(f.key)}
                             className="h-3.5 w-3.5 rounded border-line accent-gold-deep" />
                      <span>Select all</span>
                    </label>
                    {f.values.map((v) => (
                      <label key={v} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[12px] text-ink hover:bg-canvas">
                        <input type="checkbox" checked={chosen.has(v)} onChange={() => toggle(f.key, v)}
                               className="h-3.5 w-3.5 rounded border-line accent-gold-deep" />
                        <span className="truncate">{v}</span>
                      </label>
                    ))}
                    {empty && <div className="px-1.5 py-1 text-[11px] italic text-muted/70">No values yet — fills in when this column is populated.</div>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="border-t border-line px-4 py-2.5 text-[11px] font-semibold text-muted">
            {filtered.length} of {sites.length} sites shown
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================ SHELL (Pages nav) ============================ */
const EXPANSION_Q = "Which locations are best suited for expansion?";
const GENIE_STARTERS = [
  EXPANSION_Q,
  "Which DCs are automated vs manual?",
  "What is the total footprint by region?",
  "Which sites are union-operated?",
  "How many DCs do we have per state?",
];

// Landing-level conversational agent over the whole network (Genie).
function GenieAgentPage() {
  const [ask, setAsk] = useState({ q: EXPANSION_Q, loading: false, res: null });
  const runAsk = (question) => {
    if (!question || !question.trim()) return;
    setAsk({ q: question, loading: true, res: null });
    api.ask(question).then((r) => setAsk((a) => ({ ...a, loading: false, res: r })))
      .catch(() => setAsk((a) => ({ ...a, loading: false, res: { answer: "Genie is not available in this workspace yet." } })));
  };
  return (
    <div className="slide-in">
      <div className="mb-4">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-gold-deep"><Sparkles size={13} /> AI · Genie Agent</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">Genie Agent</h1>
        <p className="mt-1 text-[13px] text-muted">Ask the distribution network in plain English — Genie writes the SQL and answers from the live site data.</p>
      </div>
      <SectionCard icon={Sparkles} title="Ask the network">
        <div className="flex gap-2">
          <input id="geniebox" defaultValue={EXPANSION_Q}
                 className="min-w-0 flex-1 rounded-lg border border-line px-3 py-2 text-[13px] focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/20"
                 onKeyDown={(e) => { if (e.key === "Enter") runAsk(e.currentTarget.value); }} />
          <button onClick={() => runAsk(document.getElementById("geniebox").value)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-navy px-4 py-2 text-[13px] font-semibold text-white hover:brightness-110"><Send size={14} /> Ask</button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {GENIE_STARTERS.map((c) => (
            <button key={c} onClick={() => { const el = document.getElementById("geniebox"); if (el) el.value = c; runAsk(c); }}
                    className="rounded-full bg-canvas px-2.5 py-1 text-[11px] text-muted hover:text-ink">{c}</button>
          ))}
        </div>
        {ask.loading && <div className="mt-3 text-[13px] text-muted">Genie is thinking…</div>}
        {ask.res && (
          <div className="mt-3 space-y-2">
            {ask.res.answer && <div className="whitespace-pre-wrap text-[13px] leading-6 text-ink">{ask.res.answer}</div>}
            {ask.res.sql && <pre className="overflow-x-auto rounded-lg bg-navy p-3 text-[11px] text-[#e9d8a6]">{ask.res.sql}</pre>}
            {ask.res.columns?.length > 0 && (
              <div className="overflow-x-auto"><table className="w-full text-[12px]">
                <thead><tr>{ask.res.columns.map((c) => <th key={c} className="border-b border-line px-2 py-1 text-left text-[10px] uppercase tracking-wide text-muted">{c}</th>)}</tr></thead>
                <tbody>{ask.res.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j} className="border-b border-line px-2 py-1">{cell == null ? "—" : String(cell)}</td>)}</tr>)}</tbody>
              </table></div>
            )}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

const PAGES = [
  { key: "dc-map", title: "DC Map Summary", icon: MapPin },
  { key: "reports", title: "Reports & Dashboards", icon: LayoutGrid },
  { key: "scenario", title: "Scenario Modeling", icon: SlidersHorizontal },
  { key: "genie", title: "Genie Agent", icon: Sparkles },
];
// pages still awaiting connected source data (badge shown)
const SOON_PAGES = new Set(["reports", "scenario"]);

function Landing({ navigate }) {
  const cfg = useConfig();
  const [page, setPage] = useState("dc-map");
  const cur = PAGES.find((p) => p.key === page) || PAGES[0];
  return (
    <div className="min-h-full">
      <header className="flex flex-wrap items-center gap-4 px-6 py-3.5 text-white shadow-soft"
              style={{ background: HEADER_BG, borderBottom: "1px solid rgba(198,161,91,.5)" }}>
        <BrandLogo h={26} />
        <div className="border-l border-white/25 pl-4">
          <div className="text-[17px] font-semibold leading-tight">{cfg.title}</div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-white/80">{cfg.subtitle}</div>
        </div>
        <div className="ml-auto"><UserMenu navigate={navigate} /></div>
      </header>

      <div className="flex flex-col gap-5 px-6 py-5 lg:flex-row">
        {/* Pages sidebar — same tile style as the DC detail left-rail */}
        <nav className="flex gap-2 overflow-x-auto pb-1 lg:w-56 lg:flex-none lg:flex-col lg:overflow-visible lg:pb-0">
          <div className="hidden px-1 pb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-muted lg:block">Pages</div>
          {PAGES.map((p) => {
            const active = page === p.key;
            return (
              <button key={p.key} onClick={() => setPage(p.key)} title={p.title}
                      className={"flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] font-semibold whitespace-nowrap transition lg:w-full "
                        + (active ? "text-navy shadow-soft" : "text-ink hover:bg-canvas")}
                      style={active ? { background: GOLD } : {}}>
                <p.icon size={15} className={active ? "text-navy" : "text-gold-deep"} />
                <span className="flex-1">{p.title}</span>
                {SOON_PAGES.has(p.key) && <span className={"text-[9.5px] font-semibold uppercase tracking-wide " + (active ? "text-navy/60" : "text-muted/70")}>soon</span>}
              </button>
            );
          })}
        </nav>

        {/* page content */}
        <main className="min-w-0 flex-1">
          {page === "dc-map" ? <DcMapPage navigate={navigate} />
           : page === "genie" ? <GenieAgentPage />
           : (
            <div className="slide-in">
              <div className="mb-4">
                <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-gold-deep"><cur.icon size={13} /> Report page</div>
                <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">{cur.title}</h1>
              </div>
              <SectionCard icon={cur.icon} title={cur.title}>
                <div className="flex items-center gap-2 rounded-lg border border-dashed border-line bg-canvas px-3 py-3 text-[13px] text-muted">
                  <cur.icon size={14} className="text-gold-deep" /> This report page will surface {cur.title} once its source data is connected in Unity Catalog.
                </div>
              </SectionCard>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/* ============================ DETAIL PAGE ============================ */
const GROUPS = [
  { key: "location", title: "Location", icon: MapPin, fields: [["Street address", "street_address"], ["City", "city"], ["State", "state"], ["ZIP", "zip"], ["Region", "region"], ["Products", "products"], ["Divisions serviced", "divisions_serviced"]] },
  { key: "leadership", title: "Leadership", icon: Users, fields: [["SC&E owner", "sce_owner"], ["Vice president", "vice_president"], ["Regional director", "regional_director"], ["Site leader(s)", "site_leaders"], ["Transportation managers", "transportation_managers"]] },
  { key: "site", title: "Site", icon: Ruler, fields: [["Total acreage", "total_acreage", 1], ["Expansion space", "expansion_space"], ["Lease vs own", "lease_vs_own"]] },
  { key: "tempzone", title: "Temperature-zone sq ft", icon: Snowflake, fields: [["Frozen", "frozen_sqft", 1], ["Refrigerated", "refrigerated_sqft", 1], ["Ambient", "ambient_sqft", 1], ["CIW / FDIC / GM", "ciw_fdic_gm_sqft", 1], ["Total sq ft", "total_sqft", 1]] },
  { key: "dock", title: "Dock doors", icon: DoorOpen, fields: [["Ambient", "dock_doors_ambient", 1], ["Perishable", "dock_doors_perishable", 1], ["Frozen", "dock_doors_frozen", 1]] },
  { key: "automation", title: "Automation & labor", icon: Factory, fields: [["Automation vendor", "automation_vendor"], ["WHS union", "whs_union"], ["WHS operation", "whs_operation"], ["Transportation union", "trans_union"], ["Transportation", "transportation"], ["Transportation operator", "transportation_operator"]] },
  { key: "fleet", title: "Fleet & parking", icon: Truck, fields: [["Tractors", "tractor_total", 1], ["Trailers", "trailer_total", 1], ["Associates", "associate_total", 1], ["Banana rooms", "banana_room_count", 1], ["Fuel lanes", "fuel_lanes", 1], ["VMF bays", "vmf_bays", 1]] },
  { key: "building", title: "Building", icon: Building2, fields: [["Open (year)", "building_open_year"], ["Function", "function_local_regional"], ["Stores serviced", "total_stores_serviced", 1]] },
];
const LINKS = [["Site plan", "site_plan_url"], ["Building plan", "building_plan_url"], ["Building plan w/ temp zone", "building_plan_temp_zone_url"], ["Aerial photo", "aerial_photo_url"], ["Files", "link_to_files2_url"]];

function SectionCard({ icon: Icon, title, children }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5 shadow-soft">
      <div className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">{Icon && <Icon size={14} className="text-gold-deep" />} {title}</div>
      {children}
    </div>
  );
}

function SiteDetailPage({ siteId, navigate }) {
  const me = useMe();
  const cfg = useConfig();
  const canEdit = !!me?.can_edit;
  const [s, setS] = useState(undefined);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState("overview");
  const [ask, setAsk] = useState({ q: "", loading: false, res: null });
  const load = useCallback(() => { api.detail(siteId).then(setS).catch(() => setS(null)); }, [siteId]);
  useEffect(() => { setS(undefined); setAsk({ q: "", loading: false, res: null }); load(); }, [siteId, load]);

  const runAsk = useCallback((question) => {
    setAsk((a) => ({ ...a, q: question, loading: true, res: null }));
    api.ask(question).then((r) => setAsk((a) => ({ ...a, loading: false, res: r })))
      .catch(() => setAsk((a) => ({ ...a, loading: false, res: { answer: "Genie is not available in this workspace yet." } })));
  }, []);

  const Head = (
    <header className="flex items-center gap-4 px-6 py-3.5 text-white shadow-soft"
            style={{ background: HEADER_BG, borderBottom: "1px solid rgba(198,161,91,.5)" }}>
      <a href="/" onClick={navClick(navigate, "/")} className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-xs font-semibold hover:bg-white/20"><ArrowLeft size={14} /> Back to map</a>
      <BrandLogo h={22} />
      <span className="border-l border-white/25 pl-3 text-sm font-semibold text-white/90">{cfg.title}</span>
      <div className="ml-auto"><UserMenu navigate={navigate} /></div>
    </header>
  );
  if (s === undefined) return <div className="min-h-full">{Head}<div className="p-16 text-center text-sm text-muted">Loading site…</div></div>;
  if (s === null) return <div className="min-h-full">{Head}<div className="p-16 text-center text-sm text-muted">Site “{siteId}” not found. <a href="/" onClick={navClick(navigate, "/")} className="font-semibold text-gold-deep underline">Back to map</a></div></div>;

  const fval = (key, isNum) => (isNum ? fmtN(s[key]) : show(s[key]));
  const zoneData = [
    { z: "Frozen", v: Number(s.frozen_sqft) || 0 },
    { z: "Refrigerated", v: Number(s.refrigerated_sqft) || 0 },
    { z: "Ambient", v: Number(s.ambient_sqft) || 0 },
    { z: "CIW/FDIC/GM", v: Number(s.ciw_fdic_gm_sqft) || 0 },
  ];
  const zoneColors = ["#12305a", "#2a6f7f", "#7fbfd0", "#c6a15b"];
  const zoneEmpty = zoneData.every((d) => !d.v);
  const activeLinks = LINKS.filter(([, k]) => has(s[k]));

  const cats = [
    { key: "overview", title: "Overview", icon: LayoutGrid, count: null },
    ...GROUPS.map((g) => { const count = g.fields.filter(([, k]) => has(s[k])).length; return { key: g.key, title: g.title, icon: g.icon, count }; }),
    { key: "documents", title: "Documents", icon: FileText, count: activeLinks.length },
  ];

  const groupCards = (g) => (
    g.key === "tempzone" ? (
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {g.fields.map(([label, key, isNum]) => <Fact key={key} label={label} value={fval(key, isNum)} />)}
        </div>
        <div className="h-44">
          {zoneEmpty ? (
            <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-line bg-canvas text-sm text-muted">No temperature-zone data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={zoneData} layout="vertical" margin={{ left: 8, right: 28 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="z" width={96} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#667085" }} />
                <Bar dataKey="v" radius={[0, 6, 6, 0]} isAnimationActive={false} label={{ position: "right", fontSize: 11, fill: "#667085", formatter: (v) => Number(v).toLocaleString() }}>
                  {zoneData.map((_, i) => <Cell key={i} fill={zoneColors[i]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    ) : (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {g.fields.map(([label, key, isNum]) => <Fact key={key} label={label} value={fval(key, isNum)} />)}
      </div>
    )
  );

  const pane = () => {
    if (tab === "overview") {
      return (
        <SectionCard icon={LayoutGrid} title="Overview">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <div className="sm:col-span-2 md:col-span-3"><Fact label="Full address" value={`${show(s.street_address)}, ${show(s.city)}, ${show(s.state)} ${show(s.zip)}`} /></div>
            <Fact label="Site name" value={show(s.location_name)} />
            <Fact label="Site leader(s)" value={show(s.site_leaders)} />
            <Fact label="Total sq ft" value={fmtN(s.total_sqft)} />
            <Fact label="Expansion space" value={show(s.expansion_space)} />
            <Fact label="Automation vendor" value={show(s.automation_vendor)} />
            <Fact label="Function" value={show(s.function_local_regional)} />
            <Fact label="Stores serviced" value={fmtN(s.total_stores_serviced)} />
          </div>
        </SectionCard>
      );
    }
    if (tab === "documents") {
      return (
        <SectionCard icon={FileText} title="Documents">
          {activeLinks.length === 0 ? (
            <div className="text-sm text-muted">No site plans or drawings linked yet — <span className="font-medium text-ink">upload to the site_drawings volume</span>.</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {activeLinks.map(([label, key]) => (
                <a key={key} href={s[key]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] font-semibold text-ink hover:bg-white"><FileText size={13} className="text-gold-deep" /> {label} ↗</a>
              ))}
            </div>
          )}
        </SectionCard>
      );
    }
    if (tab === "ask") {
      return (
        <SectionCard icon={Sparkles} title="Ask about this site">
          <div className="flex gap-2">
            <input id="askbox" defaultValue={`What is the expansion space at the ${show(s.city)} DC?`}
                   className="min-w-0 flex-1 rounded-lg border border-line px-3 py-2 text-[13px] focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/20"
                   onKeyDown={(e) => { if (e.key === "Enter") runAsk(e.currentTarget.value); }} />
            <button onClick={() => runAsk(document.getElementById("askbox").value)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-navy px-4 py-2 text-[13px] font-semibold text-white hover:brightness-110"><Send size={14} /> Ask</button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {["Which DCs have expansion space?", "How many DCs per state?", "Which sites are union-operated?"].map((c) => (
              <button key={c} onClick={() => runAsk(c)} className="rounded-full bg-canvas px-2.5 py-1 text-[11px] text-muted hover:text-ink">{c}</button>
            ))}
          </div>
          {ask.loading && <div className="mt-3 text-[13px] text-muted">Genie is thinking…</div>}
          {ask.res && (
            <div className="mt-3 space-y-2">
              {ask.res.answer && <div className="whitespace-pre-wrap text-[13px] leading-6 text-ink">{ask.res.answer}</div>}
              {ask.res.sql && <pre className="overflow-x-auto rounded-lg bg-navy p-3 text-[11px] text-[#e9d8a6]">{ask.res.sql}</pre>}
              {ask.res.columns?.length > 0 && (
                <div className="overflow-x-auto"><table className="w-full text-[12px]">
                  <thead><tr>{ask.res.columns.map((c) => <th key={c} className="border-b border-line px-2 py-1 text-left text-[10px] uppercase tracking-wide text-muted">{c}</th>)}</tr></thead>
                  <tbody>{ask.res.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j} className="border-b border-line px-2 py-1">{cell == null ? "—" : String(cell)}</td>)}</tr>)}</tbody>
                </table></div>
              )}
            </div>
          )}
        </SectionCard>
      );
    }
    const g = GROUPS.find((x) => x.key === tab);
    if (!g) return null;
    const gEmpty = g.fields.every(([, k]) => !has(s[k]));
    return (
      <SectionCard icon={g.icon} title={g.title}>
        {gEmpty && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-dashed border-line bg-canvas px-3 py-2 text-[12px] text-muted">
            <g.icon size={13} className="text-gold-deep" /> No {g.title.toLowerCase()} data captured for this site yet — these fields populate as the site data is updated.
          </div>
        )}
        {groupCards(g)}
      </SectionCard>
    );
  };

  return (
    <div className="min-h-full slide-in">
      {Head}
      <div className="text-white" style={{ background: "linear-gradient(120deg,#0b1e3b,#17376b)" }}>
        <div className="mx-auto max-w-6xl px-6 py-8">
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/12 px-2.5 py-0.5 text-[11px] font-bold text-white"><span className="h-1.5 w-1.5 rounded-full" style={{ background: GOLD }} />DC</span>
                <span className="text-[12px] font-semibold text-white/70">{show(s.dc_plant)}{has(s.whs_plt_no) ? ` · Plant ${s.whs_plt_no}` : ""}{has(s.region) ? ` · ${s.region}` : ""}</span>
              </div>
              <h1 className="mt-1.5 text-3xl font-bold tracking-tight">{show(s.location_name)}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-white/75">
                <span className="inline-flex items-center gap-1.5"><MapPin size={14} style={{ color: GOLD }} /> {show(s.street_address)}, {show(s.city)}, {show(s.state)} {show(s.zip)}</span>
                <span className="inline-flex items-center gap-1.5"><Users size={14} style={{ color: GOLD }} /> Site leader · <span className="font-semibold text-white">{show(s.site_leaders)}</span></span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              {canEdit && <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-white/12 px-3.5 py-2 text-xs font-semibold text-white hover:bg-white/20"><Pencil size={13} /> Edit facts</button>}
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-6">
        <div className="flex flex-col gap-5 lg:flex-row">
          {/* left rail */}
          <nav className="flex gap-2 overflow-x-auto pb-1 lg:w-60 lg:flex-none lg:flex-col lg:overflow-visible lg:pb-0">
            {/* prominent "Ask Genie" CTA — pinned to the top so it's the first, obvious action */}
            <button onClick={() => setTab("ask")}
                    className={"group relative flex shrink-0 items-center gap-2.5 overflow-hidden rounded-xl px-3.5 py-3 text-left transition lg:w-full "
                      + (tab === "ask" ? "shadow-soft ring-2 ring-gold" : "shadow-soft hover:brightness-[1.06]")}
                    style={{ background: "linear-gradient(120deg,#0b1e3b,#17376b)" }}>
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg" style={{ background: GOLD }}>
                <Sparkles size={16} className="text-navy" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-bold leading-tight text-white">Ask about this site</span>
                <span className="block text-[10.5px] font-medium leading-tight text-white/70">AI · chat with this DC's data</span>
              </span>
            </button>
            <div className="hidden h-px bg-line lg:my-1.5 lg:block" />
            {cats.map((cat) => {
              const active = tab === cat.key;
              const empty = typeof cat.count === "number" && cat.count === 0;
              return (
                <button key={cat.key} onClick={() => setTab(cat.key)}
                        title={cat.title}
                        className={"flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] font-semibold whitespace-nowrap transition lg:w-full "
                          + (active ? "text-navy shadow-soft" : "text-ink hover:bg-canvas")}
                        style={active ? { background: GOLD } : {}}>
                  <cat.icon size={15} className={active ? "text-navy" : empty ? "text-muted" : "text-gold-deep"} />
                  <span className={"flex-1 " + (!active && empty ? "text-muted" : "")}>{cat.title}</span>
                  {typeof cat.count === "number" && (
                    cat.count > 0 ? (
                      <span className="rounded-full px-1.5 text-[10px] font-bold" style={active ? { background: "rgba(11,30,59,.18)", color: "#0b1e3b" } : { background: "#eef2f7", color: "#8a6d31" }}>{cat.count}</span>
                    ) : (
                      <span className={"text-[9.5px] font-semibold uppercase tracking-wide " + (active ? "text-navy/60" : "text-muted/70")}>no data</span>
                    )
                  )}
                </button>
              );
            })}
          </nav>
          {/* right pane */}
          <div className="min-w-0 flex-1 space-y-4">{pane()}</div>
        </div>
      </div>

      {/* persistent aerial / satellite view — bottom half, always visible */}
      <div className="mx-auto max-w-6xl px-6 pb-10">
        <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-soft">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
            <Globe size={15} className="text-gold-deep" />
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted">Aerial / satellite view</div>
              <div className="truncate text-[13px] font-semibold text-ink">{show(s.location_name)} · {show(s.street_address)}, {show(s.city)}, {show(s.state)}</div>
            </div>
          </div>
          <div className="relative h-[300px] w-full bg-canvas sm:h-[460px]">
            {/* fallback sits behind — shows if the embed is blocked or absent */}
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted">
              <Globe size={26} className="opacity-40" />
              {has(s.lat) && has(s.lon)
                ? <span>Loading satellite imagery for {show(s.city)}, {show(s.state)}…</span>
                : <span>No map coordinates for this site.</span>}
            </div>
            {has(s.lat) && has(s.lon) && (
              <iframe title="Satellite view" className="absolute inset-0 h-full w-full border-0" loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                      src={`https://maps.google.com/maps?q=${s.lat},${s.lon}&t=k&z=16&output=embed`} />
            )}
          </div>
        </div>
      </div>

      {editing && <EditModal site={s} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
    </div>
  );
}

const EDIT_FIELDS = [
  ["location_name", "Location name"], ["site_leaders", "Site leader(s)"], ["expansion_space", "Expansion space"],
  ["total_sqft", "Total sq ft"], ["automation_vendor", "Automation vendor"], ["whs_union", "WHS union"],
  ["transportation_operator", "Transportation operator"], ["total_stores_serviced", "Stores serviced"],
];
function EditModal({ site, onClose, onSaved }) {
  const [f, setF] = useState(Object.fromEntries(EDIT_FIELDS.map(([k]) => [k, site[k] ?? ""])));
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); await api.edit(site.site_id, f); onSaved(); };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 p-4" onClick={onClose}>
      <div className="w-[460px] max-w-full rounded-2xl bg-white p-6 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between"><h3 className="text-base font-semibold text-ink">Edit {show(site.location_name)}</h3><button onClick={onClose}><X size={18} className="text-muted" /></button></div>
        <div className="grid grid-cols-2 gap-3">
          {EDIT_FIELDS.map(([k, label]) => (
            <div key={k}>
              <label className="text-[10px] font-bold uppercase tracking-wide text-muted">{label}</label>
              <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}
                     className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-[13px] focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/20" />
            </div>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg bg-canvas px-4 py-2 text-[13px] font-semibold text-ink">Cancel</button>
          <button disabled={busy} onClick={save} className="rounded-lg bg-navy px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function initials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// Signed-in user chip → dropdown → Settings page. Identity comes from /api/me
// (Databricks injects it at the proxy; falls back to a generic label in local dev).
function UserMenu({ navigate }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const name = me?.name || "Signed-in user";
  const sub = me?.email || (me && !me.authenticated ? "Local session" : "");
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/20 bg-white/10 py-1.5 pl-1.5 pr-2.5 text-xs font-semibold text-white hover:bg-white/20">
        <span className="flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-bold text-navy" style={{ background: GOLD }}>{initials(name)}</span>
        <span className="hidden max-w-[150px] truncate sm:block">{name}</span>
        <ChevronDown size={14} className={"transition " + (open ? "rotate-180" : "")} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-line bg-white text-ink shadow-soft">
            <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg text-[13px] font-bold text-white" style={{ background: NAVY }}>{initials(name)}</span>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">{name}</div>
                {sub && <div className="truncate text-[11px] text-muted">{sub}</div>}
              </div>
            </div>
            {me?.is_admin && (
              <button onClick={() => { setOpen(false); navigate("/settings"); }}
                      className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] font-medium hover:bg-canvas">
                <Settings size={15} className="text-gold-deep" /> Settings
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const colLabel = (k) => (k === "site_id" ? "Site ID" : k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()));

// Site-data upload with a REVIEW + EDIT step before the destructive replace.
// Choose file → parse server-side (no write) → edit the grid → confirm → commit.
function DataUploadPane() {
  const me = useMe();
  const canEdit = !!me?.can_edit;
  const [stage, setStage] = useState("idle"); // idle | parsing | review | committing | done | error
  const [cols, setCols] = useState([]);
  const [numeric, setNumeric] = useState(new Set());
  const [rows, setRows] = useState([]);       // each: { _rid, ...values }
  const [msg, setMsg] = useState(null);       // { ok, text }
  const [createIfMissing, setCreateIfMissing] = useState(true);
  const edits = useRef({});                   // `${_rid}:${col}` -> overridden value

  const choose = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = "";
    setStage("parsing"); setMsg(null);
    try {
      const r = await api.uploadParse(file);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setStage("error"); setMsg({ ok: false, text: j.detail || "Could not parse the file." }); return; }
      edits.current = {};
      setCols(j.columns || []);
      setNumeric(new Set(j.numeric || []));
      setRows((j.rows || []).map((row, i) => ({ _rid: i, ...row })));
      setStage("review");
    } catch (err) { setStage("error"); setMsg({ ok: false, text: String(err) }); }
  };

  const setCell = (rid, col, val) => { edits.current[`${rid}:${col}`] = val; };
  const removeRow = (rid) => setRows((rs) => rs.filter((r) => r._rid !== rid));
  const reset = () => { edits.current = {}; setRows([]); setCols([]); setStage("idle"); setMsg(null); };

  const commit = async () => {
    setStage("committing"); setMsg(null);
    const payload = rows.map((r) => {
      const out = {};
      for (const c of cols) { const k = `${r._rid}:${c}`; out[c] = k in edits.current ? edits.current[k] : r[c]; }
      return out;
    });
    try {
      const res = await api.uploadCommit(payload, createIfMissing);
      const j = await res.json().catch(() => ({}));
      if (res.ok) { setStage("done"); setMsg({ ok: true, text: `Loaded ${j.rows} site${j.rows === 1 ? "" : "s"}.${j.created_table ? " The table was created from this file." : ""} Return to the map to see the refreshed directory.` }); }
      else { setStage("review"); setMsg({ ok: false, text: j.detail || "Load failed." }); }
    } catch (err) { setStage("review"); setMsg({ ok: false, text: String(err) }); }
  };

  if (!canEdit) {
    return (
      <SectionCard icon={Upload} title="Site data">
        <div className="flex items-start gap-2 rounded-lg border border-dashed border-line bg-canvas px-3 py-3 text-[13px] text-muted">
          <AlertCircle size={15} className="mt-0.5 shrink-0 text-gold-deep" />
          <span>You have <span className="font-semibold text-ink">view-only</span> access, so uploading site data is disabled. Ask an admin to add you to the editors list to manage the directory.</span>
        </div>
      </SectionCard>
    );
  }

  if (stage !== "review" && stage !== "committing") {
    return (
      <SectionCard icon={Upload} title="Site data">
        <p className="text-[13px] leading-5 text-ink">Upload the consolidated site spreadsheet, then <span className="font-semibold">review and edit</span> the parsed rows before loading. Accepts <span className="font-semibold">.xlsx</span>, <span className="font-semibold">.xlsm</span>, or <span className="font-semibold">.csv</span>.</p>
        <p className="mt-1 text-[12px] leading-5 text-muted">Loading <span className="font-semibold text-ink">replaces the entire directory</span> — but nothing is written until you confirm on the review screen.</p>
        <label className={"mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-navy px-4 py-2 text-[13px] font-semibold text-white hover:brightness-110 " + (stage === "parsing" ? "opacity-60 pointer-events-none" : "")}>
          <Upload size={14} /> {stage === "parsing" ? "Reading file…" : "Choose site data"}
          <input type="file" accept=".csv,.xlsx,.xlsm" className="hidden" onChange={choose} />
        </label>
        {msg && (
          <div className={"mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-[12px] " + (msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700")}>
            {msg.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <AlertCircle size={14} className="mt-0.5 shrink-0" />}
            <span>{msg.text}</span>
          </div>
        )}
      </SectionCard>
    );
  }

  return (
    <SectionCard icon={Upload} title="Review site data">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-[13px] text-ink"><span className="font-semibold">{rows.length}</span> row{rows.length === 1 ? "" : "s"} parsed · edit any cell, delete bad rows, then load.</div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={reset} className="rounded-lg bg-canvas px-3 py-1.5 text-[13px] font-semibold text-ink hover:brightness-95">Cancel</button>
          <button disabled={stage === "committing" || rows.length === 0} onClick={commit}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-navy px-4 py-1.5 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50">
            <CheckCircle2 size={14} /> {stage === "committing" ? "Loading…" : `Confirm & load ${rows.length} site${rows.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
        <AlertCircle size={13} className="shrink-0" /> Loading replaces the entire directory with exactly these rows.
      </div>
      <label className="mt-2 flex items-center gap-2 text-[12px] text-ink">
        <input type="checkbox" checked={createIfMissing} onChange={(e) => setCreateIfMissing(e.target.checked)} className="h-4 w-4 accent-gold-deep" />
        Create the table if it doesn't exist (column types are inferred from this file)
      </label>
      {msg && !msg.ok && (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700"><AlertCircle size={14} className="mt-0.5 shrink-0" /><span>{msg.text}</span></div>
      )}
      <div className="mt-3 max-h-[460px] overflow-auto rounded-xl border border-line">
        <table className="border-collapse text-[12px]">
          <thead className="sticky top-0 z-10 bg-canvas">
            <tr>
              <th className="sticky left-0 z-20 border-b border-r border-line bg-canvas px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-muted">#</th>
              {cols.map((c) => (
                <th key={c} className="whitespace-nowrap border-b border-line px-2 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-muted">{colLabel(c)}</th>
              ))}
              <th className="border-b border-line px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={row._rid} className="hover:bg-canvas/60">
                <td className="sticky left-0 z-10 border-b border-r border-line bg-white px-2 py-1 text-right text-[11px] font-semibold text-muted">{idx + 1}</td>
                {cols.map((c) => (
                  <td key={c} className="border-b border-line p-0">
                    <input defaultValue={row[c] == null ? "" : String(row[c])}
                           onChange={(e) => setCell(row._rid, c, e.target.value)}
                           className={"w-full min-w-[130px] bg-transparent px-2 py-1.5 outline-none focus:bg-gold/10 " + (numeric.has(c) ? "text-right tabular-nums" : "")} />
                  </td>
                ))}
                <td className="border-b border-line px-1 text-center">
                  <button onClick={() => removeRow(row._rid)} title="Remove row" className="rounded p-1 text-muted hover:bg-red-50 hover:text-red-600"><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

const SETTINGS_TABS = [
  { key: "override", title: "Override site data", icon: Upload, ready: true },
  { key: "update", title: "Update site data", icon: Pencil, ready: true },
  { key: "admins", title: "Site admins", icon: Users, ready: true },
  { key: "config", title: "Configuration", icon: SlidersHorizontal, ready: true },
];

// Read-only view of the deploy-time settings (catalog, schema, warehouse). Changing them means
// editing databricks.yml and redeploying, so nothing here is editable.
function ConfigPane() {
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.adminConfig().then(setCfg).catch((e) => setErr(e.message));
  }, []);
  const rows = cfg ? [
    ["Catalog", cfg.catalog],
    ["Schema", cfg.schema],
    ["Site table", cfg.table],
    ["Admin table", cfg.admin_table],
    ["SQL warehouse ID", cfg.warehouse_id],
    ["Genie space ID", cfg.genie_space_id || "not set"],
    ["Editors", Array.isArray(cfg.editors) ? cfg.editors.join(", ") : cfg.editors],
  ] : [];
  return (
    <SectionCard icon={SlidersHorizontal} title="Configuration">
      <p className="text-[13px] leading-5 text-ink">These values are set at deploy time. To change them, update the target in <span className="font-mono text-[12px]">databricks.yml</span> and redeploy the app.</p>
      {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-800">{err}</div>}
      {!cfg && !err && <div className="text-[13px] text-muted">Loading…</div>}
      {cfg && (
        <table className="w-full text-[13px]">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-b border-line/60">
                <td className="w-56 py-2 font-semibold text-muted">{k}</td>
                <td className="py-2 font-mono text-[12px] text-ink break-all">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

const NON_EDITABLE_COLS = ["site_id", "lat", "lon", "google_earth_url"];

// Pulls every row from the site table, lets an admin edit cells in place, and writes
// only the changed rows back on submit.
function UpdateSiteDataPane() {
  const [rows, setRows] = useState(null);
  const [cols, setCols] = useState([]);
  const [edits, setEdits] = useState({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(() => {
    setRows(null);
    api.sitesAll()
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setRows(list);
        setCols(list.length ? Object.keys(list[0]).filter((k) => !NON_EDITABLE_COLS.includes(k)) : []);
      })
      .catch((e) => { setRows([]); setMsg({ kind: "err", text: e.message }); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const original = (r, k) => (r[k] === null || r[k] === undefined ? "" : String(r[k]));
  const valueOf = (r, k) => (edits[r.site_id] && k in edits[r.site_id] ? edits[r.site_id][k] : original(r, k));
  const setCell = (siteId, k, v) => setEdits((e) => ({ ...e, [siteId]: { ...(e[siteId] || {}), [k]: v } }));

  const changed = (rows || [])
    .filter((r) => edits[r.site_id])
    .map((r) => ({
      site_id: r.site_id,
      fields: Object.fromEntries(Object.entries(edits[r.site_id]).filter(([k, v]) => v !== original(r, k))),
    }))
    .filter((x) => Object.keys(x.fields).length > 0);

  const shown = (rows || []).filter((r) => {
    const q = filter.trim().toLowerCase();
    return !q || [r.site_id, r.location_name, r.city, r.state].some((v) => String(v || "").toLowerCase().includes(q));
  });

  const submit = async () => {
    if (!changed.length) return;
    setBusy(true); setMsg(null);
    try {
      const res = await api.siteDataBatch(changed);
      setMsg({ kind: "ok", text: `Saved ${res.rows} row${res.rows === 1 ? "" : "s"} to the site table.` });
      setEdits({});
      load();
    } catch (e) {
      setMsg({ kind: "err", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard icon={Pencil} title="Update site data">
      <p className="text-[13px] leading-5 text-ink">Edit any cell, then press <span className="font-semibold">Submit changes</span>. Only the rows you changed are written back to the table.</p>
      {msg && (
        <div className={"rounded-lg px-3 py-2 text-[12px] " + (msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800")}>{msg.text}</div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by site, name, city or state"
               className="w-72 rounded-lg border border-line px-3 py-1.5 text-[13px]" />
        <span className="text-[12px] text-muted">{changed.length} row{changed.length === 1 ? "" : "s"} changed</span>
        <div className="ml-auto flex gap-2">
          <button onClick={() => setEdits({})} disabled={!changed.length || busy}
                  className="rounded-lg border border-line px-3 py-1.5 text-[12px] font-semibold disabled:opacity-40">Discard</button>
          <button onClick={submit} disabled={!changed.length || busy}
                  className="rounded-lg px-3 py-1.5 text-[12px] font-semibold text-navy disabled:opacity-40" style={{ background: GOLD }}>
            {busy ? "Saving…" : "Submit changes"}
          </button>
        </div>
      </div>
      {rows === null ? (
        <div className="text-[13px] text-muted">Loading sites…</div>
      ) : (
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-line">
          <table className="min-w-max border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr className="sticky top-0 z-10 bg-canvas">
                <th className="sticky left-0 z-20 border-b border-line bg-canvas px-2 py-1.5 text-left font-semibold">Site ID</th>
                {cols.map((k) => <th key={k} className="whitespace-nowrap border-b border-line px-2 py-1.5 text-left font-semibold">{colLabel(k)}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.site_id} className={edits[r.site_id] ? "bg-amber-50" : ""}>
                  <td className="sticky left-0 border-b border-line bg-white px-2 py-1 font-mono text-[11px] text-muted">{r.site_id}</td>
                  {cols.map((k) => (
                    <td key={k} className="border-b border-line px-1 py-1">
                      <input value={valueOf(r, k)} onChange={(e) => setCell(r.site_id, k, e.target.value)}
                             className="w-44 rounded border border-transparent px-1.5 py-1 hover:border-line focus:border-gold-deep focus:outline-none" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// Assign or remove site admins. Writes the sites_admin table (created on first assignment).
function AdminsPane() {
  const [rows, setRows] = useState(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(() => {
    api.adminUsers()
      .then((list) => setRows(Array.isArray(list) ? list : []))
      .catch((e) => { setRows([]); setMsg({ kind: "err", text: e.message }); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const isOn = (r) => String(r.is_site_admin).toLowerCase() === "true";

  const assign = async (addr, flag) => {
    const clean = String(addr || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) { setMsg({ kind: "err", text: "Enter a valid email address." }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.adminAssign(clean, flag);
      setMsg({ kind: "ok", text: flag ? `${clean} is now a site admin.` : `${clean} is no longer a site admin.` });
      setEmail("");
      load();
    } catch (e) {
      setMsg({ kind: "err", text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard icon={Users} title="Site admins">
      <p className="text-[13px] leading-5 text-ink">Workspace admins always have access to Settings. Anyone marked as a site admin below also gets access.</p>
      {msg && (
        <div className={"rounded-lg px-3 py-2 text-[12px] " + (msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800")}>{msg.text}</div>
      )}
      <div className="flex gap-2">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com"
               className="w-80 rounded-lg border border-line px-3 py-1.5 text-[13px]" />
        <button onClick={() => assign(email, true)} disabled={busy || !email.trim()}
                className="rounded-lg px-3 py-1.5 text-[12px] font-semibold text-navy disabled:opacity-40" style={{ background: GOLD }}>Add as site admin</button>
      </div>
      {rows === null ? (
        <div className="text-[13px] text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-[13px] text-muted">No site admins assigned yet.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted"><th className="py-1.5">User</th><th className="py-1.5 text-right">Site admin</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.user_email} className="border-b border-line/60">
                <td className="py-2">{r.user_email}</td>
                <td className="py-2 text-right">
                  <input type="checkbox" checked={isOn(r)} disabled={busy} onChange={() => assign(r.user_email, !isOn(r))}
                         className="h-4 w-4 accent-gold-deep" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

// Full Settings page — admin-only. Left-rail tabs, same layout as the site detail page.
function SettingsPage({ navigate }) {
  const cfg = useConfig();
  const me = useMe();
  const [tab, setTab] = useState("override");
  const pane = () => {
    if (!me) return <div className="text-sm text-muted">Checking access…</div>;
    if (!me.is_admin) return (
      <SectionCard icon={Settings} title="Admins only">
        <p className="text-[13px] leading-5 text-ink">Settings are available to site admins. Ask an admin to add you to the site admin list.</p>
      </SectionCard>
    );
    if (tab === "update") return <UpdateSiteDataPane />;
    if (tab === "admins") return <AdminsPane />;
    if (tab === "config") return <ConfigPane />;
    return <DataUploadPane />;
  };

  const Head = (
    <header className="flex items-center gap-4 px-6 py-3.5 text-white shadow-soft"
            style={{ background: HEADER_BG, borderBottom: "1px solid rgba(198,161,91,.5)" }}>
      <a href="/" onClick={navClick(navigate, "/")} className="inline-flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-xs font-semibold hover:bg-white/20"><ArrowLeft size={14} /> Back to map</a>
      <BrandLogo h={22} />
      <span className="border-l border-white/25 pl-3 text-sm font-semibold text-white/90">{cfg.title}</span>
      <div className="ml-auto"><UserMenu navigate={navigate} /></div>
    </header>
  );

  return (
    <div className="min-h-full slide-in">
      {Head}
      <div className="text-white" style={{ background: "linear-gradient(120deg,#0b1e3b,#17376b)" }}>
        <div className="mx-auto max-w-6xl px-6 py-8">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.12em]" style={{ color: "rgba(198,161,91,.9)" }}>
            <Settings size={13} /> Configuration
          </div>
          <h1 className="mt-1.5 text-3xl font-bold tracking-tight">Settings</h1>
          <p className="mt-1.5 text-[13px] text-white/75">Manage the data behind the Fact Book and how it's presented.</p>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-6">
        <div className="flex flex-col gap-5 lg:flex-row">
          {/* left rail — same pattern as the detail page */}
          <nav className="flex gap-2 overflow-x-auto pb-1 lg:w-60 lg:flex-none lg:flex-col lg:overflow-visible lg:pb-0">
            {SETTINGS_TABS.map((t) => {
              const active = tab === t.key;
              return (
                <button key={t.key} onClick={() => setTab(t.key)} title={t.title}
                        className={"flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] font-semibold whitespace-nowrap transition lg:w-full "
                          + (active ? "text-navy shadow-soft" : "text-ink hover:bg-canvas")}
                        style={active ? { background: GOLD } : {}}>
                  <t.icon size={15} className={active ? "text-navy" : t.ready ? "text-gold-deep" : "text-muted"} />
                  <span className={"flex-1 " + (!active && !t.ready ? "text-muted" : "")}>{t.title}</span>
                  {!t.ready && <span className={"text-[9.5px] font-semibold uppercase tracking-wide " + (active ? "text-navy/60" : "text-muted/70")}>soon</span>}
                </button>
              );
            })}
          </nav>
          {/* right pane */}
          <div className="min-w-0 flex-1 space-y-4">{pane()}</div>
        </div>
      </div>
    </div>
  );
}
