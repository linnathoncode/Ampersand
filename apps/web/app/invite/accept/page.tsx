"use client";

import { useEffect, useState } from "react";

import {
  createTenantHeaders,
  normalizeTenant,
  nucleusUrl,
  saveSelectedTenant,
} from "../../auth/client";

export default function AcceptInvitationPage() {
  const [token, setToken] = useState("");
  const [tenant, setTenant] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token") ?? "");
    setTenant(
      params.get("tenant") ??
        process.env.NEXT_PUBLIC_DEV_TENANT_SUBDOMAIN ??
        "ampersand-dev",
    );
  }, []);

  return (
    <main className="login-page">
      <section className="login-brand" aria-label="ampersand">
        <span>&amp;</span>
        <strong>ampersand</strong>
      </section>
      <section className="login-panel">
        <form
          className="login-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);

            if (!token || !tenant) {
              setError("This invitation link is incomplete");
              return;
            }

            if (password !== confirmation) {
              setError("Passwords do not match");
              return;
            }

            const selectedTenant = normalizeTenant(tenant);
            setIsSubmitting(true);

            try {
              const response = await fetch(`${nucleusUrl}/auth/password-set`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...createTenantHeaders(selectedTenant),
                },
                body: JSON.stringify({ token, newPassword: password }),
              });
              const body = (await response.json()) as { message?: string; success?: boolean };

              if (!response.ok || body.success === false) {
                setError(body.message ?? "The invitation is invalid or expired");
                return;
              }

              saveSelectedTenant(selectedTenant);
              window.location.assign("/login");
            } catch {
              setError("The Nucleus service could not be reached");
            } finally {
              setIsSubmitting(false);
            }
          }}
        >
          <div className="login-heading">
            <h1>Accept invitation</h1>
            <p>Set the password for your workspace account.</p>
          </div>
          <label>
            Password
            <input
              autoComplete="new-password"
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          <label>
            Confirm password
            <input
              autoComplete="new-password"
              onChange={(event) => setConfirmation(event.target.value)}
              required
              type="password"
              value={confirmation}
            />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button disabled={isSubmitting} type="submit">
            {isSubmitting ? "Saving" : "Set password"}
          </button>
        </form>
      </section>
    </main>
  );
}
