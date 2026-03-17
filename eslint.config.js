const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    // Never lint these directories
    { ignores: ["node_modules/", "backups/", "migrations/", ".github/"] },

    // All JS files — bug-focused rules only, zero style rules
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: { ...globals.node },
        },
        rules: {
            ...js.configs.recommended.rules,

            // Warn-only: server.js has ~9 unused imports from route extraction
            "no-unused-vars": ["warn", {
                args: "none",              // Express handlers: (req, res, next)
                caughtErrors: "none",      // catch(err) where err is used in template strings
                ignoreRestSiblings: true,
            }],

            // Allow idiomatic != null (checks both null and undefined)
            "eqeqeq": ["error", "smart"],

            // Must throw Error objects, not strings
            "no-throw-literal": "error",
        },
    },

    // Test files — add Jest globals (describe, it, expect, etc.)
    {
        files: ["tests/**/*.js", "jest.config.js"],
        languageOptions: { globals: { ...globals.jest } },
    },
];
