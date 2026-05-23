import type { Metadata } from "next";
import { getWalletBotAssets } from "@/lib/branding";
import "./globals.css";

const assets = getWalletBotAssets();

export const metadata: Metadata = {
  title: "WalletBot",
  description: "Base WETH/USDC Uniswap v3 wallet monitor",
  icons: {
    icon: [{ url: assets.icon, type: "image/svg+xml" }],
    shortcut: [{ url: assets.icon, type: "image/svg+xml" }],
    apple: [{ url: assets.icon, type: "image/svg+xml" }]
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
