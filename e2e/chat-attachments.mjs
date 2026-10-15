// Browser integration against an isolated candidate and temporary agent/project only.
export async function runChatAttachmentChecks(page, { baseURL, project }) {
  if (!/^http:\/\/127\.0\.0\.1:301[5-9]\d$/.test(baseURL) || !/^\/(?:private\/)?tmp\//.test(project)) throw new Error("Isolated candidate and project required");
  const listUrl = `${baseURL}/api/files/${project.split("/").filter(Boolean).map(encodeURIComponent).join("/")}?type=list`;
  const before = await (await page.request.get(listUrl)).json();
  const uploads = [];
  const record = (request) => { if (request.method() === "POST" && request.url().includes("type=upload")) uploads.push(request.url()); };
  page.on("request", record);
  try {
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.goto(`${baseURL}/?session=workspace-design-fixture`, { waitUntil: "networkidle" });
    const input = page.locator('.chat-input-shell input[type="file"]');
    const textarea = page.locator(".chat-input-textarea").first();
    await textarea.fill("");
    const response = page.waitForResponse((response) => response.url().endsWith("/api/chat-attachments") && response.request().method() === "POST");
    await input.setInputFiles({ name: "attachment check.md", mimeType: "text/markdown", buffer: Buffer.from("# Referenced attachment\n") });
    const first = await (await response).json();
    if (!first.attachments?.[0]?.path?.includes("/chat-attachments/")) throw new Error("Chat attachment was not stored outside the project");
    await page.waitForFunction(() => document.querySelector(".chat-input-textarea").value.includes("/chat-attachments/"));
    const path = first.attachments[0].path;
    const repeated = page.waitForResponse((response) => response.url().endsWith("/api/chat-attachments") && response.request().method() === "POST");
    await input.setInputFiles({ name: "attachment check.md", mimeType: "text/markdown", buffer: Buffer.from("# Referenced attachment\n") });
    const second = await (await repeated).json();
    if (second.attachments[0].path !== path) throw new Error("Identical attachment was not deduplicated");
    const after = await (await page.request.get(listUrl)).json();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Uploading changed the project directory");
    if (uploads.length) throw new Error("Chat unexpectedly invoked the project-upload API");
    const read = await page.request.get(`${baseURL}/api/files/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}?type=read`);
    if (read.status() !== 200) throw new Error("Stored chat attachment cannot be opened");
    return { passed: true, projectUnchanged: true, deduplicated: true, projectUploadRequests: uploads.length, attachmentReadable: true };
  } finally { page.off("request", record); }
}
