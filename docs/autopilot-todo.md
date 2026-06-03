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

- Boundary drift: 30 bps is the max distance from the crossed boundary for automatic execution, not a minimum move required before proposing a rebalance.
- If drift is <= 30 bps and all other guardrails pass, `auto_guarded` may execute.
- If drift is > 30 bps, autopilot must stop and ask for manual review.
- Boundary drift Telegram UI:
  - title: `Execution preview blocked: Boundary drift`;
  - explain that price moved too far from the crossed boundary;
  - show boundary price, current price, drift bps, normal auto limit, uncovered debt, and immediate cost;
  - buttons: `Accept drift & review live transaction` and `Wait`;
  - live review warning: `You are accepting boundary drift. This may lock in a worse swap price.`;
  - final confirmation button: `Confirm accepted-drift transaction`.
- Accept drift bypasses only the boundary-drift guardrail; stale plan, quote, preflight, roles, approval, route, and immediate-cost guardrails still apply.
- Out-of-range blocked execution:
  - when the position is outside range, do not wait by default;
  - if boundary drift is within the auto limit and all gates are green, `auto_guarded` should execute;
  - if execution is blocked only by uncovered debt, show `Accept debt` review;
  - if blocked only by boundary drift, show `Accept drift` review;
  - if both uncovered debt and boundary drift block execution, show a combined `Accept debt + drift` review;
  - waiting is an explicit user choice, not the default near-boundary behavior.

## P2 Transaction And Audit UI

- Review whether failed preflight/live attempts should remain in the main Transactions table or move into a separate execution/audit log view.
