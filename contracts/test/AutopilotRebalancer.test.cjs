const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const BASE_ADDRESSES = {
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481"
};

describe("AutopilotRebalancer", function () {
  it("sees expected Base contracts on the fork", async function () {
    if (!process.env.BASE_RPC_URL) this.skip();

    for (const [label, address] of Object.entries(BASE_ADDRESSES)) {
      const code = await ethers.provider.getCode(address);
      assert.notEqual(code, "0x", `${label} has no code at ${address}`);
    }
  });

  it("deploys with Base Uniswap v3 addresses and exposes constants", async function () {
    const [owner] = await ethers.getSigners();
    const Rebalancer = await ethers.getContractFactory("AutopilotRebalancer");
    const rebalancer = await Rebalancer.deploy(
      owner.address,
      BASE_ADDRESSES.weth,
      BASE_ADDRESSES.usdc,
      BASE_ADDRESSES.positionManager,
      BASE_ADDRESSES.swapRouter02
    );
    await rebalancer.waitForDeployment();

    assert.equal(await rebalancer.owner(), owner.address);
    assert.equal(await rebalancer.weth(), BASE_ADDRESSES.weth);
    assert.equal(await rebalancer.usdc(), BASE_ADDRESSES.usdc);
    assert.equal(await rebalancer.POOL_FEE(), 3000n);
  });

  it("blocks non-owner sweeps", async function () {
    const [owner, other] = await ethers.getSigners();
    const Rebalancer = await ethers.getContractFactory("AutopilotRebalancer");
    const rebalancer = await Rebalancer.deploy(
      owner.address,
      BASE_ADDRESSES.weth,
      BASE_ADDRESSES.usdc,
      BASE_ADDRESSES.positionManager,
      BASE_ADDRESSES.swapRouter02
    );
    await rebalancer.waitForDeployment();

    await assert.rejects(rebalancer.connect(other).sweepToken(BASE_ADDRESSES.weth), /NotOwner/);
  });

  it("rejects unsupported token sweeps", async function () {
    const [owner] = await ethers.getSigners();
    const Rebalancer = await ethers.getContractFactory("AutopilotRebalancer");
    const rebalancer = await Rebalancer.deploy(
      owner.address,
      BASE_ADDRESSES.weth,
      BASE_ADDRESSES.usdc,
      BASE_ADDRESSES.positionManager,
      BASE_ADDRESSES.swapRouter02
    );
    await rebalancer.waitForDeployment();

    await assert.rejects(rebalancer.sweepToken(owner.address), /UnsupportedToken/);
  });
});
