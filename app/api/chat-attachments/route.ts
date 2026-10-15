import { NextResponse } from "next/server";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { CHAT_ATTACHMENT_FILE_LIMIT, CHAT_ATTACHMENT_TOTAL_LIMIT, saveChatAttachments } from "@/lib/chat-attachments";
import { validateUploadFileNames } from "@/lib/file-upload";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted request" }, { status: 403 });
  try {
    const form = await parseFormDataWithinLimit(request, CHAT_ATTACHMENT_TOTAL_LIMIT + 1024 * 1024);
    const files = form.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    const error = validateUploadFileNames(files.map((file) => file.name));
    if (error) return NextResponse.json({ error }, { status: 400 });
    if (files.some((file) => file.size > CHAT_ATTACHMENT_FILE_LIMIT) || files.reduce((sum, file) => sum + file.size, 0) > CHAT_ATTACHMENT_TOTAL_LIMIT) return NextResponse.json({ error: "Each attachment must be 25MB or smaller; total must not exceed 100MB" }, { status: 413 });
    const attachments = await saveChatAttachments(files);
    return NextResponse.json({ attachments });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Attachments must total 100MB or less" }, { status: 413 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Attachment upload failed" }, { status: 500 });
  }
}
