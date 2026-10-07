import { Connections } from "./pages/connections";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import { Empty, Icon, Notice } from "./components/ui";
import { Overview, OrderDetail, OrderTable } from "./pages/orders";
import { CaptureMessage, Messages, messageCheckLabel } from "./pages/messages";
import { Practice, type PracticeCase } from "./pages/practice";
import { AgentActivity } from "./pages/agent";
import { Reviews } from "./pages/reviews";
import { Imports } from "./pages/imports";
import { Evidence, History, Progress, Suppliers } from "./pages/records";
import type { DashboardData, Page } from "./types";

const pages: Record<Page, { label: string; title: string; description: string; icon: string }> = {
  connections: { label: "Connections", title: "Connect your message channels", description: "Let supplier messages arrive here automatically.", icon: "mail" },
  overview: { label: "Home", title: "Your orders at a glance", description: "See what needs your help and what is due next.", icon: "grid" },
  orders: { label: "Orders", title: "Orders", description: "See delivery dates, quantities, and past updates.", icon: "box" },
  messages: { label: "Messages", title: "Supplier messages", description: "Add a supplier message. We will check it for an order change.", icon: "inbox" },
  reviews: { label: "Check changes", title: "Check order changes", description: "Read the supplier message. Then choose whether to update the order.", icon: "review" },
  agent: { label: "Email alerts", title: "Email alerts", description: "See message progress and the emails prepared for you.", icon: "mail" },
  suppliers: { label: "Suppliers", title: "Suppliers", description: "Keep supplier contact details with their orders.", icon: "people" },
  imports: { label: "Add orders or files", title: "Add orders or files", description: "Upload an order spreadsheet, image, or PDF.", icon: "upload" },
  practice: { label: "Try an example", title: "Try an example", description: "Learn with sample orders and supplier messages.", icon: "check" },
  evidence: { label: "Saved originals", title: "Saved originals", description: "Find the original messages and files behind an order update.", icon: "file" },
  history: { label: "Technical history", title: "Technical history", description: "Details for the person who maintains this app.", icon: "clock" },
  progress: { label: "About this project", title: "About this project", description: "Learn how this prototype works and what still needs work.", icon: "book" },
};
const mainPages: Page[] = ["overview", "orders", "messages", "reviews", "agent", "suppliers"];
const morePages: Page[] = ["connections", "imports", "practice", "evidence", "history", "progress"];
const initialData: DashboardData = { pos: [], attention: [], messages: [], proposals: [], suppliers: [], sources: [], runs: [], health: { ok: false, storage: "unknown" } };
const pageFromHash = (): Page => { const value = window.location.hash.slice(1).split("?")[0]; return Object.hasOwn(pages, value) ? value as Page : "overview"; };

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash); const [data, setData] = useState(initialData); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [search, setSearch] = useState(""); const [revision, setRevision] = useState(0); const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null); const [captureOpen, setCaptureOpen] = useState(false); const [captureOrderId, setCaptureOrderId] = useState<string | undefined>(); const [messageId, setMessageId] = useState<string | null>(null); const [proposalId, setProposalId] = useState<string | null>(new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("proposal"));
  const [practiceCase, setPracticeCase] = useState<PracticeCase | null>(null);
  const [moreOpen, setMoreOpen] = useState(morePages.includes(page));
  useEffect(() => { if (morePages.includes(page)) setMoreOpen(true); }, [page]);
  const controller = useRef<AbortController | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sidebarOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const sidebar = sidebarRef.current;
    const main = mainRef.current;
    if (main) main.inert = true;
    const controls = () => Array.from(sidebar?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), summary') ?? []).filter(element => element.getClientRects().length > 0);
    controls()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setSidebarOpen(false); }
      if (event.key === "Tab") {
        const items = controls(); const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const onResize = () => { if (window.matchMedia("(min-width: 52.01rem)").matches) setSidebarOpen(false); };
    document.addEventListener("keydown", onKeyDown); window.addEventListener("resize", onResize);
    return () => { if (main) main.inert = false; document.removeEventListener("keydown", onKeyDown); window.removeEventListener("resize", onResize); previousFocus?.focus({ preventScroll: true }); };
  }, [sidebarOpen]);
  const refresh = useCallback(async () => {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setLoading(true); setError("");
    try {
      const options = { signal: current.signal };
      const [pos, attention, messages, proposals, suppliers, sources, runs, health] = await Promise.all([
        api<DashboardData["pos"]>("/purchase-orders", options), api<DashboardData["attention"]>("/exceptions", options), api<DashboardData["messages"]>("/messages", options), api<DashboardData["proposals"]>("/proposals", options), api<DashboardData["suppliers"]>("/suppliers", options), api<DashboardData["sources"]>("/sources", options), api<DashboardData["runs"]>("/analysis/runs", options), api<DashboardData["health"]>("/health", options),
      ]);
      if (!current.signal.aborted) { setData({ pos, attention, messages, proposals, suppliers, sources, runs, health }); setRevision(value => value + 1); }
    } catch (error) { if (!current.signal.aborted) setError(errorText(error)); }
    finally { if (!current.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); return () => controller.current?.abort(); }, [refresh]);
  useEffect(() => { const update = () => { setPage(pageFromHash()); setProposalId(new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("proposal")); setSearch(""); }; window.addEventListener("hashchange", update); return () => window.removeEventListener("hashchange", update); }, []);
  useEffect(() => { const timer = setInterval(() => { void refresh(); }, 5000); return () => clearInterval(timer); }, [refresh]);
  const navigate = (next: Page) => { setPage(next); setSearch(""); setSidebarOpen(false); window.location.hash = next; };
  const capture = (orderId?: string) => { setPracticeCase(null); setCaptureOrderId(orderId); setSelectedOrder(null); setCaptureOpen(true); };
  const tryPracticeCase = (scenario: PracticeCase) => { setPracticeCase({ ...scenario, input: { ...scenario.input, externalMessageId: `practice/${scenario.id}/${Date.now()}` } }); setCaptureOrderId(scenario.manualSelection ? data.pos.find(po => po.poReference === scenario.manualSelection)?.entityId : undefined); setCaptureOpen(true); };
  const openReview = (id: string) => { setProposalId(id); navigate("reviews"); window.location.hash = `reviews?proposal=${encodeURIComponent(id)}`; };
  const currentOrder = data.pos.find(po => po.entityId === selectedOrder);
  const pending = data.proposals.filter(proposal => proposal.status === "PENDING").length;
  const unprocessed = data.messages.filter(message => ["Not checked yet", "Needs your help", "Could not finish"].includes(messageCheckLabel(message, data.proposals, data.runs))).length;
  const info = pages[page];
  const navItem = (key: Page) => {
    const item = pages[key];
    const count = key === "reviews" ? pending : key === "messages" ? unprocessed : 0;
    return <button key={key} className={`nav-item ${page === key ? "active" : ""}`} aria-current={page === key ? "page" : undefined} onClick={() => navigate(key)}><Icon name={item.icon} size={19}/><span>{item.label}</span>{count > 0 && <span className="nav-count">{count}</span>}{page === key && !count && <span className="nav-active-dot"/>}</button>;
  };
  return <div className="app-shell">{sidebarOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}/>}<aside id="workspace-navigation" ref={sidebarRef} className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}><a className="brand" href="#overview" onClick={() => navigate("overview")}><span className="brand-symbol"><Icon name="leaf" size={23}/></span><span>Procure<span className="brand-light">Brain</span><small>PURCHASING, WITH CLARITY</small></span></a><div className="workspace-selector"><span className="workspace-avatar">DW</span><span><strong>Demo workspace</strong><small>Sample orders</small></span><span className="workspace-dot" title="Local development workspace"/></div><nav aria-label="Main navigation">{mainPages.map(navItem)}<details className="nav-more" open={moreOpen} onToggle={event => setMoreOpen(event.currentTarget.open)}><summary>More options</summary>{morePages.map(navItem)}</details></nav><div className="sidebar-bottom"><div className="sidebar-tip"><Icon name="shield" size={20}/><strong>You decide what changes.</strong><p>We suggest an update. The order changes only when you approve it.</p><button onClick={() => navigate("practice")}>Try an example<Icon name="arrow" size={14}/></button></div><div className="development-status"><span/><span>Under development</span><span className="version-label">v0.1</span></div></div></aside><div className="main-shell" ref={mainRef}><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={sidebarOpen} aria-controls="workspace-navigation" onClick={() => setSidebarOpen(true)}><Icon name="menu"/></button><span>Workspace</span><Icon name="chevron" size={13}/><strong>{info.label}</strong></div><div className="topbar-actions">{!(["progress", "imports"] as Page[]).includes(page) && <label className="global-search"><Icon name="search" size={17}/><input aria-label="Search workspace" placeholder="Search this view…" value={search} onChange={event => setSearch(event.target.value)}/>{search && <button className="icon-button" aria-label="Clear search" onClick={() => setSearch("")}><Icon name="close" size={14}/></button>}</label>}<button className={`icon-button refresh-button ${loading ? "spinning" : ""}`} disabled={loading} aria-label="Refresh workspace" title="Refresh workspace" onClick={() => void refresh()}><Icon name="refresh" size={19}/></button><span className="topbar-divider"/><span className="owner-avatar" title="Demo workspace">DW</span></div></header><main className="main-content"><div className="page-heading"><div><div className="page-kicker"><span className="live-dot"/><span>PURCHASING WORKSPACE</span></div><h1>{info.title}</h1><p>{info.description}</p></div><div className="heading-actions"><span className="today-label"><Icon name="calendar" size={16}/>{new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date())}</span><button className="button button-secondary" onClick={() => capture()}><Icon name="plus" size={17}/> Add message</button>{["overview", "messages"].includes(page) && <button className="button button-primary" onClick={() => navigate("connections")}><Icon name="mail" size={17}/> Connect channels</button>}</div></div>{error && <div className="workspace-error"><Notice tone="error">Could not load the latest records: {error}{data.health.ok && " Previously loaded records are shown."}</Notice><button className="button button-secondary button-small" onClick={() => void refresh()} disabled={loading}>Try again</button></div>}
    {!data.health.ok ? loading ? <LoadingDashboard/> : <section className="panel"><Empty icon="warning" title="The workspace is unavailable">Select Try again. If this continues, ask the person who set up the app for help.</Empty></section> : <div className="page-content" key={page}>
      {page === "connections" && <Connections revision={revision}/>}
      {page === "overview" && <Overview data={data} search={search} onSelect={setSelectedOrder} navigate={navigate} onReview={openReview} onCapture={() => capture()}/>}
      {page === "orders" && <><div className="orders-attention-summary"><span className="metric-icon rose"><Icon name="warning" size={20}/></span><div><strong>{new Set(data.attention.map(item => item.entityId)).size} orders need attention</strong><p>Open an order to see the problem and its past updates.</p></div><button className="button button-secondary button-small" onClick={() => navigate("imports")}><Icon name="upload" size={15}/> Add orders or files</button></div><OrderTable orders={data.pos} attention={data.attention} search={search} onSelect={setSelectedOrder} onImport={() => navigate("imports")}/></>}
      {page === "messages" && <Messages messages={data.messages} orders={data.pos} proposals={data.proposals} runs={data.runs} revision={revision} search={search} initialId={messageId} onCapture={() => capture()} onChanged={refresh} onReview={openReview}/>}
      {page === "reviews" && <Reviews proposals={data.proposals} orders={data.pos} revision={revision} initialId={proposalId} search={search} onChanged={refresh} onCapture={() => capture()}/>}
      {page === "imports" && <Imports orders={data.pos} onChanged={refresh} onReview={openReview}/>}
      {page === "suppliers" && <Suppliers suppliers={data.suppliers} orders={data.pos} search={search} onChanged={refresh} onOrder={setSelectedOrder}/>}
      {page === "evidence" && <Evidence sources={data.sources} search={search}/>}
      {page === "history" && <History runs={data.runs} search={search} revision={revision}/>}
      {page === "agent" && <AgentActivity onReview={openReview} search={search}/> }
      {page === "practice" && <Practice data={data} search={search} onChanged={refresh} onTry={tryPracticeCase}/> }
      {page === "progress" && <Progress storage={data.health.storage}/>}
    </div>}<footer className="app-footer"><span><span className="live-dot"/>{data.health.ok ? "App service available" : "Connecting to app"}</span><span>{data.health.storage === "memory" ? "Demo records reset when the app restarts" : data.health.storage === "postgres" ? "Records saved between restarts" : ""}<span className="footer-separator">·</span>ProcureBrain prototype</span></footer></main></div>{currentOrder && <OrderDetail po={currentOrder} attention={data.attention} revision={revision} onClose={() => setSelectedOrder(null)} onCapture={capture}/>} {captureOpen && <CaptureMessage orders={data.pos} initialOrderId={captureOrderId} initialMessage={practiceCase?.input} onClose={() => setCaptureOpen(false)} onSaved={id => { setCaptureOpen(false); setMessageId(id); navigate("messages"); void refresh(); }}/>}</div>;
}

function LoadingDashboard() {
  return <div className="loading-dashboard" role="status" aria-label="Loading workspace"><div className="metric-grid">{[1, 2, 3, 4].map(value => <div className="skeleton metric" key={value}/>)}</div><div className="skeleton loading-panel"/><p className="loading-label">Loading your orders…</p></div>;
}
