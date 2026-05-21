/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Monorepo: transpile workspace packages consumed as source.
  transpilePackages: ["@vpnhub/shared"],
  // Served via `next start` (systemd vpnhub-portal). If we later containerize,
  // switch to output:"standalone" + run .next/standalone/server.js.
};

export default nextConfig;
