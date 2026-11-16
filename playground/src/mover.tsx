// Testnet market maker: move a subnet's pool up or down a step at a time, and watch an order's
// triggers against the spot price on a chart.

import type { Order, OrderComponent } from "@tao.com/orders-sdk";
import { useCallback, useEffect, useState } from "react";

import { addressOf, alphaPrice, movePrice, walletBalances } from "./chain";
import { errorText, fromRao, save, saved, toRao, type Session } from "./forms";

// The e2e suite's LIMIT_MOVER_HOTKEY: a testnet validator on netuid 10 other than the order hotkey.
const MOVER_HOTKEY = "5GpM9BDQTbY1Mgxpm3hLApjpBpy1NSssXnbzDuEJSiSgYyni";

export function MarketMaker({ session, onMoved }: { session: Session; onMoved: () => void }) {
  // ponytail: the mover's mnemonic sits in localStorage as asked, testnet only; a throwaway key.
  const [phrase, setPhrase] = useState(saved("mover.seed", ""));
  const [address, setAddress] = useState<string>();
  const [netuid, setNetuid] = useState(saved("mover.netuid", "10"));
  const [hotkey, setHotkey] = useState(saved("mover.hotkey", MOVER_HOTKEY));
  const [step, setStep] = useState(saved("mover.step", "1"));
  const [target, setTarget] = useState("");
  const [shown, setShown] = useState(false);
  const [spot, setSpot] = useState<bigint>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    setAddress(undefined);
    if (phrase.trim() === "") return;
    addressOf(phrase).then(
      (a) => {
        setAddress(a);
        setStatus(undefined);
        save("mover.seed", phrase.trim());
      },
      (e) => setStatus(errorText(e)),
    );
  }, [phrase]);

  const [balance, setBalance] = useState<string>();

  // Spot of the subnet and the mover's balance: free TAO, and its alpha on this hotkey and netuid.
  const readSpot = useCallback(() => {
    if (!/^\d+$/.test(netuid)) return;
    alphaPrice(session.rpc, Number(netuid)).then(setSpot, () => setSpot(undefined));
    if (address === undefined) return setBalance(undefined);
    walletBalances(session.rpc, address).then(
      ({ free, stakes }) => {
        const alpha = stakes.find((s) => s.netuid === Number(netuid) && s.hotkey === hotkey.trim())?.stake ?? 0n;
        setBalance(`${fromRao(String(free)) || "0"} TAO free · ${fromRao(String(alpha)) || "0"} α staked here`);
      },
      (e) => setBalance(errorText(e)),
    );
  }, [address, hotkey, netuid, session.rpc]);
  useEffect(readSpot, [readSpot]);

  if (session.network !== "testnet") return null;

  // `percent` of the spot, or (`"target"`) as far as it takes to reach the target price.
  const move = async (by: number | "target") => {
    setBusy(true);
    setStatus("Moving the pool, waiting for the block…");
    save("mover.seed", phrase.trim());
    save("mover.netuid", netuid);
    save("mover.hotkey", hotkey.trim());
    save("mover.step", step);
    try {
      const percent =
        by === "target"
          ? (Number(toRao(target)) / Number(await alphaPrice(session.rpc, Number(netuid))) - 1) * 100
          : by;
      const { before, after } = await movePrice(session.rpc, phrase, hotkey.trim(), Number(netuid), percent);
      readSpot();
      const moved = ((Number(after) / Number(before) - 1) * 100).toFixed(2);
      setStatus(`${fromRao(String(before))} → ${fromRao(String(after))} TAO per alpha (${moved}%)`);
      onMoved();
    } catch (e) {
      setStatus(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h3>Market maker (testnet)</h3>
      <p className="muted">
        Moves the pool with its own account: ↑ stakes TAO, ↓ unstakes alpha on the hotkey below. The key is kept in this
        browser's localStorage, so use a testnet-only account.
      </p>
      <label className="field">
        <span>Mover mnemonic {address !== undefined && <code>{address}</code>}</span>
        <div className="row">
          <input
            type={shown ? "text" : "password"}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" title={shown ? "Hide" : "Show"} aria-label={shown ? "Hide mnemonic" : "Show mnemonic"} onClick={() => setShown((v) => !v)}>
            {shown ? "🙈" : "👁"}
          </button>
        </div>
      </label>
      {balance !== undefined && <p className="muted">Mover balance: {balance}</p>}
      <div className="row">
        <label className="field">
          <span>Netuid</span>
          <input value={netuid} onChange={(e) => setNetuid(e.target.value)} />
        </label>
        <label className="field">
          <span>Hotkey</span>
          <input value={hotkey} onChange={(e) => setHotkey(e.target.value)} />
        </label>
        <label className="field">
          <span>Step %</span>
          <input value={step} onChange={(e) => setStep(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button disabled={busy || address === undefined} onClick={() => void move(Number(step))}>
          ↑ {step}%
        </button>
        <button disabled={busy || address === undefined} onClick={() => void move(-Number(step))}>
          ↓ {step}%
        </button>
        <span className="muted">
          Spot: {spot !== undefined ? `${fromRao(String(spot))} TAO per alpha` : "…"}{" "}
          <button onClick={readSpot}>↻</button>
        </span>
      </div>
      <div className="row">
        <label className="field">
          <span>Target price (TAO per alpha)</span>
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={spot !== undefined ? fromRao(String(spot)) : ""} />
        </label>
        <button disabled={busy || address === undefined || target.trim() === ""} onClick={() => void move("target")}>
          Move to price
        </button>
      </div>
      {status !== undefined && <p className="muted">{status}</p>}
    </section>
  );
}

// ---- chart -----------------------------------------------------------------

/** A limit component fires when the spot falls to its trigger (buy, stop loss) or rises to it (take profit). */
const firesAbove = (c: OrderComponent) => c.limit?.type === "TAKE_PROFIT" || c.role === "TAKE_PROFIT";

/** Spot of the order's subnet over time, against each component's TAO trigger. Polls while open. */
export function PriceChart({ session, order }: { session: Session; order: Order }) {
  const alpha = [order.source.currency, order.destination.currency].find((c) => c.includes(":alpha:"));
  const netuid = alpha !== undefined ? Number(alpha.split(":").pop()) : undefined;
  const [series, setSeries] = useState<bigint[]>([]);

  useEffect(() => {
    setSeries([]);
    if (netuid === undefined) return;
    const read = () =>
      alphaPrice(session.rpc, netuid).then(
        (p) => setSeries((s) => [...s, p].slice(-120)),
        () => undefined,
      );
    void read();
    const timer = setInterval(read, 3000);
    return () => clearInterval(timer);
  }, [netuid, order.id, session.rpc]);

  const legs = (order._embedded?.components ?? []).filter(
    (c) => c.limit?.triggerPrice !== undefined && c.limit.triggerPrice.currency !== "USD",
  );
  if (netuid === undefined || legs.length === 0) return null;
  const spot = series[series.length - 1];

  const values = [...series, ...legs.map((c) => BigInt(c.limit!.triggerPrice!.value))].map(Number);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || hi || 1) * 0.15;
  const [W, H, L] = [600, 200, 4];
  const y = (v: number) => H - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * H;
  const x = (i: number) => L + (i / Math.max(series.length - 1, 1)) * (W - L - 150);

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Spot price against the order's triggers">
        {legs.map((c) => {
          const v = Number(c.limit!.triggerPrice!.value);
          const crossed = spot !== undefined && (firesAbove(c) ? Number(spot) >= v : Number(spot) <= v);
          return (
            <g key={c.role} className={crossed ? "crossed" : "waiting"}>
              <line x1={L} x2={W - 150} y1={y(v)} y2={y(v)} />
              <text x={W - 146} y={y(v) + 4}>
                {c.role} {fromRao(String(v))}
                {crossed ? " ✓" : ""}
              </text>
            </g>
          );
        })}
        {series.length > 0 && (
          <polyline className="spot" points={series.map((p, i) => `${x(i)},${y(Number(p))}`).join(" ")} />
        )}
      </svg>
      <p className="muted">
        netuid {netuid} spot: {spot !== undefined ? fromRao(String(spot)) : "…"} TAO per alpha · ✓ = the spot is past
        that trigger
      </p>
    </div>
  );
}
