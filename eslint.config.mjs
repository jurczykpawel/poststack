import nextConfig from "eslint-config-next";

const config = [
  { ignores: ["src/generated/**", ".next/**", "node_modules/**"] },
  ...nextConfig,
];

export default config;
