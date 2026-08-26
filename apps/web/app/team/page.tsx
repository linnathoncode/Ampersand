"use client";

import { useState } from "react";

import { AppShell } from "../components/app-shell";
import {
  createTenantHeaders,
  fetchWithAuthRedirect,
  getSelectedTenant,
  nucleusUrl,
} from "../auth/client";

export default function TeamPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <AppShell activeSection="team" activeTab="selection" breadcrumb="Team">
      <section className="team-page">
        <div className="team-heading">
          <h1>Invite a user</h1>
          <p className="invite-warning" role="note">(Valid for 7 days.)</p>
        </div>
        <form
          className="invite-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const tenant = getSelectedTenant();

            if (!tenant) {
              window.location.assign("/login");
              return;
            }

            setMessage(null);
            setIsSubmitting(true);

            try {
              const response = await fetchWithAuthRedirect(`${nucleusUrl}/tenant-users/invite`, {
                method: "POST",
                credentials: "include",
                headers: {
                  "content-type": "application/json",
                  ...createTenantHeaders(tenant),
                },
                body: JSON.stringify({ email }),
              });
              const body = (await response.json()) as {
                message?: string;
                error?: { message?: string };
              };

              setMessage(
                body.message ?? body.error?.message ?? "The invitation could not be sent",
              );

              if (response.ok) setEmail("");
            } catch {
              setMessage("The Nucleus service could not be reached");
            } finally {
              setIsSubmitting(false);
            }
          }}
        >
          <label>
            Email
            <input
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
              required
              type="email"
              value={email}
            />
          </label>
          <button disabled={isSubmitting} type="submit">
            {isSubmitting ? "Sending" : "Send invitation"}
          </button>
          {message && <p className="invite-message">{message}</p>}
        </form>
      </section>
    </AppShell>
  );
}
