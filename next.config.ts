import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async redirects() {
    return [
      { source: "/", destination: "/workspace", permanent: false },
      // The console sign-in moved to /login; the stand-in's is at /fake/login.
      { source: "/console/login", destination: "/login", permanent: false },
    ];
  },
};

export default nextConfig;
