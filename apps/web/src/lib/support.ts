import { useEffect, useState } from "react";
import { fetchAuthCapabilities } from "./auth-capabilities";

let known: string | null = null;

/** The deployment's support address, or null when none is set. Synchronous callers get the last loaded value. */
export function supportEmail(): string | null {
  return known;
}

export function useSupportEmail(): string | null {
  const [email, setEmail] = useState(known);
  useEffect(() => {
    let active = true;
    fetchAuthCapabilities()
      .then((capabilities) => {
        known = capabilities.supportEmail ?? null;
        if (active) setEmail(known);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return email;
}

export function supportMailto(email: string, subject: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}
