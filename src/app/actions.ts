"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { clearSessionCookie, isAuthenticated } from "@/lib/auth";
import { syncWalletOnce } from "@/lib/sync";

export async function runSyncAction() {
  if (!(await isAuthenticated())) redirect("/login");
  await syncWalletOnce();
  revalidatePath("/");
}

export async function logoutAction() {
  await clearSessionCookie();
  redirect("/login");
}
