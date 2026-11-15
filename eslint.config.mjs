import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  // Standalone extension/skill sources and import templates are not Web modules.
  // They retain their own host-specific checks instead of inheriting Next types.
  { ignores: ["demo/**", ".pi/**", "public-config/**", "工具/**", "项目/**"] },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
