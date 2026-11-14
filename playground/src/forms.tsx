import {
  OrderServiceError,
  PreflightError,
  type AuthoredOrder,
  type LimitInput,
  type Network,
  type OrderLegInput,
  type OrderServiceClient,
} from "@tao.com/orders-sdk";
import { useState, type ReactNode } from "react";

import type { Wallet } from "./signers";

export interface Session {
  client: OrderServiceClient;
  wallet: Wallet;
  network: Network;
}

// ---- helpers ---------------------------------------------------------------

/** "1.5" → 1500000000n. Every amount and price here has 9 decimals (rao). */
export function toRao(text: string): bigint {
  const match = /^(\d*)(?:\.(\d{0,9}))?$/.exec(text.trim());
  if (match === null || text.trim() === "" || text.trim() === ".") throw new Error(`Not an amount: "${text}"`);
  return BigInt(match[1] || "0") * 1_000_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

export function fromRao(value: string | undefined): string {
  if (value === undefined || !/^\d+$/.test(value)) return value ?? "";
  const padded = value.padStart(10, "0");
  return `${padded.slice(0, -9)}.${padded.slice(-9)}`.replace(/\.?0+$/, "");
}

const pct = (text: string) => (text.trim() === "" ? undefined : Number(text) / 100);

export function errorText(error: unknown): string {
  if (error instanceof OrderServiceError) return `${error.message}\n${JSON.stringify(error.problem, null, 2)}`;
  if (error instanceof PreflightError) return `${error.message}\n${JSON.stringify(error.warnings, null, 2)}`;
  return error instanceof Error ? error.message : String(error);
}

export const Json = ({ value }: { value: unknown }) => <pre className="json">{JSON.stringify(value, null, 2)}</pre>;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Text(props: { label: string; value: string; set: (v: string) => void; placeholder?: string }) {
  return (
    <Field label={props.label}>
      <input value={props.value} placeholder={props.placeholder} onChange={(e) => props.set(e.target.value)} />
    </Field>
  );
}

/** One run of an action: busy flag, error, result. */
function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setStatus(label);
    try {
      await action();
      setStatus(undefined);
    } catch (e) {
      setError(errorText(e));
      setStatus(undefined);
    } finally {
      setBusy(false);
    }
  };
  const view = (
    <>
      {status !== undefined && <p className="muted">{status}…</p>}
      {error !== undefined && <pre className="error">{error}</pre>}
    </>
  );
  return { busy, run, view, setStatus };
}

// ---- legs ------------------------------------------------------------------

type Kind = "tao" | "root" | "alpha";
interface Leg {
  kind: Kind;
  netuid: string;
  hotkey: string;
}

const urn = (network: Network, leg: Leg) =>
  leg.kind === "tao"
    ? `urn:bittensor:${network}:native`
    : `urn:bittensor:${network}:alpha:${leg.kind === "root" ? 0 : Number(leg.netuid)}`;

const legInput = (network: Network, leg: Leg): OrderLegInput => ({
  currency: urn(network, leg),
  ...(leg.kind !== "tao" && leg.hotkey.trim() !== "" ? { address: leg.hotkey.trim() } : {}),
});

function LegEditor({ title, leg, set }: { title: string; leg: Leg; set: (leg: Leg) => void }) {
  return (
    <fieldset>
      <legend>{title}</legend>
      <Field label="Asset">
        <select value={leg.kind} onChange={(e) => set({ ...leg, kind: e.target.value as Kind })}>
          <option value="tao">TAO</option>
          <option value="root">Root (SN0)</option>
          <option value="alpha">Alpha</option>
        </select>
      </Field>
      {leg.kind === "alpha" && <Text label="Netuid" value={leg.netuid} set={(netuid) => set({ ...leg, netuid })} />}
      {leg.kind !== "tao" && (
        <Text
          label="Hotkey"
          value={leg.hotkey}
          set={(hotkey) => set({ ...leg, hotkey })}
          placeholder="default from settings"
        />
      )}
    </fieldset>
  );
}

/** Which leg carries the slippage bound, per the order type the service will pick. */
function slippageLeg(source: Leg, destination: Leg): "source" | "destination" | undefined {
  const sourceAlpha = source.kind !== "tao";
  const destinationAlpha = destination.kind !== "tao";
  if (!sourceAlpha && destinationAlpha) return destination.kind === "alpha" ? "destination" : undefined;
  if (sourceAlpha && !destinationAlpha) return source.kind === "alpha" ? "source" : undefined;
  if (sourceAlpha && destinationAlpha) return urnKey(source) !== urnKey(destination) ? "destination" : undefined;
  return undefined;
}
const urnKey = (leg: Leg) => (leg.kind === "root" ? "0" : leg.kind === "alpha" ? leg.netuid : "tao");

