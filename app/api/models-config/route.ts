import { NextResponse } from "next/server";
import { ModelsConfigConflictError, ModelsConfigReadError, readModelsConfigSnapshot, writeModelsConfig } from "@/lib/models-config-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const {config,revision} = readModelsConfigSnapshot();
    return NextResponse.json(config,{headers:{"X-Config-Revision":revision,"Cache-Control":"no-store"}});
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const expectedRevision = req.headers.get("If-Match");
    if (!expectedRevision) return NextResponse.json({error:"stale-config"},{status:428});
    const body = await req.json() as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({error:"invalid-config"},{status:400});
    const revision = writeModelsConfig(body,undefined,expectedRevision);
    return NextResponse.json({success:true},{headers:{"X-Config-Revision":revision,"Cache-Control":"no-store"}});
  } catch (error) {
    if (error instanceof ModelsConfigConflictError) return NextResponse.json({error:"stale-config"},{status:409});
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
