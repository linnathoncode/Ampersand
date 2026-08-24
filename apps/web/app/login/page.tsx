"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const nucleusUrl = process.env.NEXT_PUBLIC_NUCLEUS_URL ?? "http://localhost:4000";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <main className="login-page">
      <section className="login-brand" aria-label="Ampersand">
        <span>&amp;</span>
        <strong>ampersand</strong>
      </section>
      <section className="login-panel">
        <form
          className="login-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setIsSubmitting(true);

            try {
              const response = await fetch(`${nucleusUrl}/auth/login`, {
                method: "POST",
                credentials: "include",
                headers: {
                  "content-type": "application/json",
                  "x-service-id": "ampersand-web",
                  "x-tenant-id": "ampersand-dev",
                },
                body: JSON.stringify({ email, password }),
              });
              const body = (await response.json()) as {
                message?: string;
                success?: boolean;
              };

              if (!response.ok || body.success === false) {
                setError(body.message ?? "Login failed");
                return;
              }

              router.push("/chat");
            } catch {
              setError("The Nucleus service could not be reached");
            } finally {
              setIsSubmitting(false);
            }
          }}
        >
          <div className="login-heading">
            <h1>Sign in</h1>
            <p>Development tenant</p>
          </div>
          <label>
            Email
            <input
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button disabled={isSubmitting} type="submit">
            {isSubmitting ? "Signing in" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
