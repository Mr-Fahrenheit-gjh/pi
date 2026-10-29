import { NextRequest, NextResponse } from "next/server";
import { currentUsageMonth, getMonthlyUsage } from "@/lib/openai-api-usage";
import { WorkbenchError } from "@/lib/openai-api-workbench";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const month=request.nextUrl.searchParams.get("month") ?? currentUsageMonth();
    return NextResponse.json(await getMonthlyUsage(month),{headers:{"Cache-Control":"no-store"}});
  } catch (error) {
    return NextResponse.json({error:error instanceof WorkbenchError ? error.code : "usage-unavailable"},
      {status:error instanceof WorkbenchError ? error.status : 500});
  }
}
