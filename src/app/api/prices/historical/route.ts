import { NextResponse } from "next/server";
import { z } from "zod";
import { isAuthenticated } from "@/lib/auth";
import { loadAndCacheMissingHistoricalPrices } from "@/lib/historical-prices";

const requestSchema = z.object({
  blockNumbers: z.array(z.string().regex(/^\d+$/)).max(120)
});

export async function POST(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const prices = await loadAndCacheMissingHistoricalPrices(parsed.data.blockNumbers);
  return NextResponse.json({ prices });
}
