/*
 * Watchlog RUM for React — v0.2.6
 * - Network events disabled by default (no fetch/xhr instrumentation)
 * - apiKey now included in payload body (works with sendBeacon)
 * - Skips self resource beacons (no noise from /rum)
 * - Uses your real route templates via WatchlogRoutes
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: any;

import React, { createContext, useContext, useEffect, useMemo } from "react";

// ===================== Types =====================
export type RumEventType =
  | "page_view"
  | "custom"
  | "error"
  | "web_vital"
  | "resource"
  | "network"     // kept for compatibility (we don't emit by default)
  | "long_task";

export interface RumConfig {
  endpoint?: string;
  apiKey?: string;
  app?: string;
  environment?: string;
  release?: string;
  userId?: string;

  sampleRate?: number;
  networkSampleRate?: number; // ignored by default since we don't capture network
  batchMax?: number;
  flushInterval?: number;
  maxQueueBytes?: number;

  captureErrors?: boolean;
  captureFetch?: boolean;      // default: false
  captureXHR?: boolean;        // default: false
  captureResources?: boolean;  // default: true
  maxResourceCount?: number;
  captureLongTasks?: boolean;  // default: false
  enableWebVitals?: boolean;   // default: true

  ignoreSelfResources?: boolean; // default: true (skip /rum & beacons)

  sessionTtlMs?: number;

  // Routing
  routeManifest?: any[]; // react-router RouteObject[]
  getNormalizedPath?: (pathname: string) => string;

  // Control initial PV timing
  autoTrackInitialView?: boolean; // default: true

  // Hook to transform/drop events
  beforeSend?: (event: RumEvent) => RumEvent | null;
}

export interface BaseContext {
  app?: string;
  environment?: string;
  release?: string;
  page: {
    url: string;
    title?: string;
    referrer?: string;
    path?: string;
    normalizedPath?: string;
  };
  viewport: { w: number; h: number; dpr?: number };
  user?: { id?: string } & Record<string, any>;
  extra?: Record<string, any>;
  userAgent?: string;
  language?: string;
  timezone?: string;
}

export interface RumEventBase {
  type: RumEventType;
  ts: number;
  sessionId: string;
  deviceId: string;
  seq: number;
  context: BaseContext;
}

export type RumEvent =
  | (RumEventBase & { type: "page_view"; data: { navType?: string } })
  | (RumEventBase & { type: "custom"; name: string; data?: any })
  | (RumEventBase & { type: "error"; data: { name?: string; message?: string; stack?: string; source?: string } })
  | (RumEventBase & { type: "web_vital"; data: { id: string; name: string; value: number } })
  | (RumEventBase & { type: "resource"; data: { name: string; initiatorType?: string; duration?: number; transferSize?: number } })
  | (RumEventBase & { type: "network"; data: { kind: "fetch" | "xhr"; url: string; method?: string; status?: number; duration?: number; ok?: boolean } })
  | (RumEventBase & { type: "long_task"; data: { name?: string; duration: number } });

export interface RumPublicAPI {
  trackPageView: (extra?: Partial<BaseContext["extra"]>, navType?: string) => void;
  trackEvent: (name: string, data?: any) => void;
  identify: (userId: string, traits?: Record<string, any>) => void;
  setContext: (extra: Record<string, any>) => void;
  trackError: (error: Error | string, source?: string) => void;
  flush: () => void;
  shutdown: () => void;
  getSessionInfo: () => { sessionId: string; deviceId: string; sampled: boolean } | null;
}

// ===================== Constants & utils =====================
const SDK_NAME = "@watchlog/rum-react";
const SDK_VERSION = "0.2.6";
const DEFAULT_ENDPOINT = "https://api.watchlog.io/rum";
const DEFAULT_SAMPLE_RATE = 0.1;
const DEFAULT_BATCH_MAX = 50;
const DEFAULT_FLUSH_INTERVAL = 5000;
const DEFAULT_MAX_QUEUE_BYTES = 250 * 1024;
const DEFAULT_SESSION_TTL = 30 * 60 * 1000;

const LS_DEVICE_KEY = "wl_device_id";
const LS_SESSION_KEY = "wl_session_v1";

function uuid(): string {
  const g: any = globalThis as any;
  if (g?.crypto && typeof g.crypto.randomUUID === "function") return g.crypto.randomUUID();
  const rnd = new Uint8Array(16);
  if (g?.crypto && typeof g.crypto.getRandomValues === "function") g.crypto.getRandomValues(rnd);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = rnd.length ? rnd[Math.floor(Math.random() * rnd.length)] % 16 : Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
const now = () => Date.now();
const originAndPath = (url: string) => { try { const u = new URL(url, location.href); return u.origin + u.pathname; } catch { return url; } };

// Pending (set before startRum)
let pendingRouteManifest: any[] | null = null;
let pendingPathNormalizer: ((p: string) => string) | null = null;

// Track initial PV / manifest readiness
let hasSentInitialPV = false;
let routeManifestReady = false;

// Only the defaulted keys are required
type Defaulted = Required<Pick<RumConfig,
  | 'sampleRate' | 'batchMax' | 'flushInterval' | 'maxQueueBytes'
  | 'captureErrors' | 'captureFetch' | 'captureXHR' | 'captureResources'
  | 'maxResourceCount' | 'captureLongTasks' | 'enableWebVitals'
  | 'ignoreSelfResources'
  | 'sessionTtlMs' | 'autoTrackInitialView'>>;
export type RumConfigWithDefaults = Omit<RumConfig, keyof Defaulted> & Defaulted;

interface InternalState {
  config: RumConfigWithDefaults;
  deviceId: string;
  sessionId: string;
  sampled: boolean;
  seq: number;
  queue: RumEvent[];
  queueBytes: number;
  flushTimer?: number;
  pageCtxExtra: Record<string, any>;
  user?: { id?: string } & Record<string, any>;
  unsubscribers: Array<() => void>;
}
let current: InternalState | null = null;

function applyDefaults(cfg: RumConfig): RumConfigWithDefaults {
  return {
    endpoint: cfg.endpoint ?? DEFAULT_ENDPOINT,
    apiKey: cfg.apiKey,
    app: cfg.app,
    environment: cfg.environment,
    release: cfg.release,
    userId: cfg.userId,

    sampleRate: cfg.sampleRate ?? DEFAULT_SAMPLE_RATE,
    batchMax: cfg.batchMax ?? DEFAULT_BATCH_MAX,
    flushInterval: cfg.flushInterval ?? DEFAULT_FLUSH_INTERVAL,
    maxQueueBytes: cfg.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES,

    captureErrors: cfg.captureErrors ?? true,
    captureFetch: cfg.captureFetch ?? false,   // ← disable by default
    captureXHR: cfg.captureXHR ?? false,       // ← disable by default
    captureResources: cfg.captureResources ?? true,
    maxResourceCount: cfg.maxResourceCount ?? 50,
    captureLongTasks: cfg.captureLongTasks ?? false,
    enableWebVitals: cfg.enableWebVitals ?? true,

    ignoreSelfResources: cfg.ignoreSelfResources ?? true,

    sessionTtlMs: cfg.sessionTtlMs ?? DEFAULT_SESSION_TTL,

    // Routing
    routeManifest: cfg.routeManifest ?? pendingRouteManifest ?? undefined,
    getNormalizedPath: cfg.getNormalizedPath ?? pendingPathNormalizer ?? undefined,

    // Initial PV
    autoTrackInitialView: cfg.autoTrackInitialView ?? true,

    beforeSend: cfg.beforeSend,
  };
}

// ===================== Session / Device =====================
function getOrCreateDeviceId(): string {
  try {
    const fromLs = localStorage.getItem(LS_DEVICE_KEY);
    if (fromLs) return fromLs;
    const id = uuid();
    localStorage.setItem(LS_DEVICE_KEY, id);
    return id;
  } catch { return uuid(); }
}

function loadOrCreateSession(sampleRate: number, ttlMs: number) {
  try {
    const raw = localStorage.getItem(LS_SESSION_KEY);
    const nowMs = now();
    if (raw) {
      try {
        const v = JSON.parse(raw) as { id: string; sampled: boolean; last: number };
        if (nowMs - v.last < ttlMs) {
          const updated = { ...v, last: nowMs };
          localStorage.setItem(LS_SESSION_KEY, JSON.stringify(updated));
          return updated;
        }
      } catch {}
    }
    const id = uuid();
    const sampled = Math.random() < sampleRate;
    const v = { id, sampled, last: nowMs };
    localStorage.setItem(LS_SESSION_KEY, JSON.stringify(v));
    return v;
  } catch { return { id: uuid(), sampled: Math.random() < sampleRate, last: now() }; }
}

function refreshSessionActivity() {
  try {
    const raw = localStorage.getItem(LS_SESSION_KEY);
    if (!raw) return;
    const v = JSON.parse(raw);
    v.last = now();
    localStorage.setItem(LS_SESSION_KEY, JSON.stringify(v));
  } catch {}
}

// ===================== Init =====================
export function startRum(config: RumConfig = {}): RumPublicAPI {
  if (current) return publicAPI; // idempotent
  const cfg = applyDefaults(config);
  const deviceId = getOrCreateDeviceId();
  const sess = loadOrCreateSession(cfg.sampleRate!, cfg.sessionTtlMs!);

  current = {
    config: cfg,
    deviceId,
    sessionId: sess.id,
    sampled: sess.sampled,
    seq: 0,
    queue: [],
    queueBytes: 0,
    flushTimer: undefined,
    pageCtxExtra: {},
    user: cfg.userId ? { id: cfg.userId } : undefined,
    unsubscribers: [],
  };

  if (current.sampled) {
    setupLifecycle();
    if (cfg.captureErrors) attachErrorHandlers();
    // Network is OFF by default:
    if (cfg.captureFetch) instrumentFetch();
    if (cfg.captureXHR) instrumentXHR();
    if (cfg.captureResources) observeResources(cfg.maxResourceCount!);
    if (cfg.captureLongTasks) observeLongTasks();
    if (cfg.enableWebVitals) attachWebVitals();
  }

  scheduleFlush();

  // Defer initial page_view until manifest is ready (or fallback)
  if (current.sampled && current.config.autoTrackInitialView) {
    if (routeManifestReady || current.config.getNormalizedPath) {
      trackPageView();
    } else {
      const int = setInterval(() => {
        if (routeManifestReady && !hasSentInitialPV) {
          clearInterval(int);
          trackPageView();
        }
      }, 16);
      setTimeout(() => {
        if (!hasSentInitialPV) {
          clearInterval(int);
          trackPageView(); // fallback (~800ms) if manifest not set
        }
      }, 800);
    }
  }

  return publicAPI;
}

// ===================== Context =====================
function safeLocationHref() { try { return location.href; } catch { return ""; } }
function tryIntlTimeZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } }

function baseContext(): BaseContext {
  const pathname = typeof location !== "undefined" ? location.pathname : undefined;
  return {
    app: current?.config.app,
    environment: current?.config.environment,
    release: current?.config.release,
    page: {
      url: safeLocationHref(),
      title: typeof document !== "undefined" ? document.title : undefined,
      referrer: typeof document !== "undefined" ? (document.referrer || undefined) : undefined,
      path: pathname,
      normalizedPath: pathname ? computeNormalizedPath(pathname) : undefined,
    },
    viewport: {
      w: typeof window !== "undefined" ? window.innerWidth : 0,
      h: typeof window !== "undefined" ? window.innerHeight : 0,
      dpr: typeof window !== "undefined" ? window.devicePixelRatio : undefined,
    },
    user: current?.user,
    extra: current?.pageCtxExtra,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    language: typeof navigator !== "undefined" ? navigator.language : undefined,
    timezone: tryIntlTimeZone(),
  };
}

// ===================== Queue & Transport =====================
function nextSeq() { return (current ? (current.seq += 1) : 0); }
function safeJsonSize(bytes: number) { return bytes <= (current?.config.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES); }

function enqueue(event: RumEvent) {
  if (!current) return; if (!current.sampled) return;
  const evStr = JSON.stringify(event); const bytes = new Blob([evStr]).size;
  if (!safeJsonSize(current.queueBytes + bytes)) {
    flushQueue(); if (!safeJsonSize(current.queueBytes + bytes)) return;
  }
  current.queue.push(event); current.queueBytes += bytes;
  if (current.queue.length >= current.config.batchMax!) flushQueue();
}

function flushQueue(useBeacon = false) {
  if (!current || !current.queue.length) return;

  // include apiKey in body to support sendBeacon (no custom headers there)
  const payload = {
    sdk: SDK_NAME, version: SDK_VERSION, sentAt: now(),
    apiKey: current.config.apiKey || undefined,          // ← NEW
    sessionId: current.sessionId, deviceId: current.deviceId,
    app: current.config.app, environment: current.config.environment, release: current.config.release,
    events: current.queue,
  };

  const body = JSON.stringify(payload);
  current.queue = []; current.queueBytes = 0;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (current.config.apiKey) headers["X-Watchlog-Key"] = String(current.config.apiKey);

  const url = current.config.endpoint || DEFAULT_ENDPOINT;

  if (useBeacon && typeof navigator !== 'undefined' && (navigator as any).sendBeacon) {
    try {
      const blob = new Blob([body], { type: "application/json" });
      (navigator as any).sendBeacon(url, blob); return;
    } catch {}
  }
  try { fetch(url, { method: "POST", body, headers, keepalive: true }).catch(() => {}); } catch {}
}

function scheduleFlush() {
  if (!current) return; if (current.flushTimer) clearInterval(current.flushTimer as any);
  current.flushTimer = setInterval(() => flushQueue(), current.config.flushInterval) as any;
}

// ===================== Lifecycle =====================
function setupLifecycle() {
  const onUnload = () => { refreshSessionActivity(); flushQueue(true); };
  if (typeof window === 'undefined') return;
  window.addEventListener("beforeunload", onUnload);
  window.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushQueue(true); });
  ["click","keydown","scroll","pointerdown","touchstart","mousemove","focus"].forEach(evt => {
    const h = () => refreshSessionActivity();
    window.addEventListener(evt, h, { passive: true });
    current?.unsubscribers.push(() => window.removeEventListener(evt, h));
  });
  current?.unsubscribers.push(() => window.removeEventListener("beforeunload", onUnload));
}

// ===================== Public API =====================
export const publicAPI: RumPublicAPI = {
  trackPageView(extra, navType) {
    if (!current || !current.sampled) return;
    const ctx = baseContext(); if (extra) ctx.extra = { ...(ctx.extra || {}), ...extra };
    const ev: RumEvent = { type: "page_view", ts: now(), sessionId: current.sessionId, deviceId: current.deviceId, seq: nextSeq(), context: ctx, data: { navType } } as any;
    dispatch(ev);
    hasSentInitialPV = true;
  },
  trackEvent(name, data) {
    if (!current || !current.sampled) return;
    const ev: RumEvent = { type: "custom", ts: now(), sessionId: current.sessionId, deviceId: current.deviceId, seq: nextSeq(), context: baseContext(), name, data } as any;
    dispatch(ev);
  },
  identify(userId, traits) { if (!current) return; current.user = { id: userId, ...(traits || {}) }; },
  setContext(extra) { if (!current) return; current.pageCtxExtra = { ...(current.pageCtxExtra || {}), ...(extra || {}) }; },
  trackError(error, source) {
    if (!current || !current.sampled) return;
    const err = typeof error === "string" ? new Error(error) : error;
    const ev: RumEvent = { type: "error", ts: now(), sessionId: current.sessionId, deviceId: current.deviceId, seq: nextSeq(), context: baseContext(), data: { name: err.name, message: err.message, stack: err.stack, source } } as any;
    dispatch(ev);
  },
  flush() { flushQueue(); },
  shutdown() { try { if (current?.flushTimer) clearInterval(current.flushTimer as any); } catch {} if (current) { for (const u of current.unsubscribers) try { u(); } catch {} } current = null; },
  getSessionInfo() { if (!current) return null; return { sessionId: current.sessionId, deviceId: current.deviceId, sampled: current.sampled }; },
};

function dispatch(ev: RumEvent) {
  if (!current) return; const transformed = current.config.beforeSend ? current.config.beforeSend(ev) : ev; if (!transformed) return; enqueue(transformed);
}

// ===================== Errors =====================
function attachErrorHandlers() {
  const onError = (e: ErrorEvent) => { publicAPI.trackError((e as any).error || new Error(e.message), e.filename); };
  const onRejection = (e: PromiseRejectionEvent) => { const r: any = (e as any).reason; publicAPI.trackError(r instanceof Error ? r : new Error(String(r)), "unhandledrejection"); };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  current?.unsubscribers.push(() => window.removeEventListener("error", onError));
  current?.unsubscribers.push(() => window.removeEventListener("unhandledrejection", onRejection));
}

// ===================== Network (disabled by default; keep functions for opt-in) =====================
function instrumentFetch() {
  if (!("fetch" in window)) return; const origFetch: typeof fetch = (window.fetch as any).bind(window);
  (window as any).fetch = async (...args: any[]) => {
    if (!current || !current.sampled) return origFetch(...(args as Parameters<typeof fetch>));
    const started = now();
    try { const res = await origFetch(...(args as Parameters<typeof fetch>)); maybeNetworkEvent("fetch", args, res, started); return res; }
    catch (err) { maybeNetworkEvent("fetch", args, undefined, started, err); throw err; }
  };
}
function instrumentXHR() {
  const X: any = (window as any).XMLHttpRequest; if (!X) return;
  const origOpen = X.prototype.open; const origSend = X.prototype.send;
  X.prototype.open = function(method: string, url: string, ...rest: any[]) { (this as any).__wl = { method, url, started: 0 }; return origOpen.call(this, method, url, ...rest); };
  X.prototype.send = function(...sendArgs: any[]) {
    const ctx = (this as any).__wl || ((this as any).__wl = {}); ctx.started = now();
    const onLoadEnd = () => { maybeNetworkEvent("xhr", [ctx.method, ctx.url], { status: this.status, ok: this.status >= 200 && this.status < 400 }, ctx.started); this.removeEventListener("loadend", onLoadEnd); };
    this.addEventListener("loadend", onLoadEnd); return origSend.apply(this, sendArgs as any);
  };
}
function maybeNetworkEvent(kind: "fetch" | "xhr", args: any[], res: any | undefined, started: number, _err?: any) {
  if (!current || !current.sampled) return;
  // guard: only emit if user explicitly enabled captureFetch/XHR
  if (!current.config.captureFetch && !current.config.captureXHR) return;
  try {
    let url = ""; let method = "GET"; let status: number | undefined; let ok: boolean | undefined;
    if (kind === "fetch") { const [input, init] = args as [RequestInfo, RequestInit | undefined]; url = typeof input === "string" ? input : (input as Request).url; method = (init?.method || (typeof input !== "string" && (input as Request).method) || "GET").toUpperCase(); status = (res as any)?.status; ok = (res as any)?.ok; }
    else { method = (args[0] || "GET").toUpperCase(); url = args[1] || ""; status = (res as any)?.status; ok = (res as any)?.ok; }
    const duration = Math.max(0, now() - started);
    const ev: RumEvent = { type: "network", ts: now(), sessionId: current!.sessionId, deviceId: current!.deviceId, seq: nextSeq(), context: baseContext(), data: { kind, url: originAndPath(url), method, status, ok, duration } } as any;
    dispatch(ev);
  } catch {}
}

// ===================== Resources & Long Tasks =====================
function observeResources(maxCount: number) {
  if (!("PerformanceObserver" in window)) return;
  try {
    const entries: PerformanceResourceTiming[] = [];
    const obs = new PerformanceObserver((list) => {
      const arr = list.getEntries().filter(e => (e as PerformanceEntry).entryType === "resource") as PerformanceResourceTiming[];
      entries.push(...arr);
    });
    obs.observe({ entryTypes: ["resource"] });
    current?.unsubscribers.push(() => { try { obs.disconnect(); } catch {} });

    const int = setInterval(() => {
      if (!current || !current.sampled) return;
      const copy = entries.splice(0, entries.length);

      // Optional: drop beacons & our own /rum calls
      const epBase = originAndPath((current?.config.endpoint || DEFAULT_ENDPOINT));
      const filtered = current!.config.ignoreSelfResources
        ? copy.filter((r: any) => {
            const nameBase = originAndPath(r.name || '');
            const isBeacon = (r as any).initiatorType === 'beacon';
            const isSelf = nameBase.startsWith(epBase) || nameBase.endsWith('/rum');
            return !isBeacon && !isSelf;
          })
        : copy;

      filtered.sort((a, b) => (b.duration || 0) - (a.duration || 0));
      const top = filtered.slice(0, maxCount);

      for (const r of top) {
        const ev: RumEvent = {
          type: "resource",
          ts: now(),
          sessionId: current!.sessionId,
          deviceId: current!.deviceId,
          seq: nextSeq(),
          context: baseContext(),
          data: {
            name: originAndPath((r as any).name),
            initiatorType: (r as any).initiatorType,
            duration: (r as any).duration,
            transferSize: (r as any).transferSize
          }
        } as any;
        dispatch(ev);
      }
    }, 15000);
    current?.unsubscribers.push(() => clearInterval(int as any));
  } catch {}
}

function observeLongTasks() {
  if (!("PerformanceObserver" in window)) return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const anyE: any = e as any;
        const ev: RumEvent = {
          type: "long_task",
          ts: now(),
          sessionId: current!.sessionId,
          deviceId: current!.deviceId,
          seq: nextSeq(),
          context: baseContext(),
          data: { name: anyE.name, duration: e.duration }
        } as any;
        dispatch(ev);
      }
    });
    // @ts-ignore
    obs.observe({ entryTypes: ["longtask"] });
    current?.unsubscribers.push(() => { try { obs.disconnect(); } catch {} });
  } catch {}
}

// ===================== Web Vitals (safe dynamic import) =====================
async function attachWebVitals() {
  try {
    // Avoid hard dep; also avoid pre-bundle
    // @ts-ignore
    const dynImport = new Function('m', 'return import(/* @vite-ignore */ m)');
    const mod: any = await (dynImport as any)('web-vitals').catch(() => null);
    if (!mod) return;
    const send = (m: { id: string; name: string; value: number }) => {
      if (!current || !current.sampled) return;
      const ev: RumEvent = { type: "web_vital", ts: now(), sessionId: current!.sessionId, deviceId: current!.deviceId, seq: nextSeq(), context: baseContext(), data: { id: m.id, name: m.name, value: m.value } } as any;
      dispatch(ev);
    };
    mod.onCLS?.(send); mod.onLCP?.(send); mod.onFID?.(send); mod.onINP?.(send); mod.onTTFB?.(send);
  } catch {}
}

