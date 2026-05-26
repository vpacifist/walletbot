require("@nomicfoundation/hardhat-ethers");
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const { BASE_RPC_URL } = process.env;

/** @type {import("hardhat/config").HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./contracts/test",
    cache: "./cache/hardhat",
    artifacts: "./artifacts"
  },
  networks: {
    hardhat: BASE_RPC_URL
      ? {
          forking: {
            url: BASE_RPC_URL
          }
        }
      : {}
  }
};
