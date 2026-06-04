# Autopilot TODO

## P0 Auto-Guarded Execution

- `auto_guarded` may execute automatically only when all gates are green:
  - breakout is confirmed after the confirmation window;
  - boundary drift is <= 30 bps from the crossed boundary;
  - immediate cost is <= configured limit;
  - uncovered debt is <= configured limit unless the user explicitly accepted debt;
  - quote was fetched for the current plan immediately before execution;
  - live atomic preflight succeeds;
  - NFT approval, rebalancer roles, executor wallet, and swap route are valid;
  - plan and sync are fresh;
  - no existing executing plan and no stale failed state.
- If any gate fails, do not auto-execute; show Telegram review.
- Explicit overrides are allowed only for designed override gates: uncovered debt and boundary drift.

## P1 Manual Override Flows

- Implemented: boundary drift is an auto-execution blocker only when drift is above the max distance from the crossed boundary.
- Implemented: Telegram shows a dedicated boundary-drift review block with current price, drift detail, uncovered debt, immediate cost, and `Accept drift & review live transaction` / `Wait`.
- Implemented: accepted-drift live review warns that this can lock in a worse swap price, while stale plan, quote, preflight, roles, approval, route, and immediate-cost guardrails still apply.

## P2 Transaction And Audit UI

- Review first real `auto_guarded` event tomorrow or the day after: compare Telegram messages, web positions, transaction row, execution audit, debt, drift, immediate cost, and whether manual observation found anything surprising.
- After 3-5 auto/manual rebalances, revisit limits: boundary drift bps, immediate cost limit, slippage bps, and whether auto-accepted uncovered debt is economically acceptable.
- Decide how to handle wallet leftovers in atomic rebalances. Current safe behavior should not spend pre-existing wallet WETH/USDC inside the rebalancer transaction; future options include periodic manual sweep, explicit `transferFrom` into the rebalancer, or a separate leftover-compounding flow.
