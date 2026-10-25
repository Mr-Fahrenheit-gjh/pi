import { getFileName } from "./file-paths";

function outputPriority(path: string): number {
  const name = getFileName(path).toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop()! : "";
  if (/^(js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyi|ipynb|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|cxx|hpp|cs|php|vue|svelte|css|scss|sass|less|sh|bash|zsh|fish|ps1|bat|cmd|sql|r|lua|pl|ex|exs|erl|hrl|hs|scala|dart|json|jsonl|ya?ml|toml|ini|cfg|conf|xml|lock|env)$/.test(extension)
    || /^(dockerfile|makefile|gnumakefile|cmakelists\.txt|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(name)
    || name.startsWith(".env") || name.startsWith(".git")) return 2;
  if (/^(pdf|md|mdx|markdown|txt|html|htm|doc|docx|odt|rtf|ppt|pptx|odp|xls|xlsx|ods|csv|tsv|png|jpg|jpeg|gif|webp|svg|avif|bmp|tiff?)$/.test(extension)) return 0;
  return 1;
}

/** Reading material first, engineering files last; preserve recency within each tier. */
export function sortOutputPaths(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => outputPriority(a) - outputPriority(b));
}
