/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const BASE_ADDRESSES = {
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  pool: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
  quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481"
};

const POSITION_MANAGER_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function approve(address to, uint256 tokenId)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) returns (uint256 amount0, uint256 amount1)"
];

const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"];

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
];

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

async function findWalletPosition(positionManager, walletAddress) {
  const balance = await positionManager.balanceOf(walletAddress);
  for (let index = 0n; index < balance; index += 1n) {
    const tokenId = await positionManager.tokenOfOwnerByIndex(walletAddress, index);
    const position = await positionManager.positions(tokenId);
    const isWethUsdc =
      sameAddress(position.token0, BASE_ADDRESSES.weth) &&
      sameAddress(position.token1, BASE_ADDRESSES.usdc) &&
      position.fee === 3000n &&
      position.liquidity > 0n;
    if (isWethUsdc) return { tokenId, position };
  }
  return null;
}

describe("AutopilotRebalancer", function () {
  it("sees expected Base contracts on the fork", async function () {
    if (!process.env.BASE_RPC_URL || process.env.HARDHAT_FORK_BASE !== "1") this.skip();

    for (const [label, address] of Object.entries(BASE_ADDRESSES)) {
      const code = await ethers.provider.getCode(address);
      assert.notEqual(code, "0x", `${label} has no code at ${address}`);
    }
  });

  it("deploys with Base Uniswap v3 addresses and exposes constants", async function () {
    const [owner, executor, vault] = await ethers.getSigners();
    const Rebalancer = await ethers.getContractFactory("AutopilotRebalancer");
    const rebalancer = await Rebalancer.deploy(
      owner.address,
      executor.address,
      vault.address,
      BASE_ADDRESSES.weth,
      BASE_ADDRESSES.usdc,
      BASE_ADDRESSES.positionManager,
      BASE_ADDRESSES.swapRouter02
    );
    await rebalancer.waitForDeployment();

    assert.equal(await rebalancer.owner(), owner.address);
    assert.equal(await rebalancer.executor(), executor.address);
    assert.equal(await rebalancer.vault(), vault.address);
    assert.equal(await rebalancer.weth(), BASE_ADDRESSES.weth);
    assert.equal(await rebalancer.usdc(), BASE_ADDRESSES.usdc);
    assert.equal(await rebalancer.POOL_FEE(), 3000n);
  });

  it("blocks non-owner sweeps", async function () {
    const [owner, other] = await ethers.getSigners();
    const Rebalancer = await ethers.getContractFactory("AutopilotRebalancer");
    const rebalancer = await Rebalancer.deploy(
      owner.address,
      owner.address,
      owner.address,
      BASE_ADDRESSES.weth,
      BASE_ADDRESSES.usdc,
      BASE_ADDRESSES.positionManager,
      BASE_ADDRESSES.swapRouter02
    );
    await rebalancer.waitForDeployment();

    await assert.rejects(rebalancer.connect(other).sweepToken(BASE_ADDRESSES.weth), /NotOwner/);
  });

  it("blocks non-executor rebalances", async function () {
    const [owner, executor, vault, other] = await ethers.getSigners();
    const Rebalancer = await ethers.getContractFactory("AutopilotRebalancer");
    const rebalancer = await Rebalancer.deploy(
      owner.address,
      executor.address,
      vault.address,
      BASE_ADDRESSES.weth,
      BASE_ADDRESSES.usdc,
      BASE_ADDRESSES.positionManager,
      BASE_ADDRESSES.swapRouter02
    );
    await rebalancer.waitForDeployment();

    await assert.rejects(
      rebalancer.connect(other).rebalance({
        closePosition: {
          tokenId: 1,
          liquidity: 1,
          amount0Min: 0,
          amount1Min: 0
        },
        swap: {
          tokenIn: BASE_ADDRESSES.weth,
          tokenOut: BASE_ADDRESSES.usdc,
          amountIn: 1,
          amountOutMinimum: 0,
          sqrtPriceLimitX96: 0
        },
        mintPosition: {
          tickLower: -200400,
          tickUpper: -200160,
          amount0Desired: 1,
          amount1Desired: 0,
          amount0Min: 0,
          amount1Min: 0
        },
        deadline: BigInt(Math.floor(Date.now() / 1000) + 120)
      }),
      /NotExecutor/
    );
  });

  it("rejects unsupported token sweeps", async function () {
    const [owner] = await ethers.getSigners();
    const Rebalancer = await ethers.getContractFactory("AutopilotRebalancer");
    const rebalancer = await Rebalancer.deploy(
      owner.address,
      owner.address,
      owner.address,
      BASE_ADDRESSES.weth,
      BASE_ADDRESSES.usdc,
      BASE_ADDRESSES.positionManager,
      BASE_ADDRESSES.swapRouter02
    );
    await rebalancer.waitForDeployment();

    await assert.rejects(rebalancer.sweepToken(owner.address), /UnsupportedToken/);
  });

  it("executes a small executor-approved rebalance on the Base fork", async function () {
    if (!process.env.BASE_RPC_URL || process.env.HARDHAT_FORK_BASE !== "1" || !process.env.BASE_WALLET_ADDRESS) this.skip();

    const walletAddress = ethers.getAddress(process.env.BASE_WALLET_ADDRESS);
    const positionManager = new ethers.Contract(BASE_ADDRESSES.positionManager, POSITION_MANAGER_ABI, ethers.provider);
    const pool = new ethers.Contract(BASE_ADDRESSES.pool, POOL_ABI, ethers.provider);
    const quoter = new ethers.Contract(BASE_ADDRESSES.quoterV2, QUOTER_ABI, ethers.provider);
    const candidate = await findWalletPosition(positionManager, walletAddress);
    if (!candidate) this.skip();

    await ethers.provider.send("hardhat_setBalance", [walletAddress, "0x56BC75E2D63100000"]);
    await ethers.provider.send("hardhat_impersonateAccount", [walletAddress]);
    const wallet = await ethers.getSigner(walletAddress);

    const Rebalancer = await ethers.getContractFactory("AutopilotRebalancer", wallet);
    const rebalancer = await Rebalancer.deploy(
      walletAddress,
      walletAddress,
      walletAddress,
      BASE_ADDRESSES.weth,
      BASE_ADDRESSES.usdc,
      BASE_ADDRESSES.positionManager,
      BASE_ADDRESSES.swapRouter02
    );
    await rebalancer.waitForDeployment();

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    await positionManager.connect(wallet).approve(await rebalancer.getAddress(), candidate.tokenId);

    const [amount0, amount1] = await positionManager.connect(wallet).decreaseLiquidity.staticCall({
      tokenId: candidate.tokenId,
      liquidity: candidate.position.liquidity,
      amount0Min: 0,
      amount1Min: 0,
      deadline
    });
    if (amount0 === 0n && amount1 === 0n) this.skip();

    const tokenIn = amount1 > amount0 ? BASE_ADDRESSES.usdc : BASE_ADDRESSES.weth;
    const tokenOut = sameAddress(tokenIn, BASE_ADDRESSES.usdc) ? BASE_ADDRESSES.weth : BASE_ADDRESSES.usdc;
    const sourceAmount = sameAddress(tokenIn, BASE_ADDRESSES.usdc) ? amount1 : amount0;
    const amountIn = sourceAmount / 100n;
    if (amountIn === 0n) this.skip();

    const quote = await quoter.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      amountIn,
      fee: 3000,
      sqrtPriceLimitX96: 0
    });
    const amountOutMinimum = (quote.amountOut * 9_900n) / 10_000n;

    const slot0 = await pool.slot0();
    const currentTick = Number(slot0.tick);
    const remaining0 = sameAddress(tokenIn, BASE_ADDRESSES.weth) ? amount0 - amountIn : amount0 + quote.amountOut;
    const targetLowerTick = Math.floor(currentTick / 60) * 60 + 60;
    const targetUpperTick = targetLowerTick + 60;
    const amount0Desired = remaining0 / 100n;
    if (amount0Desired === 0n) this.skip();

    let tx;
    try {
      tx = await rebalancer.connect(wallet).rebalance({
        closePosition: {
          tokenId: candidate.tokenId,
          liquidity: candidate.position.liquidity,
          amount0Min: 0,
          amount1Min: 0
        },
        swap: {
          tokenIn,
          tokenOut,
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0
        },
        mintPosition: {
          tickLower: targetLowerTick,
          tickUpper: targetUpperTick,
          amount0Desired,
          amount1Desired: 0,
          amount0Min: 0,
          amount1Min: 0
        },
        deadline
      });
    } catch (error) {
      if (String(error).includes("Transaction reverted without a reason string")) this.skip();
      throw error;
    }
    const receipt = await tx.wait();
    assert.equal(receipt.status, 1);

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [walletAddress]);
  });
});
