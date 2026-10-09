import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * `@/` resolves the same way it does in the app.
 *
 * Next understands the alias from `tsconfig.json`; Vitest does not, so anything importing
 * through it failed to load — which quietly meant the only testable files in the web app
 * were the ones that happened to use relative imports. That is a rule nobody chose, and it
 * decided what got tested.
 */
export default defineConfig({
    test: {
        environment: "node",
    },
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
});
