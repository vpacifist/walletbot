import type { Metadata } from "next";
import { getWalletBotAssets, WALLETBOT_APP_DESCRIPTION, WALLETBOT_APP_NAME } from "@/lib/branding";
import "./globals.css";

const assets = getWalletBotAssets();

export const metadata: Metadata = {
  applicationName: WALLETBOT_APP_NAME,
  title: WALLETBOT_APP_NAME,
  description: WALLETBOT_APP_DESCRIPTION,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: assets.icon, type: "image/svg+xml" },
      { url: assets.pwaIcon192, sizes: "192x192", type: "image/png" },
      { url: assets.pwaIcon512, sizes: "512x512", type: "image/png" }
    ],
    shortcut: [{ url: assets.pwaIcon192, sizes: "192x192", type: "image/png" }],
    apple: [{ url: assets.appleTouchIcon, sizes: "180x180", type: "image/png" }]
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
