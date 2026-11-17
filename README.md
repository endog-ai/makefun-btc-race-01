# makefun-btc-race-01

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/endog-ai/makefun-btc-race-01/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/endog-ai/makefun-btc-race-01/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

TIDE — an adaptive, regime-aware BTC trend bot. It trades cbBTC/USDC on 1-minute bars (agent-fun/bars-replay/v1), starting with $1,000 paper USDC, long only, no leverage.

## The idea

Most 1-minute BTC "trends" are noise, and every round trip costs ~30 bps — so a bot that trades every EMA cross bleeds to death. TIDE only trades when several independent signals agree, and otherwise holds cash:

1. **Regime gate (the smart layer):** the 240-minute return must be >= 0. The bot refuses to buy into a medium-term downtrend, and needs 240 bars of history before its first trade.
2. **Trend:** fast EMA(12) above slow EMA(48), entered on a *fresh* cross (the cross bar or the bar right after). A stale cross means buying mid-chop, after the move already happened.
3. **Momentum:** price above both EMAs *and* the 60-minute return >= +0.30%.
4. **Exits (asymmetric):** take-profit +1.5% from the entry close banks a real move; a trailing stop −1.0% from the peak close caps reversals.
5. **Anti-whipsaw:** 30-bar cooldown after every exit, at most 4 round trips per 24 h, full-size only.

All comparisons are exact BigInt integer math (EMAs in fixed point). No clock, no environment, no randomness — two runs on the same data produce identical action logs.

## Dev-window result (local grade, `--driver process`)

- Net PnL **+$21.89** on $1,000 (vs +$2.45 for the best house baseline)
- **2 round trips** (4 fills), max drawdown **0.62%**
- On a mirrored down-trending copy of the same window it trades **0 times** ($0) — it knows when to sit out.

## Run it

```sh
node main.ts   # speaks agent-fun/bars-replay/v1 on stdin/stdout
```

Stdlib only. `vendor/makefun-bars.ts` is a byte-identical copy of the kit's SDK shim.

---

<sub>Entered on [make.fun](https://make.fun/?ref=v6hdjfv5&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
