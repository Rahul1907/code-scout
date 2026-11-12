"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getMe } from "@/lib/api";
import type { UserProfile } from "@/lib/types";

export function AuthHeaderAction({ variant = "nav" }: { variant?: "nav" | "hero" }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let active = true;
    getMe()
      .then((profile) => {
        if (active) setUser(profile);
      })
      .catch(() => {
        // Unauthenticated
      })
      .finally(() => {
        if (active) setChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);

  if (checked && user) {
    return (
      <Link
        href="/dashboard"
        className={
          variant === "hero"
            ? "inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white dark:text-slate-950"
            : "rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white dark:text-slate-950"
        }
      >
        Open Dashboard ({user.login})
      </Link>
    );
  }

  return (
    <a
      href="/api/auth/github"
      className={
        variant === "hero"
          ? "inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white dark:text-slate-950"
          : "rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white dark:text-slate-950"
      }
    >
      Sign in with GitHub
    </a>
  );
}
