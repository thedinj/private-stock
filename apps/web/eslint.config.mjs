import { dirname } from "path";
import { fileURLToPath } from "url";

import { FlatCompat } from "@eslint/eslintrc";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Flat config driving the ESLint CLI directly.
 *
 * `next lint` is deprecated in Next 15.5 and removed in 16 — and, worse for us, it prompts
 * interactively when it finds no config, which means it hangs a CI run rather than failing
 * it. The `lint` script therefore calls `eslint` itself and this file supplies the Next
 * rules through the compatibility shim.
 */
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
    ...compat.extends("next/core-web-vitals", "next/typescript"),
    {
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    args: "all",
                    argsIgnorePattern: "^_",
                    caughtErrors: "all",
                    caughtErrorsIgnorePattern: "^_",
                    destructuredArrayIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    ignoreRestSiblings: true,
                },
            ],
        },
    },
    {
        // .next-dev is the dev server's output directory (see next.config.ts); build
        // output is generated code and must never be linted.
        ignores: [".next/**", ".next-dev/**", "node_modules/**", "next-env.d.ts"],
    },
];

export default config;
