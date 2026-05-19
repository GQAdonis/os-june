"use client";

import { FormEvent, useState } from "react";

type Mode = "sign-in" | "sign-up";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const payload = {
      name: String(form.get("name") || ""),
      workspaceName: String(form.get("workspaceName") || "My workspace"),
      email: String(form.get("email") || ""),
      password: String(form.get("password") || ""),
    };

    const response = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error || "Authentication failed");
      return;
    }
    window.location.href = "/";
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#efeee8] p-6">
      <section className="w-full max-w-md rounded-[22px] border border-[#464541] bg-[#202020] p-8 shadow-2xl">
        <div className="mb-8 flex gap-3">
          <span className="h-4 w-4 rounded-full bg-[#ff605c]" />
          <span className="h-4 w-4 rounded-full bg-[#ffbd44]" />
          <span className="h-4 w-4 rounded-full bg-[#00ca4e]" />
        </div>
        <h1 className="font-editorial text-4xl text-[#f0eee8]">{mode === "sign-in" ? "Welcome back" : "Create workspace"}</h1>
        <form onSubmit={submit} className="mt-8 space-y-4">
          {mode === "sign-up" && (
            <>
              <input name="name" required placeholder="Name" className="auth-input" />
              <input name="workspaceName" required placeholder="Workspace name" className="auth-input" />
            </>
          )}
          <input name="email" type="email" required placeholder="Email" className="auth-input" />
          <input name="password" type="password" required placeholder="Password" className="auth-input" />
          {error && <p className="rounded-xl border border-[#6f342f] bg-[#3a2523] p-3 text-sm text-[#f0bbb3]">{error}</p>}
          <button disabled={busy} className="w-full rounded-full bg-[#f0eee8] px-5 py-3 font-semibold text-[#2b2a28]">
            {busy ? "Please wait..." : mode === "sign-in" ? "Sign in" : "Create account"}
          </button>
        </form>
        <button
          onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
          className="mt-5 w-full text-center text-sm font-semibold text-[#aaa69e]"
        >
          {mode === "sign-in" ? "Create a new workspace" : "Sign in instead"}
        </button>
      </section>
    </main>
  );
}
