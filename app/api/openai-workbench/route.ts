import { NextRequest, NextResponse } from "next/server";
import { getModelRuntimeWithExtensions } from "@/lib/model-runtime";
import { projectWorkbenchModel, record, WorkbenchError, type WorkbenchSnapshot } from "@/lib/openai-api-workbench";
import { readWorkbenchConfig, saveWorkbenchConfig } from "@/lib/openai-api-workbench-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function failure(error: unknown) {
  // Never expose JSON parser fragments, credential resolver output or filesystem paths.
  return NextResponse.json({error:error instanceof WorkbenchError ? error.code : "workbench-unavailable"},
    {status:error instanceof WorkbenchError ? error.status : 500});
}
export async function GET() {
  try {
    const {config,revision} = readWorkbenchConfig();
    const models = await getModelRuntimeWithExtensions();
    const snapshot: WorkbenchSnapshot = {
      revision, auth:models.isUsingOAuth("openai") ? "oauth" : models.hasConfiguredAuth("openai") ? "api-key" : "missing",
      models:models.getModels("openai").map((model) => projectWorkbenchModel(model,config)),
    };
    return NextResponse.json(snapshot,{headers:{"Cache-Control":"no-store"}});
  } catch (error) { return failure(error); }
}
export async function PUT(request: NextRequest) {
  try {
    // A bounded, fixed-provider patch, never a raw models.json replacement or arbitrary path.
    const body = await request.text();
    if (body.length > 8192) throw new WorkbenchError("invalid-request",413);
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new WorkbenchError("invalid-request"); }
    const req = record(parsed);
    if (typeof req.modelId !== "string" || req.modelId.length > 200) throw new WorkbenchError("invalid-request");
    const models = await getModelRuntimeWithExtensions();
    const model = models.getModel("openai",req.modelId);
    if (!model) throw new WorkbenchError("unsupported-model");
    return NextResponse.json(saveWorkbenchConfig(parsed,model),{headers:{"Cache-Control":"no-store"}});
  } catch (error) { return failure(error); }
}
