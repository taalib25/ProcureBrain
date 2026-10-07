import { useEffect, useRef, type ReactNode } from "react";
import { readable } from "../api";

const paths: Record<string, ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  box: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/></>,
  inbox: <><path d="M4 4h16l2 12v4H2v-4L4 4Z"/><path d="M2 15h6l2 3h4l2-3h6"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  review: <><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9zM9 11h6m-6 5 2 2 4-4"/></>,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/></>,
  people: <><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/></>,
  file: <><path d="M14 2H5v20h14V7l-5-5Z"/><path d="M14 2v5h5M8 12h8m-8 4h6"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  book: <><path d="M12 5v16M3 4c3-1 6-1 9 1 3-2 6-2 9-1v16c-3-1-6-1-9 1-3-2-6-2-9-1V4Z"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 1l1 5M4 12l1 5a8 8 0 0 0 13 1"/></>,
  warning: <><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.1"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  leaf: <><path d="M20 3c-11-2-17 4-16 11 1 6 9 6 12 2 3-4 3-8 4-13Z"/><path d="M4 21 15 9"/></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></>,
  spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h3m2 0h3"/></>,
};
export function Icon({ name, size = 20, className = "" }: { name: string; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.file}</svg>;
}
export function Badge({ value, children }: { value: string; children?: ReactNode }) {
  const tone = ["APPLIED", "PROCESSED", "RECEIVED", "VALID", "completed", "active"].includes(value) ? "green" : ["FAILED", "failed", "STALE", "REJECTED", "blocked", "LATE_PO"].includes(value) ? "red" : ["PENDING", "REVIEW_REQUIRED", "LOW_CONFIDENCE", "needs_review", "PROPOSAL_CREATED", "PARTIALLY_RECEIVED"].includes(value) ? "amber" : "neutral";
  return <span className={`badge badge-${tone}`}><span className="badge-dot"/>{children ?? readable(value)}</span>;
}
export function Empty({ icon = "inbox", title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Icon name={icon} size={26}/></span><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}
export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "error" | "success" }) {
  return <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}><Icon name={tone === "success" ? "check" : tone === "error" ? "warning" : "shield"} size={18}/><span>{children}</span></div>;
}
export function PanelHeading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>;
}
export function Modal({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    const firstControl = dialog?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not([aria-label="Close dialog"]):not(:disabled)');
    firstControl?.focus({ preventScroll: true });
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? "modal-wide" : ""}`} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) onClose(); }}><div className="modal-heading"><div><span className="eyebrow">PROCUREBRAIN WORKSPACE</span><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close"/></button></div>{children}</dialog>;
}
export function RawDetails({ value, label = "Technical details" }: { value: unknown; label?: string }) {
  return <details className="raw-details"><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}
