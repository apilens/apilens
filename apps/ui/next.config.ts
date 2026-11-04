import type { NextConfig } from "next";

// Self-host overrides for the public links in src/lib/links.ts, inlined into the client bundle.
const linkEnv = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[0].startsWith("APILENS_LINKS_") && typeof e[1] === "string"),
);

const nextConfig: NextConfig = {
  // Self-contained server bundle for the container image (apps/ui/Dockerfile).
  output: "standalone",
  poweredByHeader: false,
  // The dev-mode "N" badge floats over the corner controls (avatar, sidebar toggle).
  devIndicators: false,
  env: linkEnv,
};

export default nextConfig;
