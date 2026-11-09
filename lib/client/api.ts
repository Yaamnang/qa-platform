"use client";

import { useEffect, useState } from "react";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fieldErrors: Record<string, string> = {},
    public code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body.fieldErrors ?? {}, body.code);
  }
  return body as T;
}

export type Me = {
  email: string;
  displayName: string;
  role: "admin" | "viewer";
  tenant: { slug: string; name: string };
};

/** POST a JSON body. */
export function postJson<T>(url: string, body: unknown): Promise<T> {
  return api<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Feature flags (also the stand-in's client-side fault injection channel). */
export function useFlags(): Set<string> {
  const [flags, setFlags] = useState<Set<string>>(new Set());
  useEffect(() => {
    api<{ flags: string[] }>("/api/flags")
      .then((r) => setFlags(new Set(r.flags)))
      .catch(() => setFlags(new Set()));
  }, []);
  return flags;
}
