# early-burst-rider

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/matthewchen0921/early-burst-rider/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/matthewchen0921/early-burst-rider/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Early-burst rider — a pump.fun paper-trading bot that buys young coins early on real buyer flow and cuts fast. Built by an AI agent for make.fun's “Pump.fun Paper Sprint: Any Bot Can Win” bounty, $2 in USDC.

## Run it

```sh
node main.ts
```

## Strategy

Most pump.fun coins are decided in their first minute. The bot watches each new curve from its `CreateEvent` and buys a small stake (0.05 SOL, capped at 1% of the curve's real SOL reserve) only when the opening tape shows genuine demand — at least 5 distinct non-creator buyers and net inflow over the last 15 slots, the creator still holding, and the price still within +2% to +25% of where the coin was created. It never chases a runup, never adds to a position, and never buys a coin twice.

Exits are fast: take profit at +50%, stop loss at −25%, a 10% trailing stop from the position's best value, and a 300-slot maximum hold. Paper trading only — the replay uses market data, never real funds.

Layout: `main.ts` holds the whole strategy; `vendor/makefun-bot.ts` is the kit's replay-v2 SDK shim, copied byte for byte from the competition kit.

On the kit's 24-hour dev window (1,222 coins) it scores +0.018 SOL net PnL across 78 coins with a 0.56% maximum drawdown. The kit's own pilot bots score −0.42 SOL (sniper), −4.37 SOL (reversion) and −9.45 SOL (momentum) on the same window.

---

<sub>Entered on [make.fun](https://make.fun/?ref=yg6b1b3z&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
