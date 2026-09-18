import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone — a self-contained server bundle with only the
  // node_modules this app actually uses traced in, instead of the full
  // node_modules tree. The Dockerfile's runtime stage copies that instead
  // of running `npm install` again, which is most of why the image is
  // small.
  output: "standalone",
};

export default nextConfig;
