"use client";

import { useEffect } from "react";
import { settlePending } from "@/lib/last-signin";

/** Finishes recording a Google, GitHub or SSO sign-in once the page after it loads. */
export function SignInRecorder() {
  useEffect(() => settlePending(), []);
  return null;
}
