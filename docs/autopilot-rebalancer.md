# AutopilotRebalancer

`contracts/AutopilotRebalancer.sol` is a draft owner-only executor for atomic WETH/USDC 0.3% rebalances on Base.

It performs one transaction:

1. `decreaseLiquidity` on the stale Uniswap v3 NFT.
2. `collect` to the contract.
3. `exactInputSingle` on SwapRouter02.
4. `mint` the new range to the owner.
5. Refund leftover WETH/USDC to the owner.

Before use:

- Deploy from a reviewed Solidity toolchain, not from the app directly.
- Approve the contract for the stale position NFT.
- Approve or transfer required WETH/USDC only if the execution path needs extra wallet funds.
- Keep Telegram approval and uncovered-debt guardrails in the off-chain planner.
- Simulate `rebalance` with the exact params immediately before sending.
- Base SwapRouter02 uses the `exactInputSingle` params shape without `deadline`; the contract-level deadline still guards the full rebalance.

Hard constraints in the contract:

- `onlyOwner`
- `nonReentrant`
- WETH/USDC token whitelist
- fee tier fixed to `3000`
- explicit `deadline`
- swap `amountOutMinimum`
- mint `amount0Min` / `amount1Min`
- leftovers are swept only to the owner

Open review items before mainnet deployment:

- Compile and test with Foundry or Hardhat.
- Add fork tests against Base contracts.
- Decide whether old NFTs should remain in the owner wallet or be transferred to the contract.
- Decide whether execution should support native ETH unwrap/wrap flows. Current draft is ERC-20 WETH only.
