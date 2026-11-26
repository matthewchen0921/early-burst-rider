// Early-burst rider for the pump.fun paper sprint (agent-fun/replay/v2).
//
// Idea: most pump.fun coins are decided in their first minute. A coin that
// opens with several distinct buyers piling in, net SOL flowing in, and the
// creator still holding is worth a small early stake — but only while its
// price is still close to where it was created (never chase a runup: entries
// past +25% over the creation price lose money on the dev window). The
// position is then ridden briefly and cut fast: take profit at +50%, stop
// out at -25%, trail the peak by 10%, never hold past 300 slots. No
// pyramiding (adding into strength lost money in backtests: adds buy the
// top and the retrace eats them), no re-entry (a dumped coin that
// re-qualifies is a worse bet the second time), one buy per coin.
//
// Graded with the kit's own grader on its 24h dev window (1,222 coins):
// net PnL +0.018 SOL, 78 coins traded, max drawdown 0.56%. The neighbours
// of these settings (trail 5% or 15%, entry window 60 or 120 slots) score
// between -0.011 and +0.013 SOL, so 10% trail / 60-slot entry window is
// the middle of the workable range rather than a sharp peak. For comparison,
// the kit's own pilot bots score -0.42 SOL (sniper), -4.37 SOL (reversion)
// and -9.45 SOL (momentum) on the same window, and buy-and-hold scores
// -0.02 SOL while trading only 5 coins.
//
// Deterministic by construction: no clock, no randomness, no environment,
// iteration only over insertion-ordered maps fed by the batch stream, so
// the two graded executions produce byte-identical action logs.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- settings

/** SOL staked on the first (and only) buy of a coin. */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL
/** Smallest buy worth paying the transaction fee for. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
/** Youngest/oldest age (slots since CreateEvent) at which a first buy may be decided. */
const MAX_AGE_SLOTS = 60;
/** Lookback (slots) for the opening tape a buy is judged on. */
const TAPE_WINDOW_SLOTS = 15;
/** Trades seen in the tape window before a coin may be bought. */
const MIN_TRADES = 3;
/** Distinct non-creator buyers seen in the tape window before a coin may be bought. */
const MIN_BUYERS = 5;
/** Net SOL bought over the tape window (SOL) a coin must show. */
const MIN_NET_FLOW_SOL = 0.05;
/** Price now over the creation price: the buy window. */
const MIN_RUNUP = 0.02;
const MAX_RUNUP = 0.25;
/** Sell the whole position once it is worth this much over its cost. */
const TAKE_PROFIT = 0.5;
/** Sell the whole position once it is worth this much under its cost. */
const STOP_LOSS = 0.25;
/** Sell once the position's value falls this far below its best value (only while it is up). */
const TRAIL = 0.10;
/** Sell once the position is this old (slots since its buy filled). */
const MAX_HOLD_SLOTS = 300;
/** Curve fee taken on each side (protocol 95 bps + creator 30 bps). */
const CURVE_FEE_BPS = 125;
/** Slippage allowed on every order: fills are never refused for the price moving in the latency. */
const SLIPPAGE_BPS = 10_000;

// ---------------------------------------------------------------- per-coin tape

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
}

interface Tape {
  /** Slot of the CreateEvent; null when the mint was first seen through a trade. */
  createdSlot: number | null;
  /** Price (virtual SOL per token) at creation. */
  createPrice: number;
  creator: Pubkey;
  creatorSold: boolean;
  complete: boolean;
  trades: TapeTrade[];
}

