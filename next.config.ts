import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  /* config options here */
};

// Mounts the eve agent in `agent/` on this app's origin under /eve/v1/*, and
// deploys both as one Vercel project.
export default withEve(nextConfig);
