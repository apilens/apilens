import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the container image (apps/ui/Dockerfile).
  output: "standalone",
  poweredByHeader: false,
  // The dev-mode "N" badge floats over the corner controls (avatar, sidebar toggle).
  devIndicators: false,
};

export default nextConfig;