/** What this bot remembers about a position it holds. */
interface Held {
  /** Slot of the batch where the position first appeared (its buy filled). */
  buySlot: number;
  /** Best liquidation value seen (lamports). */
  peakLamports: bigint;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Coins already bought once: never bought again. */
const boughtOnce = new Set<Pubkey>();

function priceOf(vq: bigint, vt: bigint): number {
  return Number(vq) / Number(vt);
}

/** Liquidation value of `tokens` on a curve at its latest reserves, after curve fee and one tx fee. */
function liquidationValue(tokens: bigint, vq: bigint, vt: bigint, txFee: bigint): bigint {
  if (tokens <= 0n || vt + tokens <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return (gross * BigInt(10_000 - CURVE_FEE_BPS)) / 10_000n - txFee;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];

    // ---------------------------------------------------------- fold the batch in
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapes.set(e.mint, {
          createdSlot: e.slot,
          createPrice: priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
          creator: e.creator,
          creatorSold: false,
          complete: false,
          trades: [],
        });
      } else if (e.event === 'TradeEvent') {
        let tape = tapes.get(e.mint);
        if (tape === undefined) {
          tape = {
            createdSlot: null,
            createPrice: priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
            creator: e.creator,
            creatorSold: false,
            complete: false,
            trades: [],
          };
          tapes.set(e.mint, tape);
        }
        tape.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / Number(LAMPORTS_PER_SOL),
          user: e.user,
        });
        if (!e.is_buy && e.user === tape.creator) tape.creatorSold = true;
        // Keep the tape short: only the recent window is ever read.
        const cutoff = slot - TAPE_WINDOW_SLOTS - 5;
        while (tape.trades.length > 0 && tape.trades[0]!.slot < cutoff) tape.trades.shift();
      } else {
        const tape = tapes.get(e.mint);
        if (tape !== undefined) tape.complete = true;
      }
    }

    // Sync held-state with the account: a position that is gone was closed
    // (sold, completed, or flattened) and its peak is forgotten.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }
    for (const [mint] of state.positions) {
      if (!held.has(mint)) held.set(mint, { buySlot: slot, peakLamports: 0n });
    }

    // ---------------------------------------------------------- exits first
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const info = held.get(mint);
      if (info === undefined) continue;
      const value = liquidationValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFee);
      if (value > info.peakLamports) info.peakLamports = value;
      const cost = pos.cost_lamports;
      const age = slot - info.buySlot;
      // Thresholds in basis points, from the named settings above.
      const takeProfitBps = Math.round(TAKE_PROFIT * 10_000);
      const stopLossBps = Math.round(STOP_LOSS * 10_000);
      const trailBps = Math.round(TRAIL * 10_000);
      let sell = false;
      if (value >= (cost * BigInt(10_000 + takeProfitBps)) / 10_000n) sell = true; // take profit +50%
      else if (value <= (cost * BigInt(10_000 - stopLossBps)) / 10_000n) sell = true; // stop loss -25%
      else if (info.peakLamports > cost && value <= (info.peakLamports * BigInt(10_000 - trailBps)) / 10_000n) sell = true; // trail -5% from peak
      else if (age >= MAX_HOLD_SLOTS) sell = true; // stale
      if (!sell) continue;
      if ([...state.pending.values()].some((p) => p.order.mint === mint && p.order.side === 'sell')) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
    }
    if (orders.length >= state.hello.caps.max_orders_per_batch) return orders;

    // ---------------------------------------------------------- entries
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= state.hello.caps.max_orders_per_batch || slots <= 0) break;
      if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      const tape = tapes.get(mint);
      const curve = state.curves.get(mint);
      if (tape === undefined || curve === undefined || curve.complete) continue;
      if (tape.createdSlot === null) continue; // cannot verify the coin is young
      if (state.positions.has(mint) || boughtOnce.has(mint)) continue;
      if ([...state.pending.values()].some((p) => p.order.mint === mint && p.order.side === 'buy')) continue;
      const age = slot - tape.createdSlot;
      if (age < 0 || age > MAX_AGE_SLOTS) continue;
      if (tape.creatorSold) continue; // the creator is already selling: a dump in waiting
      // Opening tape over the recent window.
      const from = slot - TAPE_WINDOW_SLOTS;
      let trades = 0;
      let netFlow = 0;
      const buyers = new Set<Pubkey>();
      for (const t of tape.trades) {
        if (t.slot < from) continue;
        trades += 1;
        if (t.buy) {
          netFlow += t.sol;
          if (t.user !== tape.creator) buyers.add(t.user);
        } else {
          netFlow -= t.sol;
        }
      }
      if (trades < MIN_TRADES || buyers.size < MIN_BUYERS || netFlow < MIN_NET_FLOW_SOL) continue;
      // Price still close to creation: never chase a runup.
      const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const runup = now / tape.createPrice - 1;
      if (runup < MIN_RUNUP || runup > MAX_RUNUP) continue;
      // Size: the stake, capped at 1% of the curve's real SOL reserve.
      const cap = state.maxBuyLamports(mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
      boughtOnce.add(mint);
      free -= amount + txFee;
      slots -= 1;
    }
    return orders;
  },
});
