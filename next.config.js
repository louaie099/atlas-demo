/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      { source: "/live", destination: "/operations", permanent: false },
      { source: "/dashboard", destination: "/", permanent: false },
    ];
  },
};

module.exports = nextConfig;
