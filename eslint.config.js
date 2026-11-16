import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.js", "vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  // Browser-Code des Webinterface (P10): Schutz vor XSS (plan.md Kap. 5.11, AK 9). Texte nur als
  // Textknoten über web/dom.js; kein HTML aus Zeichenketten, kein Code aus Zeichenketten.
  {
    files: ["packages/office/web/**/*.js"],
    languageOptions: { globals: globals.browser },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-restricted-properties": [
        "error",
        ...["innerHTML", "outerHTML", "insertAdjacentHTML", "write", "writeln"].map((property) => ({
          property,
          message: "Nur Textknoten über dom.js (AK 9).",
        })),
        { property: "createContextualFragment", message: "Nur Textknoten über dom.js (AK 9)." },
        { property: "setHTMLUnsafe", message: "Nur Textknoten über dom.js (AK 9)." },
        { property: "parseHTMLUnsafe", message: "Nur Textknoten über dom.js (AK 9)." },
        { object: "window", property: "open", message: "Links nur über externalLink (dom.js)." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='DOMParser']",
          message: "Kein HTML aus Zeichenketten (AK 9).",
        },
        {
          selector: "AssignmentExpression[left.property.name=/^(href|src|action|on.*)$/]",
          message: "URLs und Ereignis-Handler nur über dom.js bzw. addEventListener.",
        },
        {
          selector: "CallExpression[callee.property.name='setAttribute']",
          message: "Attribute nur über h() aus dom.js mit fester Liste.",
        },
        {
          selector:
            "MemberExpression[object.name='location'][property.name=/^(href|assign|replace)$/]",
          message: "Keine Navigation per Code (R11).",
        },
      ],
    },
  },
  {
    files: ["packages/office/web/dom.js"],
    rules: {
      // Die einzige Stelle mit setAttribute und href, beide geprüft (feste Liste, nur https).
      "no-restricted-syntax": "off",
    },
  },
);
