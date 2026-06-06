export const WALLETBOT_APP_NAME = "WalletBot";
export const WALLETBOT_APP_DESCRIPTION = "Base WETH/USDC Uniswap v3 wallet monitor";
export const WALLETBOT_THEME_COLOR = "#1f7a4d";
export const WALLETBOT_BACKGROUND_COLOR = "#f6f7f4";

export function isRailwayDeployment() {
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
}

export function getWalletBotAssets() {
  const suffix = process.env.NODE_ENV === "development" && !isRailwayDeployment() ? "-dev" : "";

  return {
    logo: `/walletbot-logo${suffix}.svg`,
    icon: `/walletbot-icon${suffix}.svg`,
    appleTouchIcon: `/walletbot-icon${suffix}-180.png`,
    pwaIcon192: `/walletbot-icon${suffix}-192.png`,
    pwaIcon512: `/walletbot-icon${suffix}-512.png`,
    pwaMaskableIcon512: `/walletbot-icon${suffix}-maskable-512.png`
  };
}
