import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["dist/", "node_modules/", "src-tauri/target/", "src-tauri/gen/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // 经典两条（长期稳定）：hooks 调用位置约束 + 依赖数组检查
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // eslint-plugin-react-hooks v7 的 recommended 预设新增了 React Compiler 时代的
      // set-state-in-effect / immutability 规则，会误伤本项目「依赖变化时重置局部状态」
      // 等惯用写法，本次只接入基础规范，故显式关闭这两条。
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      // 允许用 _ 前缀显式标注「有意不使用」的参数 / 解构变量
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    files: ["tests/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.node },
  },
  prettier,
];
