export function isRailwayDeployment() {
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
}

export function getWalletBotAssets() {
  const suffix = isRailwayDeployment() ? "" : "-dev";

  return {
    logo: `/walletbot-logo${suffix}.svg`,
    icon: `/walletbot-icon${suffix}.svg`
  };
}
