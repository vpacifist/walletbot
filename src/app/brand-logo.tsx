import Image from "next/image";
import { getWalletBotAssets } from "@/lib/branding";

export function BrandLogo() {
  const assets = getWalletBotAssets();

  return <Image className="brand-logo" src={assets.logo} alt="" width={46} height={46} priority aria-hidden="true" />;
}