// ===================== Path Normalization =====================
function computeNormalizedPath(pathname: string): string {
  if (current?.config.getNormalizedPath) { try { return current.config.getNormalizedPath(pathname); } catch {} }
  // Fallback to literal pathname when no normalizer is set
  return pathname || "/";
}
export function setRouteManifest(routes: any[]) {
  if (current) (current as any).config.routeManifest = routes; else pendingRouteManifest = routes;
  routeManifestReady = true;
}
export function setPathNormalizer(fn: (p: string) => string) {
  if (current) (current as any).config.getNormalizedPath = fn; else pendingPathNormalizer = fn;
}

// ===================== React Bindings =====================
const RumCtx = createContext<RumPublicAPI | null>(null);

export function RumProvider({ config, children }: { config?: RumConfig; children: React.ReactNode }) {
  const api = useMemo(() => startRum(config), []);
  useEffect(() => {
    const onPop = () => api.trackPageView(undefined, "popstate");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [api]);
  return <RumCtx.Provider value={api}>{children}</RumCtx.Provider>;
}

export function useRUM(): RumPublicAPI { const ctx = useContext(RumCtx); return ctx || publicAPI; }

// Legacy helper: only sends page_view (no template detection)
export function useTrackReactRouter() {
  try {
    const { useLocation, useNavigationType } = require("react-router-dom");
    const { trackPageView } = useRUM();
    const location = useLocation();
    const navType = useNavigationType?.();
    useEffect(() => { trackPageView(undefined, navType); }, [location?.pathname, navType]);
  } catch {/* RRD not present */}
}

// ===================== WatchlogRoutes (ESM-safe dynamic import) =====================
// Vite/webpack can transform this dynamic import (no @vite-ignore here)
const dynImportRRD: Promise<any> = import('react-router-dom')

function RoutesWithRRD({ rrd, children, track }: { rrd: any; children: React.ReactNode; track: boolean }) {
  const { useLocation, useNavigationType, createRoutesFromChildren, matchRoutes, Routes } = rrd;
  const { trackPageView } = useRUM();

  // Manifest + normalizer
  const manifest = React.useMemo(() => createRoutesFromChildren(children), [children]);
  useEffect(() => {
    setRouteManifest(manifest as any[]);
    setPathNormalizer((pathname: string) => {
      try {
        const matches = matchRoutes(manifest as any, { pathname }) || [];
        if (matches.length) {
          const tpl: string | undefined = (matches[matches.length - 1] as any)?.route?.path;
          if (tpl && tpl !== '*' && tpl !== '/*') return tpl.startsWith('/') ? tpl : `/${tpl}`;
        }
      } catch {}
      return pathname || '/';
    });
  }, [manifest, matchRoutes]);

  // page_view on navigation
  const location = useLocation();
  const navType = useNavigationType?.();
  useEffect(() => { if (track) trackPageView(undefined, navType); }, [track, location?.pathname, navType, trackPageView]);

  const RoutesCmp = Routes as React.ComponentType<{ children: any }>;
  return <RoutesCmp>{children as any}</RoutesCmp>;
}

export function WatchlogRoutes({ children, track = true }: { children: React.ReactNode; track?: boolean }) {
  const [rrd, setRrd] = React.useState<any | null>(null);
  useEffect(() => {
    let alive = true;
    dynImportRRD.then(mod => { if (alive) setRrd(mod); }).catch(() => setRrd(null));
    return () => { alive = false; };
  }, []);
  if (!rrd) return null;
  return <RoutesWithRRD rrd={rrd} track={track}>{children}</RoutesWithRRD>;
}

// Convenience re-exports
export const trackPageView = publicAPI.trackPageView;
export const trackEvent = publicAPI.trackEvent;
export const identify = publicAPI.identify;
export const setContext = publicAPI.setContext;
export const trackError = publicAPI.trackError;
export const flush = publicAPI.flush;
export const shutdown = publicAPI.shutdown;
export const getSessionInfo = publicAPI.getSessionInfo;
