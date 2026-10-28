import {readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {join, resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {runBrowserChecks} from "./browser-web.mjs";
import {runQuietChecks} from "./quiet-tools.mjs";
import {runBrowserCheck} from "../../pi-web维护/native-agent-switcher/playwright-mcp-client.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const maintenance=resolve(root,"../pi-web维护/native-agent-switcher");
const config=JSON.parse(readFileSync(join(maintenance,"local-update.json"),"utf8"));
const packageRoot=config.candidateDirectory;
const outputDir=join(root,"evidence");
mkdirSync(outputDir,{recursive:true});
const identity={packageRoot,buildId:readFileSync(join(packageRoot,".next/BUILD_ID"),"utf8").trim(),
  pluginSha256:createHash("sha256").update(readFileSync(join(root,"src/index.ts"))).digest("hex"),
  browserBackend:"playwright-mcp",at:new Date().toISOString()};
const options={baseURL:process.env.PI_SUGGESTIONS_VERIFY_BASE||"http://127.0.0.1:30168",outputDir};
try {
  let result, quiet;
  if (process.argv.includes("--quiet-only")) {
    result=JSON.parse(readFileSync(join(outputDir,"browser-result.json"),"utf8"));
    if (!result.passed || result.buildId !== identity.buildId || result.packageRoot !== identity.packageRoot || result.pluginSha256 !== identity.pluginSha256) throw new Error("Saved suggestion acceptance does not match these inputs");
    quiet={...await runBrowserCheck(runQuietChecks,options),...identity};
  } else {
    const combined=new Function(`return async function(page, options) { const suggestions=(${runBrowserChecks.toString()}); const quiet=(${runQuietChecks.toString()}); return {browser:await suggestions(page,options),quiet:await quiet(page,options)}; }`)();
    const both=await runBrowserCheck(combined,options);
    result={...both.browser,...identity,syntheticProvider:true,externalModelRequests:0};
    quiet={...both.quiet,...identity};
    writeFileSync(join(outputDir,"browser-result.json"),JSON.stringify(result,null,2)+"\n");
  }
  writeFileSync(join(outputDir,"quiet-tools-result.json"),JSON.stringify(quiet,null,2)+"\n");
  const sourceQuiet=resolve(maintenance,config.sourceDirectory,"test-results/quiet-tools");
  mkdirSync(sourceQuiet,{recursive:true});
  writeFileSync(join(sourceQuiet,"result.json"),JSON.stringify(quiet,null,2)+"\n");
  console.log(JSON.stringify({passed:result.passed&&quiet.passed,browserChecks:result.checks.length,quietChecks:quiet.checks.length,...identity}));
  process.exit(0);
} catch(error) {
  console.error(error);process.exit(1);
}
