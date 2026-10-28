import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import refresh from 'eslint-plugin-react-refresh';
export default tseslint.config(
  {ignores:['dist','coverage','playwright-report','test-results','**/*.d.ts']},
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {files:['**/*.{ts,tsx}'],languageOptions:{ecmaVersion:2022,globals:globals.browser},plugins:{'react-hooks':hooks,'react-refresh':refresh},rules:{...hooks.configs.recommended.rules,'@typescript-eslint/no-explicit-any':'off','react-refresh/only-export-components':['warn',{allowConstantExport:true}]}}
);
