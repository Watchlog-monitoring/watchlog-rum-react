# @watchlog/rum-react — Watchlog RUM SDK for React

**Real User Monitoring (RUM) SDK for React**, built by **[Watchlog](https://watchlog.io)**.  
This package captures real-world performance and usage signals from your React app and streams them to the Watchlog backend (or your own receiver).

> Get your **`endpoint`** and **`apiKey`** from the Watchlog dashboard: **https://app.watchlog.io/rum**  
> Default SaaS endpoint is `https://api.watchlog.io/rum`.

---

## Highlights

- ✅ **Zero-config page views** using your **real React Router templates** (no regex guessing).  
  Use `<WatchlogRoutes>` and the SDK normalizes dynamic paths like `/user/:id`.
- ✅ **Works with React Router v6/v7** — resolved from your app at runtime (no hard dependency in the SDK).
- ✅ **Lightweight & privacy-friendly**: sampling, `beforeSend` hook for redaction, `sendBeacon` on unload.
- ✅ **Safe defaults**: network capture **off by default**, self-beacon resources skipped.
- ✅ **Batched transport** with backpressure limits to reduce overhead.

---

## Installation

```bash
# npm
npm i @watchlog/rum-react

# yarn
yarn add @watchlog/rum-react

# pnpm
pnpm add @watchlog/rum-react
```

> Peer requirements: **React 17+**. React Router is **optional** (only needed if you use `<WatchlogRoutes>`).

---

## Quick start (React Router)

```tsx
// src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Route } from 'react-router-dom'
import { RumProvider, WatchlogRoutes } from '@watchlog/rum-react'

import App from './App'
import User from './UserPage'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RumProvider
      config={{
        // Grab these from https://app.watchlog.io/rum
        endpoint: 'https://api.watchlog.io/rum',
        apiKey:    'YOUR_API_KEY',
        app:       'your-app-name',
        environment: 'production',

        // Optional, recommended
        sampleRate: 0.1,           // 10% sessions
        enableWebVitals: true,     // CLS/LCP/FID/INP/TTFB (if web-vitals is installed)
        captureResources: true,    // top resources (skips self /rum beacons)
        autoTrackInitialView: true // delay first PV until routes are ready
      }}
    >
      <BrowserRouter>
        <WatchlogRoutes>
          <Route path="/" element={<App />} />
          <Route path="/user/:id" element={<User />} />
        </WatchlogRoutes>
      </BrowserRouter>
    </RumProvider>
  </React.StrictMode>
)
```

**What you get:**  
- Automatic `page_view` on initial load and on each navigation.  
- `context.page.normalizedPath` will be the **template** (e.g., `/user/:id`).

---

## Without React Router (manual tracking)

If you don’t use React Router, you can still track views/events:

```tsx
import { RumProvider, useRUM } from '@watchlog/rum-react'

function App() {
  const { trackPageView, trackEvent } = useRUM()
  React.useEffect(() => {
    trackPageView() // initial
  }, [trackPageView])

  return <button onClick={() => trackEvent('clicked_buy', { plan: 'pro' })}>Buy</button>
}

export default function Root() {
  return (
    <RumProvider config={{ endpoint: 'https://api.watchlog.io/rum', apiKey: 'YOUR_API_KEY', app: 'my-app' }}>
      <App />
    </RumProvider>
  )
}
```

---

## Configuration

| Option | Type | Default | Description |
|---|---|---:|---|
| `endpoint` | `string` | `https://api.watchlog.io/rum` | RUM ingest URL (use your self-host if needed). |
| `apiKey` | `string` | `undefined` | **Required** for Watchlog ingest. Also included in **payload body** (works with `sendBeacon`). |
| `app` | `string` | `undefined` | Your app/service name (shown in dashboards). |
| `environment` | `string` | `undefined` | e.g. `production`, `staging`. |
| `release` | `string` | `undefined` | Release or commit SHA. |
| `userId` | `string` | `undefined` | Optional current user id. |
| `sampleRate` | `number` | `0.1` | Session sampling (0–1). |
| `batchMax` | `number` | `50` | Max events per batch. |
| `flushInterval` | `number (ms)` | `5000` | Auto flush interval. |
| `maxQueueBytes` | `number` | `256*1024` | Memory safety limit for queued payload JSON. |
| `captureErrors` | `boolean` | `true` | Global `error` + `unhandledrejection`. |
| `captureFetch` | `boolean` | `false` | **Opt-in**: capture `fetch` calls. |
| `captureXHR` | `boolean` | `false` | **Opt-in**: capture XHR calls. |
| `captureResources` | `boolean` | `true` | Periodically report top slow resources. |
| `maxResourceCount` | `number` | `50` | Max resources per flush window. |
| `captureLongTasks` | `boolean` | `false` | Long Task API (if supported). |
| `enableWebVitals` | `boolean` | `true` | Uses dynamic import of `web-vitals` if present. |
| `ignoreSelfResources` | `boolean` | `true` | Skips `/rum` beacons & endpoint calls from resource list. |
| `autoTrackInitialView` | `boolean` | `true` | Defers first PV until route manifest is ready (if using `<WatchlogRoutes>`). |
| `getNormalizedPath` | `(pathname) => string` | — | Custom normalizer if you don’t use `<WatchlogRoutes>`. |
| `beforeSend` | `(event) => event \| null` | — | Mutate/drop events (e.g., PII redaction). |

**Note:** `apiKey` is sent in both **request header** (`X-Watchlog-Key`, where supported) and in **payload body** (for `sendBeacon`).

---

## Events

- `page_view` — automatic via `<WatchlogRoutes>` or manual `trackPageView()`
- `web_vital` — CLS/LCP/FID/INP/TTFB (if `web-vitals` is installed in the app)
- `resource` — top slow resources (every ~15s) with initiator type/duration/size
- `long_task` — main thread long tasks (if available)
- `custom` — via `trackEvent(name, data?)`
- `error` — global `error` & `unhandledrejection` + `trackError(err)`

> **Network** events are available but **disabled by default**. Set `captureFetch: true` and/or `captureXHR: true` to opt in.

---

## API

```ts
import { useRUM } from '@watchlog/rum-react'

const {
  trackPageView,
  trackEvent,
  identify,
  setContext,
  trackError,
  flush,
  shutdown,
  getSessionInfo
} = useRUM()
```

Examples:

```ts
identify('user_123', { plan: 'pro', locale: 'en-US' })
setContext({ featureFlag: 'search-v2' })
trackEvent('clicked_buy', { plan: 'pro' })

try {
  doRiskyThing()
} catch (e) {
  trackError(e, 'checkout')
}
```

### Redact PII with `beforeSend`
```ts
<RumProvider
  config={{
    endpoint: 'https://api.watchlog.io/rum',
    apiKey: 'YOUR_API_KEY',
    app: 'my-app',
    beforeSend: (ev) => {
      // Drop custom events with sensitive names
      if (ev.type === 'custom' && ev.name?.startsWith('debug_')) return null
      // Redact query strings
      if (ev.context?.page?.url) {
        try {
          const u = new URL(ev.context.page.url)
          u.search = ''
          ev.context.page.url = u.toString()
        } catch {}
      }
      return ev
    }
  }}
>
  { /* ... */ }
</RumProvider>
```

---

## How it works (transport)

- Events are queued and flushed on a timer (`flushInterval`) or when `batchMax` is reached.
- On `unload/visibilitychange` the SDK uses **`navigator.sendBeacon`** when possible.
- Because `sendBeacon` **does not support custom headers**, the SDK also includes `apiKey` in the **payload body**. Your server can accept either header or body key.

Payload (simplified):
```json
{
  "sdk": "@watchlog/rum-react",
  "version": "0.2.x",
  "sentAt": 1730000000000,
  "apiKey": "YOUR_API_KEY",
  "sessionId": "uuid...",
  "deviceId": "uuid...",
  "app": "my-app",
  "environment": "production",
  "release": "1.2.3",
  "events": [ /* ... */ ]
}
```

---

## Troubleshooting

- **React Router error: _A <Route> is only ever to be used as the child of <Routes>_**  
  Make sure you render your routes **inside** `<WatchlogRoutes>`, and that it is nested under a `<BrowserRouter>`.

- **`react-router-dom` resolve error**  
  Install `react-router-dom` **in your app** (v6 or v7). The SDK dynamically imports RRD from the host app; it is not bundled into the SDK.

- **Vite dep-scan glitches**  
  If you updated the SDK locally, clear Vite cache: `rm -rf node_modules/.vite` and restart dev server.

- **No initial page_view**  
  If you render routes lazily, keep `autoTrackInitialView: true` so the SDK waits for the route manifest.

---

## Self-hosting

By default, events go to the Watchlog cloud ingest at `https://api.watchlog.io/rum`.  
You can self-host an ingest endpoint and set `config.endpoint` to your URL.

---

## Links

- Website: **https://watchlog.io**
- Dashboard: **https://app.watchlog.io/rum**

---

## License

MIT © Watchlog
