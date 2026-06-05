/* eslint-disable @typescript-eslint/no-require-imports */
const { ethers } = require("hardhat");

const BASE_ADDRESSES = {
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  zeroExAllowanceHolder: "0x0000000000001fF3684f28c67538d4D072C22734",
  odosSmartOrderRouterV3: "0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05"
};

async function main() {
  if (!process.env.BASE_WALLET_ADDRESS) {
    throw new Error("BASE_WALLET_ADDRESS is required; it becomes the AutopilotRebalancer vault.");
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer. Set BASE_DEPLOYER_PRIVATE_KEY before running contracts:deploy:base.");
  }

  const owner = ethers.getAddress(deployer.address);
  const executor = ethers.getAddress(process.env.AUTOPILOT_EXECUTOR_ADDRESS || deployer.address);
  const vault = ethers.getAddress(process.env.BASE_WALLET_ADDRESS);
  const swapProvider = process.env.AUTOPILOT_SWAP_PROVIDER === "zeroex" ? "zeroex" : "odos";
  const allowlistedSwapTarget =
    swapProvider === "odos" ? BASE_ADDRESSES.odosSmartOrderRouterV3 : BASE_ADDRESSES.zeroExAllowanceHolder;
  const Rebalancer = await ethers.getContractFactory("AutopilotRebalancer", deployer);
  const rebalancer = await Rebalancer.deploy(
    owner,
    executor,
    vault,
    BASE_ADDRESSES.weth,
    BASE_ADDRESSES.usdc,
    BASE_ADDRESSES.positionManager,
    BASE_ADDRESSES.swapRouter02,
    allowlistedSwapTarget
  );
  await rebalancer.waitForDeployment();

  const address = await rebalancer.getAddress();
  console.log(`AutopilotRebalancer deployed: ${address}`);
  console.log(`Owner: ${owner}`);
  console.log(`Executor: ${executor}`);
  console.log(`Vault: ${vault}`);
  console.log(`Swap provider: ${swapProvider}`);
  console.log(`Allowlisted swap target: ${allowlistedSwapTarget}`);
  console.log(`Set AUTOPILOT_REBALANCER_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
