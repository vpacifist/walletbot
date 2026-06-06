import type { MetadataRoute } from "next";
import {
  getWalletBotAssets,
  WALLETBOT_APP_DESCRIPTION,
  WALLETBOT_APP_NAME,
  WALLETBOT_BACKGROUND_COLOR,
  WALLETBOT_THEME_COLOR
} from "@/lib/branding";

export default function manifest(): MetadataRoute.Manifest {
  const assets = getWalletBotAssets();

  return {
    name: WALLETBOT_APP_NAME,
    short_name: WALLETBOT_APP_NAME,
    description: WALLETBOT_APP_DESCRIPTION,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: WALLETBOT_BACKGROUND_COLOR,
    theme_color: WALLETBOT_THEME_COLOR,
    icons: [
      {
        src: assets.pwaIcon192,
        sizes: "192x192",
        type: "image/png",
        purpose: "any"
      },
      {
        src: assets.pwaIcon512,
        sizes: "512x512",
        type: "image/png",
        purpose: "any"
      },
      {
        src: assets.pwaMaskableIcon512,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable"
      }
    ]
  };
}
