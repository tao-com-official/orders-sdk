import {
  createWalletAuth,
  OrderServiceClient,
  TERMINAL_ORDER_STATUSES,
  type Network,
  type Order,
  type OrderSummary,
  type Transaction,
} from "@tao.com/orders-sdk";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { CrossChainForm, errorText, fromRao, Json, LimitForm, MarketForm, type Session } from "./forms";
import { extensionAccounts, extensionWallet, installedExtensions, seedWallet, type Wallet } from "./signers";

const NETWORKS: Record<Network, { api: string; rpc: string; label: string }> = {
  testnet: { api: "/svc/dev", rpc: "wss://testnet.prod.tao.com", label: "testnet · api.dev.tao.com" },
  mainnet: { api: "/svc/prod", rpc: "wss://lite.prod.tao.com", label: "mainnet · api.tao.com" },
};

// Per-viewer conveniences only. The seed is never stored.
const saved = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(`playground.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(`playground.${key}`, value);
  } catch {
    // private window: fine
  }
};

// ---- request log -----------------------------------------------------------

interface LogEntry {
  id: number;
  at: string;
  method: string;
  path: string;
  status?: number;
  request?: unknown;
  response?: unknown;
}

let logId = 0;
const parse = (text: string | undefined) => {
  if (text === undefined || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** A fetch for the SDK that records each call. Auth calls are logged without their bodies: they hold tokens. */
function loggedFetch(push: (entry: LogEntry) => void): typeof fetch {
  return async (input, init) => {
    const url = new URL(input.toString(), location.origin);
    const secret = !url.pathname.includes("/orders/");
    const entry: LogEntry = {
      id: ++logId,
      at: new Date().toLocaleTimeString(),
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/svc\/(dev|prod)/, "") + (secret ? "" : url.search),
      ...(!secret && typeof init?.body === "string" ? { request: parse(init.body) } : {}),
    };
    const response = await fetch(input, init);
    const text = secret ? undefined : await response.clone().text();
    push({ ...entry, status: response.status, ...(text !== undefined ? { response: parse(text) } : {}) });
    return response;
  };
}

// ---- wallet ----------------------------------------------------------------

function Connect({ onSession }: { onSession: (session: Session) => void }) {
  const [network, setNetwork] = useState<Network>(saved("network", "testnet") as Network);
  const [method, setMethod] = useState(saved("method", "extension"));
  const [seed, setSeed] = useState("");
  const [extension, setExtension] = useState(saved("extension", ""));
  const [accounts, setAccounts] = useState<Awaited<ReturnType<typeof extensionAccounts>>>();
  const [account, setAccount] = useState("");
  const [hotkey, setHotkey] = useState(saved("hotkey", ""));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const extensions = installedExtensions();

  const loadAccounts = async (name: string) => {
    setExtension(name);
    setAccounts(undefined);
    setError(undefined);
    if (name === "") return;
    try {
      const found = await extensionAccounts(name);
      setAccounts(found);
      setAccount(found.accounts[0]?.address ?? "");
    } catch (e) {
      setError(errorText(e));
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { api, rpc } = NETWORKS[network];
      let wallet: Wallet;
      if (method === "seed") {
        wallet = await seedWallet(seed, rpc);
      } else {
        const chosen = accounts?.accounts.find((a) => a.address === account);
        if (accounts === undefined || chosen === undefined) throw new Error("Pick an extension and an account");
        wallet = extensionWallet(extension, accounts.injected, chosen, rpc);
      }
      const fetch = loggedFetch((e) => pushRef.current(e));
      const baseUrl = location.origin + api;
      const auth = createWalletAuth({ authBaseUrl: baseUrl, address: wallet.address, sign: wallet.signChallenge, fetch });
      await auth.getToken(); // sign in now, so a wrong wallet fails here and not on the first order
      const client = new OrderServiceClient({
        baseUrl,
        network,
        auth: () => auth.getToken(),
        fetch,
        ...(hotkey.trim() !== "" ? { hotkey: hotkey.trim() } : {}),
      });
      save("network", network);
      save("method", method);
      save("extension", extension);
      save("hotkey", hotkey.trim());
      setSeed("");
      onSession({ client, wallet, network });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Connect a wallet</h2>
      <div className="row">
        <label className="field">
          <span>Network</span>
          <select value={network} onChange={(e) => setNetwork(e.target.value as Network)}>
            {Object.entries(NETWORKS).map(([id, n]) => (
              <option key={id} value={id}>
                {n.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Wallet</span>
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="extension">Browser extension</option>
            <option value="seed">Seed phrase</option>
          </select>
        </label>
        <label className="field">
          <span>Default validator hotkey</span>
          <input value={hotkey} onChange={(e) => setHotkey(e.target.value)} placeholder="SS58, used when a leg has none" />
        </label>
      </div>
      {method === "seed" ? (
        <>
          {network === "mainnet" && (
            <p className="error">Mainnet with a seed typed into a browser page: use a throwaway test wallet only.</p>
          )}
          <label className="field">
            <span>Mnemonic (kept in memory only, cleared after connecting)</span>
            <textarea value={seed} onChange={(e) => setSeed(e.target.value)} rows={2} autoComplete="off" spellCheck={false} />
          </label>
        </>
      ) : extensions.length === 0 ? (
        <p className="muted">No Polkadot extension found. Install TAO.com, Talisman, SubWallet or polkadot.js and reload.</p>
      ) : (
        <div className="row">
          <label className="field">
            <span>Extension</span>
            <select value={extension} onChange={(e) => void loadAccounts(e.target.value)}>
              <option value="">choose…</option>
              {extensions.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          {accounts !== undefined && (
            <label className="field">
              <span>Account</span>
              <select value={account} onChange={(e) => setAccount(e.target.value)}>
                {accounts.accounts.map((a) => (
                  <option key={a.address} value={a.address}>
                    {a.name ?? ""} {a.address}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      <button className="primary" disabled={busy} onClick={connect}>
        {busy ? "Signing in…" : "Connect & sign in"}
      </button>
      {error !== undefined && <pre className="error">{error}</pre>}
    </section>
  );
}

// The log sink outlives the Connect form; App points it at its state.
const pushRef: { current: (e: LogEntry) => void } = { current: () => {} };

// ---- history ---------------------------------------------------------------

const short = (urn: string) => {
  const parts = urn.split(":");
  return parts[parts.length - 1] === "native" ? "TAO" : `α${parts[parts.length - 1]}`;
};

function History({ session, refresh }: { session: Session; refresh: number }) {
  const [tab, setTab] = useState<"orders" | "activity">("orders");
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [activity, setActivity] = useState<Transaction[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [detail, setDetail] = useState<Order>();
  const [error, setError] = useState<string>();
  const [loadedAt, setLoadedAt] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      if (tab === "orders") {
        const [market, limit] = await Promise.all([
          session.client.listOrders({ orderCategory: "BITTENSOR_MARKET", limit: 25 }),
          session.client.listOrders({ orderCategory: "BITTENSOR_LIMIT", limit: 25 }),
        ]);
        setOrders([...market.orders, ...limit.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      } else {
        const page = await session.client.listTransactions(session.wallet.address, { limit: 25 });
        setActivity(page.transactions);
        setCursor(page.nextCursor);
      }
      setLoadedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(errorText(e));
    }
  }, [session, tab]);

  useEffect(() => {
    void load();
  }, [load, refresh]);

  // Poll while something can still change.
  const live = tab === "orders" && orders.some((o) => !TERMINAL_ORDER_STATUSES.includes(o.status));
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [live, load]);

  const more = async () => {
    try {
      const page = await session.client.listTransactions(session.wallet.address, { limit: 25, cursor });
      setActivity((rows) => [...rows, ...page.transactions]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const open = async (id: string) => {
    try {
      setDetail(await session.client.getOrder(id));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const cancel = async (id: string) => {
    try {
      await session.client.cancelOrder(id);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <aside className="card">
      <div className="row spread">
        <nav className="subtabs">
          <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>
            Orders
          </button>
          <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
            Activity
          </button>
        </nav>
        <span className="muted">
          {live ? "live · " : ""}
          {loadedAt}
          <button onClick={() => void load()}>Refresh</button>
        </span>
      </div>
      {error !== undefined && <pre className="error">{error}</pre>}
      {tab === "orders" ? (
        <table>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} onClick={() => void open(o.id)}>
                <td>
                  <span className={`status ${o.status}`}>{o.status}</span>
                </td>
                <td>
                  {o.limit?.type ?? o.type}
                  <div className="muted">
                    {fromRao(o.source.amount)} {short(o.source.currency)} → {short(o.destination.currency)}
                  </div>
                </td>
                <td className="muted">{new Date(o.createdAt).toLocaleString()}</td>
                <td>
                  {o._links.cancel !== undefined && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void cancel(o.id);
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td className="muted">No orders yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <>
          <table>
            <tbody>
              {activity.map((t) => {
                const orderId = t._links?.order?.href.split("/").pop();
                return (
                  <tr key={t.id} onClick={() => orderId !== undefined && void open(orderId)}>
                    <td>
                      <span className={`status ${t.status}`}>{t.status}</span>
                    </td>
                    <td>
                      {t.activityType ?? t.type}
                      <div className="muted">
                        {t.source !== undefined && `${fromRao(t.source.amount)} ${short(t.source.currency)}`}
                        {t.destination !== undefined && ` → ${short(t.destination.currency)}`}
                      </div>
                    </td>
                    <td className="muted">{new Date(t.blockTimestamp ?? t.createdAt).toLocaleString()}</td>
                  </tr>
                );
              })}
              {activity.length === 0 && (
                <tr>
                  <td className="muted">No activity yet.</td>
                </tr>
              )}
            </tbody>
          </table>
          {cursor !== undefined && <button onClick={() => void more()}>More</button>}
        </>
      )}
      {detail !== undefined && (
        <div className="result">
          <div className="row spread">
            <h4>Order {detail.id}</h4>
            <button onClick={() => setDetail(undefined)}>Close</button>
          </div>
          <Json value={detail} />
        </div>
      )}
    </aside>
  );
}

// ---- app -------------------------------------------------------------------

const TABS = { market: "Market", limit: "Limit", crosschain: "Cross-chain" } as const;

function App() {
  const [session, setSession] = useState<Session>();
  const [tab, setTab] = useState<keyof typeof TABS>(saved("tab", "market") as keyof typeof TABS);
  const [refresh, setRefresh] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  pushRef.current = (entry) => setLog((rows) => [entry, ...rows].slice(0, 100));
  const placed = () => setRefresh((n) => n + 1);

  return (
    <>
      <header>
        <h1>Orders SDK Playground</h1>
        {session !== undefined && (
          <span className="muted">
            {session.network} · {session.wallet.label} · <code>{session.wallet.address}</code>{" "}
            <button onClick={() => setSession(undefined)}>Disconnect</button>
          </span>
        )}
      </header>
      {session === undefined ? (
        <main>
          <Connect onSession={setSession} />
        </main>
      ) : (
        <main className="grid">
          <div className="card">
            <nav className="tabs">
              {Object.entries(TABS).map(([id, label]) => (
                <button
                  key={id}
                  className={id === tab ? "active" : ""}
                  onClick={() => {
                    setTab(id as keyof typeof TABS);
                    save("tab", id);
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>
            {tab === "market" && <MarketForm session={session} onPlaced={placed} />}
            {tab === "limit" && <LimitForm session={session} onPlaced={placed} />}
            {tab === "crosschain" && <CrossChainForm />}
          </div>
          <History session={session} refresh={refresh} />
        </main>
      )}
      <section className="card log">
        <h3>Requests</h3>
        {log.map((e) => (
          <details key={e.id}>
            <summary>
              <span className="muted">{e.at}</span> {e.method} {e.path} <span className={`code c${String(e.status)[0]}`}>{e.status}</span>
            </summary>
            {e.request !== undefined && (
              <>
                <h5>request</h5>
                <Json value={e.request} />
              </>
            )}
            {e.response !== undefined && (
              <>
                <h5>response</h5>
                <Json value={e.response} />
              </>
            )}
          </details>
        ))}
      </section>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
