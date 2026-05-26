import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  // Cloud Run runs a single Node.js process per instance — standalone output
  // produces a self-contained server.js with only the modules it needs.
  output: "standalone",
};

export default nextConfig;
