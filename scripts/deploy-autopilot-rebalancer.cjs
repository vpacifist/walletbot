/* eslint-disable @typescript-eslint/no-require-imports */
const { ethers } = require("hardhat");

const BASE_ADDRESSES = {
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481"
};

async function main() {
  if (!process.env.BASE_WALLET_ADDRESS) {
    throw new Error("BASE_WALLET_ADDRESS is required; it becomes the AutopilotRebalancer owner.");
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer. Set BASE_DEPLOYER_PRIVATE_KEY before running contracts:deploy:base.");
  }

  const owner = ethers.getAddress(process.env.BASE_WALLET_ADDRESS);
  const Rebalancer = await ethers.getContractFactory("AutopilotRebalancer", deployer);
  const rebalancer = await Rebalancer.deploy(
    owner,
    BASE_ADDRESSES.weth,
    BASE_ADDRESSES.usdc,
    BASE_ADDRESSES.positionManager,
    BASE_ADDRESSES.swapRouter02
  );
  await rebalancer.waitForDeployment();

  const address = await rebalancer.getAddress();
  console.log(`AutopilotRebalancer deployed: ${address}`);
  console.log(`Owner: ${owner}`);
  console.log(`Set AUTOPILOT_REBALANCER_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
