import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  output: "standalone",
  // Keep the dev-tools badge out of the sidebar footer, where it covers
  // the Collapse button.
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
