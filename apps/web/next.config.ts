import { existsSync } from "node:fs";
import path from "node:path";

import type { NextConfig } from "next";

const webRoot = findWebRoot(process.cwd());

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-sdk/react"],
  experimental: {
    useTypeScriptCli: true,
  },
  turbopack: {
    root: path.resolve(webRoot, "../.."),
  },
};

function findWebRoot(start: string): string {
  let candidate = path.resolve(start);

  while (true) {
    if (existsSync(path.join(candidate, "next.config.ts"))) return candidate;

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error("Could not locate the Next.js project root");
    }
    candidate = parent;
  }
}

export default nextConfig;
