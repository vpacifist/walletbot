import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await isAuthenticated()) redirect("/");
  const params = await searchParams;

  return (
    <main className="login">
      <form className="panel login-card" action="/api/auth/login" method="post">
        <div className="brand">
          <div>
            <h1>WalletBot</h1>
            <p>Private Base liquidity monitor</p>
          </div>
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>

        {params.error ? <p className="error">Invalid password.</p> : null}
        <button className="button primary" type="submit">
          Sign in
        </button>
      </form>
    </main>
  );
}
