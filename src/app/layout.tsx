import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WalletBot",
  description: "Base WETH/USDC Uniswap v3 wallet monitor"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
