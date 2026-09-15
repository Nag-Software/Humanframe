import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  // Maya's identity is one file, shared by chat and Call. The Call route reads
  // it at runtime, and Next's tracer cannot see through the read, so it is
  // named explicitly here instead of being duplicated into the bundle.
  outputFileTracingIncludes: {
    "/api/assistants/maya/call/start": ["./agent/instructions.md"],
  },
};

// Mounts the eve agent in `agent/` on this app's origin under /eve/v1/*, and
// deploys both as one Vercel project.
export default withEve(nextConfig);