function Authored({ authored }: { authored: AuthoredOrder }) {
  return (
    <div className="result">
      <h4>
        Authored <code>{authored.order.type}</code>
        {authored.order.limit !== undefined && (
          <>
            {" "}
            · <code>{authored.order.limit.type}</code>
          </>
        )}
      </h4>
      {authored.warnings.length > 0 && <pre className="error">warnings: {JSON.stringify(authored.warnings, null, 2)}</pre>}
      {authored.quotes?.map((quote, i) => (
        <p key={i}>
          {quote.amount !== undefined &&
            `You get: ${quote.amount.map((a) => `${a.currency === "USD" ? a.value : fromRao(a.value)} ${a.currency.split(":").slice(-2).join(":")}`).join(" · ")}`}
          {quote.rate !== undefined && ` Rate now: ${quote.rate} TAO/α`}
          {quote.priceImpact !== undefined && ` · price impact ${(quote.priceImpact * 100).toFixed(2)}%`}
        </p>
      ))}
      <details>
        <summary>order, fees, instruction</summary>
        <Json value={{ order: authored.order, estimatedFees: authored.estimatedFees, quotes: authored.quotes, instruction: authored.instruction }} />
      </details>
    </div>
  );
}

// ---- market ----------------------------------------------------------------

export function MarketForm({ session, onPlaced }: { session: Session; onPlaced: () => void }) {
  const [source, setSource] = useState<Leg>({ kind: "tao", netuid: "", hotkey: "" });
  const [destination, setDestination] = useState<Leg>({ kind: "alpha", netuid: "1", hotkey: "" });
  const [side, setSide] = useState<"spend" | "receive">("spend");
  const [amount, setAmount] = useState("0.1");
  const [slippage, setSlippage] = useState("2");
  const [authored, setAuthored] = useState<AuthoredOrder>();
  const { busy, run, view } = useRun();

  const quote = () =>
    run("Authoring", async () => {
      setAuthored(undefined);
      const bound = pct(slippage);
      const where = bound === undefined ? undefined : slippageLeg(source, destination);
      const withBound = (leg: OrderLegInput, name: "source" | "destination") =>
        where === name ? { ...leg, limitPrice: bound } : leg;
      const src = withBound(legInput(session.network, source), "source");
      const dst = withBound(legInput(session.network, destination), "destination");
      const rao = toRao(amount);
      setAuthored(
        await session.client.authorOrder(
          side === "spend"
            ? { signerAddress: session.wallet.address, source: { ...src, amount: rao }, destination: dst }
            : { signerAddress: session.wallet.address, source: src, destination: { ...dst, amount: rao } },
        ),
      );
    });

  const place = () =>
    run("Signing and registering", async () => {
      if (authored === undefined) return;
      await session.client.submitAuthored(authored, { signer: session.wallet.signInstruction });
      setAuthored(undefined);
      onPlaced();
    });

  return (
    <section>
      <div className="legs">
        <LegEditor title="From" leg={source} set={setSource} />
        <LegEditor title="To" leg={destination} set={setDestination} />
      </div>
      <div className="row">
        <Field label="Amount is">
          <select value={side} onChange={(e) => setSide(e.target.value as "spend" | "receive")}>
            <option value="spend">what I spend</option>
            <option value="receive">what I receive</option>
          </select>
        </Field>
        <Text label="Amount" value={amount} set={setAmount} />
        <Text label="Max slippage %" value={slippage} set={setSlippage} />
      </div>
      <div className="row">
        <button disabled={busy} onClick={quote}>
          Quote
        </button>
        <button className="primary" disabled={busy || authored === undefined || authored.warnings.length > 0} onClick={place}>
          Sign & Place
        </button>
      </div>
      {view}
      {authored !== undefined && <Authored authored={authored} />}
    </section>
  );
}

// ---- limit -----------------------------------------------------------------

const PRODUCTS = [
  { id: "LIMIT_BUY", label: "Limit Buy", note: "Buy alpha when the price falls to the trigger. Add SL/TP to make it a linked plan." },
  { id: "TAKE_PROFIT", label: "Take Profit", note: "Sell alpha when the price rises to the trigger." },
  { id: "STOP_LOSS", label: "Stop Loss", note: "Sell alpha when the price falls to the trigger." },
  { id: "PROFIT_LOCK", label: "Profit Lock", note: "SL/TP on a stake you already hold. The service sizes it." },
  { id: "MARKET_BUY", label: "Market Buy + SL/TP", note: "Buy now, with exits on what it buys." },
] as const;
type Product = (typeof PRODUCTS)[number]["id"];

