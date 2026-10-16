import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([".next/**", "out/**", "coverage/**", "next-env.d.ts"]),
  {
    files: ["src/domain/**/*.ts", "src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: ["next", "next/*", "react", "react/*", "react-dom", "react-dom/*", "@upstash/*", "redis", "ioredis", "@/infrastructure/*", "@/app/*", "@/components/*", "@/lib/*", "**/infrastructure/**", "**/components/**", "**/app/**", "**/lib/**"]
      }]
    }
  }
]);
