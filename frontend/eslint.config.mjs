import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";

export default [
    {
        ignores: [
            "sync-client/src/services/types.ts",
            "**/dist/",
            "**/*.mjs",
            "**/*.js",
        ]
    },
    ...tseslint.config({
        plugins: {
            "unused-imports": unusedImports
        },
        extends: [eslint.configs.recommended, tseslint.configs.all],
        rules: {
            "no-console": "error",
            "no-unused-vars": "off",
            "curly": ["error", "all"],
            "@typescript-eslint/restrict-template-expressions": "off",
            "@typescript-eslint/no-unused-vars": "off",
            "@typescript-eslint/no-floating-promises": [
                "error",
                {
                    allowForKnownSafeCalls: [
                        { from: "package", name: ["suite", "test"], package: "node:test" },
                    ],
                },
            ],
            "@typescript-eslint/parameter-properties": "off",
            "@typescript-eslint/require-await": "off",
            "@typescript-eslint/class-methods-use-this": "off",
            "@typescript-eslint/consistent-return": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/max-params": "off",
            "@typescript-eslint/no-magic-numbers": "off",
            "@typescript-eslint/prefer-readonly-parameter-types": "off",
            "@typescript-eslint/naming-convention": "off",
            "no-restricted-properties": [
                "error",
                {
                    object: "Promise",
                    property: "all",
                    message: "Use `awaitAll` instead of Promise.all to always await all promises."
                },
                {
                    object: "Promise",
                    property: "allSettled",
                    message: "Use `awaitAll` instead of Promise.allSettled to always await all promises and throw on errors."
                },
                {
                    object: "String",
                    property: "replace",
                    message: "Use replaceAll instead of replace to replace all occurrences of a substring."
                }
            ],
            "no-restricted-syntax": [
                "error",
                {
                    selector: "CallExpression[callee.property.name='splice'][arguments.length=2][arguments.1.type='Literal'][arguments.1.value=1]",
                    message: "Use `removeFromArray(array, item)` instead of manually using indexOf + splice(index, 1). Import from 'sync-client/src/utils/remove-from-array'."
                },
                {
                    selector: "CallExpression[callee.property.name='filter'] > ArrowFunctionExpression[body.type='BinaryExpression'][body.operator='!==']",
                    message: "Use `removeFromArray(array, item)` instead of filter(x => x !== item) for better performance. Import from 'sync-client/src/utils/remove-from-array'."
                },
                {
                    selector: "CallExpression[callee.property.name='filter'] > ArrowFunctionExpression > BlockStatement > ReturnStatement > BinaryExpression[operator='!==']",
                    message: "Use `removeFromArray(array, item)` instead of filter(x => { return x !== item }) for better performance. Import from 'sync-client/src/utils/remove-from-array'."
                },
                {
                    selector: "CallExpression[callee.property.name='filter'] > FunctionExpression[body.type='BlockStatement'] > BlockStatement > ReturnStatement > BinaryExpression[operator='!==']",
                    message: "Use `removeFromArray(array, item)` instead of filter(function(x) { return x !== item }) for better performance. Import from 'sync-client/src/utils/remove-from-array'."
                }
            ],
            "unused-imports/no-unused-vars": [
                "warn",
                {
                    vars: "all",
                    varsIgnorePattern: "^_",
                    args: "after-used",
                    argsIgnorePattern: "^_"
                }
            ]
        },
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname
            }
        }
    })
];
