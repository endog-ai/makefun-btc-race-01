// TIDE v2 — an adaptive, regime-aware BTC trend bot (agent-fun/bars-replay/v1).
//
// Idea: a smart bot knows when to sit out and when to go. Most 1-minute BTC
// "trends" are noise: EMA crosses fire all day in chop, and every round trip
// costs ~30 bps, so a bot that trades them all bleeds to death. TIDE only
// trades when several independent signals agree, and otherwise holds cash:
//
//   1. REGIME (the smart layer): the 240-minute return must be >= 0. The bot
//      refuses to buy into a medium-term downtrend. On a mirrored down-window
//      this keeps it in cash the whole day (0 trades, $0) instead of catching
//      falling knives. It also needs 240 bars of history before its first trade.
//   2. TREND: fast EMA(12) above slow EMA(48), entered on a FRESH cross (the
//      cross bar or the bar right after). Buying a stale cross means buying
//      mid-chop, after the move already happened.
//   3. MOMENTUM: price above both EMAs AND the 60-minute return >= +0.30%.
//      One hour of real upward drift, not a one-minute spike.
//   4. EXITS (asymmetric, the edge): take-profit +1.5% from the entry close
//      banks a real move; a trailing stop -1.0% from the peak close caps the
//      damage when a trend reverses. Wins are ~2x the losses.
//   5. ANTI-WHIPSHAW: 30-bar cooldown after every exit, at most 4 round trips
//      per 24 h, full-size only (no scaling in/out — every fill costs).
//
// All comparisons are exact BigInt integer math (EMAs in fixed point, scale
// 1e6). No clock, no environment, no randomness: two runs on the same data
// produce identical action logs.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- strategy parameters (conventional values, not fitted) ---
const EMA_FAST = 12;
const EMA_SLOW = 48;
const MIN_BARS = 240; // bars of history before the first trade (240-min regime)
const RET60_NUM = 1003n; // 60-min return >= +0.30%  <=> close*1000 >= close60*1003
const RET60_DEN = 1000n;
const TP_NUM = 1015n; // take-profit +1.5%  <=> close*1000 >= entry*1015
const TP_DEN = 1000n;
const TRAIL_NUM = 99n; // trailing stop -1.0%  <=> close*100 <= peak*99
const TRAIL_DEN = 100n;
const FRESH_WINDOW = 1; // enter on the cross bar or the bar right after it
const COOLDOWN_BARS = 30;
const MAX_TRIPS = 4;
const MAX_SLIPPAGE_BPS = 150;
const SCALE = 1000000n; // fixed-point scale for EMAs

type Tide = {
  closes: bigint[];
  emaFast: bigint | null; // scaled by SCALE
  emaSlow: bigint | null; // scaled by SCALE
  prevAbove: boolean | null;
  lastCross: number; // bar index of the last fresh cross up
  inPos: boolean;
  entryClose: bigint; // close at the entry-decision bar
  peakClose: bigint; // highest close since entry
  coolUntil: number; // bar index; no entry before this
  trips: number; // completed round trips (exits decided)
  pendingBuyId: string | null;
  pendingSellId: string | null;
  savedEntry: bigint; // entry/peak saved across a pending sell (restore on reject)
  savedPeak: bigint;
  orderNo: number;
};

function freshTide(): Tide {
  return {
    closes: [],
    emaFast: null,
    emaSlow: null,
    prevAbove: null,
    lastCross: -1000000,
    inPos: false,
    entryClose: 0n,
    peakClose: 0n,
    coolUntil: -1,
    trips: 0,
    pendingBuyId: null,
    pendingSellId: null,
    savedEntry: 0n,
    savedPeak: 0n,
    orderNo: 0,
  };
}

/** EMA update in fixed point: ema' = (2*price + (n-1)*ema) / (n+1), all scaled by SCALE. */
function emaUpdate(prevScaled: bigint | null, priceRaw: bigint, n: number): bigint {
  if (prevScaled === null) return priceRaw * SCALE;
  const nn = BigInt(n);
  return (2n * priceRaw * SCALE + (nn - 1n) * prevScaled) / (nn + 1n);
}

const tide = freshTide();

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // gap minute: nothing to learn, nothing to do
    const close = BigInt(bar.c);

    // --- always update indicator state, even before trading is allowed ---
    tide.closes.push(close);
    const idx = tide.closes.length - 1;
    tide.emaFast = emaUpdate(tide.emaFast, close, EMA_FAST);
    tide.emaSlow = emaUpdate(tide.emaSlow, close, EMA_SLOW);
    const above = (tide.emaFast as bigint) > (tide.emaSlow as bigint);
    if (tide.prevAbove !== null && above && !tide.prevAbove) tide.lastCross = idx;
    tide.prevAbove = above;

    // --- reconcile pending orders against this batch's fills ---
    for (const f of batch.fills) {
      if (tide.pendingBuyId !== null && f.client_id === tide.pendingBuyId) {
        tide.pendingBuyId = null;
        if (f.status === 'rejected') {
          // buy never filled: we hold no position
          tide.inPos = false;
          tide.entryClose = 0n;
          tide.peakClose = 0n;
        }
      }
      if (tide.pendingSellId !== null && f.client_id === tide.pendingSellId) {
        tide.pendingSellId = null;
        if (f.status === 'rejected') {
          // sell never filled: we still hold the position; undo the exit
          tide.inPos = true;
          tide.entryClose = tide.savedEntry;
          tide.peakClose = tide.savedPeak;
          tide.trips -= 1;
          tide.coolUntil = -1;
        }
      }
    }

    if (state.warmingUp) return []; // warm-up bars build history only
    if (idx < MIN_BARS) return []; // need 240 bars before the first trade

    // --- exit: take-profit or trailing stop (checked on every close while in) ---
    if (tide.inPos) {
      if (close > tide.peakClose) tide.peakClose = close;
      const takeProfit = close * TP_DEN >= tide.entryClose * TP_NUM;
      const trailingStop = close * TRAIL_DEN <= tide.peakClose * TRAIL_NUM;
      if (takeProfit || trailingStop) {
        const held = state.positions.get(SYMBOL);
        const qty = held === undefined ? 0n : held.qty;
        if (qty <= 0n) {
          tide.inPos = false;
          return [];
        }
        tide.savedEntry = tide.entryClose;
        tide.savedPeak = tide.peakClose;
        tide.inPos = false;
        tide.trips += 1;
        tide.coolUntil = idx + COOLDOWN_BARS;
        const id = `tide-s${++tide.orderNo}`;
        tide.pendingSellId = id;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id }];
      }
      return [];
    }

    // --- entry: all signals must agree ---
    if (idx < tide.coolUntil) return [];
    if (tide.trips >= MAX_TRIPS) return [];
    if (!above) return [];
    if (close * SCALE <= (tide.emaFast as bigint)) return []; // price above fast EMA
    if (close * SCALE <= (tide.emaSlow as bigint)) return []; // price above slow EMA
    const close60 = tide.closes[idx - 60];
    if (close * RET60_DEN < close60 * RET60_NUM) return []; // 60-min return >= +0.30%
    const close240 = tide.closes[idx - 240];
    if (close < close240) return []; // regime: 240-min return >= 0
    if (idx - tide.lastCross > FRESH_WINDOW) return []; // fresh cross only
    const room = state.weightRoom(SYMBOL);
    let notional = state.cash < room ? state.cash : room;
    if (notional <= 0n) return [];
    tide.inPos = true;
    tide.entryClose = close;
    tide.peakClose = close;
    const id = `tide-b${++tide.orderNo}`;
    tide.pendingBuyId = id;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id }];
  },
});
