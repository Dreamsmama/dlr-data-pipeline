const internalApiBase = (process.env.INTERNAL_API_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${internalApiBase}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
