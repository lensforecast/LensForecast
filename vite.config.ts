import { defineConfig } from "vitest/config";

/** Project Pages lives at /<repo>/. Local dev and preview stay at /. */
const base = (): string => {
  if (process.env.GITHUB_PAGES !== "true") return "/";
  const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
  return repo ? `/${repo}/` : "/";
};

export default defineConfig({
  base: base(),
  test: {
    include: ["src/**/*.test.ts"],
  },
});
