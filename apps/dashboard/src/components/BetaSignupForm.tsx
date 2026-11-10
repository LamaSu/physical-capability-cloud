import React from "react";
import { gatewayUrl } from "../lib/gateway-base.js";

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const FORBIDDEN = new Set([...'<>()[],;:"', String.fromCharCode(92)]);

function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || code === 127 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      return true;
    }
  }
  return false;
}

export function BetaSignupForm() {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState("");
  const [hp, setHp] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (trimmedName.length < 1 || trimmedName.length > 100 || hasControlChar(trimmedName)) {
      setError("Enter your name.");
      return;
    }
    if (trimmedEmail.length > 254 || !EMAIL_SHAPE.test(trimmedEmail) || [...trimmedEmail].some((ch) => FORBIDDEN.has(ch)) || hasControlChar(trimmedEmail)) {
      setError("Enter a valid email address.");
      return;
    }
    if (!role) {
      setError("Choose a role.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      const res = await fetch(gatewayUrl("/api/beta-apply"), {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmedName, email: trimmedEmail, role, hp }),
      });
      if (res.status === 429) {
        setError("Too many signups right now. Try again in a few minutes.");
        return;
      }
      if (!res.ok) {
        setError("We couldn't confirm your signup. Try again.");
        return;
      }
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        setError("We couldn't confirm your signup. Try again.");
        return;
      }
      if (data !== null && typeof data === "object" && (data as { status?: unknown }).status === "ok") {
        setDone(true);
        return;
      }
      setError("We couldn't confirm your signup. Try again.");
    } catch {
      setError("We couldn't confirm your signup. Try again.");
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <section className="ph-no-capture sentry-block mx-auto mt-10 max-w-3xl text-white/75">
        <p role="status">Thanks. We received your signup.</p>
      </section>
    );
  }

  return (
    <section className="ph-no-capture sentry-block mx-auto mt-10 max-w-3xl text-white/75">
      <form aria-label="Private beta signup" noValidate onSubmit={(event) => void onSubmit(event)}>
        <label className="block">
          Name
          <input
            className="mt-1 w-full rounded border border-white/20 bg-white/5 px-3 py-2 text-white"
            type="text"
            autoComplete="name"
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="mt-4 block">
          Email
          <input
            className="mt-1 w-full rounded border border-white/20 bg-white/5 px-3 py-2 text-white"
            type="email"
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <fieldset className="mt-4">
          <legend>Role</legend>
          <label className="mt-2 flex items-center gap-2">
            <input type="radio" name="role" value="buyer" checked={role === "buyer"} onChange={() => setRole("buyer")} />
            <span>Buyer</span>
            <span>I want to order physical work.</span>
          </label>
          <label className="mt-2 flex items-center gap-2">
            <input type="radio" name="role" value="operator" checked={role === "operator"} onChange={() => setRole("operator")} />
            <span>Operator</span>
            <span>I run machines, a lab or a service.</span>
          </label>
          <label className="mt-2 flex items-center gap-2">
            <input type="radio" name="role" value="builder" checked={role === "builder"} onChange={() => setRole("builder")} />
            <span>Builder</span>
            <span>I build kits, templates or tools.</span>
          </label>
        </fieldset>
        <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: "1px", height: "1px", overflow: "hidden" }}>
          <input type="text" name="hp" tabIndex={-1} autoComplete="off" value={hp} onChange={(event) => setHp(event.target.value)} />
        </div>
        <p className="mt-4">We'll use your name, email and role only to contact you about the private beta. They're stored privately and never published. To be removed from the list, email {"<<ADDRESS>>"}.</p>
        {error ? <p role="alert" className="mt-4">{error}</p> : null}
        <button className="mt-4 rounded bg-white/10 px-4 py-2 text-white" type="submit" disabled={sending}>
          {sending ? "Sending..." : "Sign up"}
        </button>
      </form>
    </section>
  );
}
