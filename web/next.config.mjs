/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Supabase Storage (raw-media) thumbnails, if we ever render them.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "yyoewdcijplkhxleejtm.supabase.co" },
    ],
  },
};

export default nextConfig;