export function LimitForm({ session, onPlaced }: { session: Session; onPlaced: () => void }) {
  const [product, setProduct] = useState<Product>("LIMIT_BUY");
  const [netuid, setNetuid] = useState("1");
  const [hotkey, setHotkey] = useState("");
  const [amount, setAmount] = useState("0.1");
  const [trigger, setTrigger] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [slippage, setSlippage] = useState("2");
  const [expires, setExpires] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [authored, setAuthored] = useState<AuthoredOrder>();
  const { busy, run, view, setStatus } = useRun();

  const buy = product === "LIMIT_BUY" || product === "MARKET_BUY";
  const priced = product === "LIMIT_BUY" || product === "TAKE_PROFIT" || product === "STOP_LOSS";
  const exits = product === "LIMIT_BUY" || product === "MARKET_BUY" || product === "PROFIT_LOCK";

  const limit = (): LimitInput => {
    const legs = {
      ...(pct(stopLoss) !== undefined ? { stopLoss: { percentage: pct(stopLoss)! } } : {}),
      ...(pct(takeProfit) !== undefined ? { takeProfit: { percentage: pct(takeProfit)! } } : {}),
    };
    if (product === "PROFIT_LOCK") return { type: product, ...legs };
    const maxSlippage = pct(slippage) ?? 0;
    if (product === "MARKET_BUY") return { type: product, maxSlippage, ...legs };
    const limitRao = toRao(limitPrice);
    return {
      type: product,
      limitPrice: { value: limitRao },
      triggerPrice: { value: trigger.trim() === "" ? limitRao : toRao(trigger), currency: `urn:bittensor:${session.network}:native` },
      maxSlippage,
      ...(expires !== "" ? { expiresAt: new Date(expires) } : {}),
      ...(product === "LIMIT_BUY" ? legs : {}),
    };
  };

  const author = () =>
    run("Authoring", async () => {
      setAuthored(undefined);
      const tao = { currency: `urn:bittensor:${session.network}:native` };
      const alpha = {
        currency: `urn:bittensor:${session.network}:alpha:${Number(netuid)}`,
        ...(hotkey.trim() !== "" ? { address: hotkey.trim() } : {}),
      };
      const sized = product === "PROFIT_LOCK" ? {} : { amount: toRao(amount) };
      setAuthored(
        await session.client.authorOrder({
          signerAddress: session.wallet.address,
          source: buy ? { ...tao, ...sized } : { ...alpha, ...sized },
          destination: buy ? alpha : tao,
          limit: limit(),
        }),
      );
    });

  const place = () =>
    run("Signing", async () => {
      if (authored === undefined) return;
      await session.client.submitAuthored(authored, {
        signer: session.wallet.signInstruction,
        onComponentSigned: (_, signed) => setStatus(`Signed ${signed}, signing the next component`),
      });
      setAuthored(undefined);
      onPlaced();
    });

  return (
    <section>
      <nav className="subtabs">
        {PRODUCTS.map((p) => (
          <button
            key={p.id}
            className={p.id === product ? "active" : ""}
            onClick={() => {
              setProduct(p.id);
              setAuthored(undefined);
            }}
          >
            {p.label}
          </button>
        ))}
      </nav>
      <p className="muted">{PRODUCTS.find((p) => p.id === product)?.note}</p>
      <div className="row">
        <Text label="Netuid" value={netuid} set={setNetuid} />
        <Text label="Hotkey" value={hotkey} set={setHotkey} placeholder="default from settings" />
        {product !== "PROFIT_LOCK" && <Text label={buy ? "Spend TAO" : "Sell alpha"} value={amount} set={setAmount} />}
      </div>
      {priced && (
        <div className="row">
          <Text label="Trigger price (TAO per alpha)" value={trigger} set={setTrigger} placeholder="= limit price" />
          <Text label="Limit price (TAO per alpha)" value={limitPrice} set={setLimitPrice} />
          <Field label="Expires (optional)">
            <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
        </div>
      )}
      <div className="row">
        {product !== "PROFIT_LOCK" && <Text label="Max slippage %" value={slippage} set={setSlippage} />}
        {exits && <Text label="Stop loss %" value={stopLoss} set={setStopLoss} placeholder="none" />}
        {exits && <Text label="Take profit %" value={takeProfit} set={setTakeProfit} placeholder="none" />}
      </div>
      <div className="row">
        <button disabled={busy} onClick={author}>
          Author
        </button>
        <button className="primary" disabled={busy || authored === undefined || authored.warnings.length > 0} onClick={place}>
          Sign & Place
        </button>
      </div>
      {view}
      {authored !== undefined && <Authored authored={authored} />}
    </section>
  );
}

// ---- cross-chain -----------------------------------------------------------

export function CrossChainForm() {
  return (
    <section>
      <p className="muted">Cross-chain swaps are not in the SDK yet. This tab fills in when they are.</p>
    </section>
  );
}
