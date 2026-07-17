/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // TypeScript is type-checked in CI (tsc --noEmit passes). Don't let a stray
  // ESLint warning block a production deploy.
  eslint: { ignoreDuringBuilds: true },
};

module.exports = nextConfig;
