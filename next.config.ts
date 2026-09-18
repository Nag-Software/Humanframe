import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  // Maya's identity is one file, shared by chat and Call. The Call route reads
  // it at runtime, and Next's tracer cannot see through the read, so it is
  // named explicitly here instead of being duplicated into the bundle.
  outputFileTracingIncludes: {
    "/api/assistants/maya/call/start": ["./agent/instructions.md"],
    "/api/assistants/maya/facetime/start": ["./agent/instructions.md"],
  },
  async redirects() {
    return [
      {
        source: "/settings/notifications",
        destination: "/assistants/maya?settings=notifications",
        permanent: false,
      },
      {
        source: "/settings/billing",
        destination: "/assistants/maya?settings=billing",
        permanent: false,
      },
      {
        source: "/settings",
        destination: "/assistants/maya?settings=account",
        permanent: false,
      },
      {
        source: "/settings/:path*",
        destination: "/assistants/maya?settings=account",
        permanent: false,
      },
      // The dashboard modules are gone; their content lives on her profile.
      { source: "/calendar", destination: "/assistants/maya", permanent: false },
      {
        source: "/routine-tasks",
        destination: "/assistants/maya/profile",
        permanent: false,
      },
    ];
  },
};

// Mounts the eve agent in `agent/` on this app's origin under /eve/v1/*, and
// deploys both as one Vercel project.
export default withEve(nextConfig);
