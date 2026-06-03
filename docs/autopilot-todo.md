# Autopilot TODO

## Deferred decision scenarios

- Work out the out-of-range + uncovered-debt scenario separately: when the position is outside the range, no new fees accrue, and waiting for debt coverage may be impossible.
- Design a fast retry path for price-movement failures: if quote/preflight/slippage fails because price moved, rebuild a fresh plan, refresh the quote, re-simulate, and decide whether to execute without making the user repeat the full Telegram flow.
- Audit and clarify boundary drift semantics before auto-guarded mode: 30 bps should be treated as a maximum allowed distance from the crossed boundary for automatic execution, not as a minimum move required before proposing a rebalance.
- Define the exact `auto_guarded` activation checklist as small independent gates: live preflight health, max immediate cost, max uncovered debt, max boundary drift, fresh quote, valid approvals/roles, fresh sync, and no active stale/executing/failed plan.
- Review whether failed preflight/live attempts should remain in the main Transactions table or move into a separate execution/audit log view.
