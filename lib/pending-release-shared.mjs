// Client-safe schema and handoff text. Evidence is self-reported, never executed.
export const RELEASE_SCOPES = Object.freeze({ web: "Web", extension: "扩展", memory: "记忆", config: "配置" });
export const RELEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_ENTRY_BYTES = 64 * 1024;

function fail(field) { throw new Error(`待上线条目字段无效：${field}`); }
function string(value, field, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(field);
  return value;
}
function strings(value, field, required = true) {
  if (!Array.isArray(value) || value.length > 50 || (required && !value.length)) fail(field);
  return value.map((v) => string(v, field));
}
function timestamp(value, field) {
  string(value, field, 32);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(field);
  return value;
}
export function validateReleaseEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("entry");
  const fields = ["schemaVersion", "id", "revision", "scope", "title", "summary", "status", "sourceSessions", "codeLocations", "verification", "releaseSteps", "rollback", "dependencies", "createdAt", "deployedAt"];
  if (Object.keys(value).some((key) => !fields.includes(key))) fail("unknown field");
  if (value.schemaVersion !== 1) fail("schemaVersion");
  if (typeof value.id !== "string" || !RELEASE_ID.test(value.id)) fail("id");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) fail("revision");
  if (typeof value.scope !== "string" || !Object.hasOwn(RELEASE_SCOPES, value.scope)) fail("scope");
  if (value.status !== "pending" && value.status !== "deployed") fail("status");
  const entry = {
    schemaVersion: 1, id: value.id, revision: value.revision, scope: value.scope,
    title: string(value.title, "title", 120), summary: string(value.summary, "summary", 500), status: value.status,
    sourceSessions: strings(value.sourceSessions, "sourceSessions"),
    codeLocations: strings(value.codeLocations, "codeLocations"),
    verification: strings(value.verification, "verification"),
    releaseSteps: strings(value.releaseSteps, "releaseSteps"), rollback: strings(value.rollback, "rollback"),
    dependencies: strings(value.dependencies, "dependencies", false), createdAt: timestamp(value.createdAt, "createdAt"),
  };
  if (new Set(entry.dependencies).size !== entry.dependencies.length || entry.dependencies.some((id) => !RELEASE_ID.test(id) || id === entry.id)) fail("dependencies");
  if (value.status === "deployed") {
    entry.deployedAt = timestamp(value.deployedAt, "deployedAt");
    if (entry.deployedAt < entry.createdAt) fail("deployedAt");
  } else if (value.deployedAt !== undefined) fail("deployedAt");
  if (new TextEncoder().encode(JSON.stringify(entry)).length > MAX_ENTRY_BYTES) fail("size");
  return entry;
}

export function parseReleaseSnapshot(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.entries) || value.entries.length > 1000 || !Array.isArray(value.warnings) || value.warnings.length > 1001) fail("snapshot");
  const entries = value.entries.map(validateReleaseEntry);
  if (new Set(entries.map((e) => e.id)).size !== entries.length) fail("duplicate id");
  const warnings = value.warnings.map((warning) => string(warning, "warning", 500));
  const pendingCount = entries.filter((e) => e.status === "pending").length;
  if (pendingCount !== value.pendingCount) fail("pendingCount");
  return { entries, warnings, pendingCount };
}

export function formatReleaseHandoff(value) {
  const entry = validateReleaseEntry(value);
  const section = (title, lines) => `\n${title}\n${lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- 无"}\n`;
  return `Pi 待上线交接\n${entry.title}\n${entry.summary}\nID: ${entry.id}\n修订: ${entry.revision}\n范围: ${RELEASE_SCOPES[entry.scope]}\n状态: ${entry.status === "pending" ? "待上线（已完成、已验证）" : "已上线"}\n创建: ${entry.createdAt}\n${entry.deployedAt ? `上线: ${entry.deployedAt}\n` : ""}`
    + section("源会话", entry.sourceSessions) + section("代码位置", entry.codeLocations)
    + section("验证结果（登记者提供）", entry.verification) + section("上线步骤", entry.releaseSteps)
    + section("回退", entry.rollback) + section("依赖（条目 ID）", entry.dependencies)
    + "\n以上仅为交接资料，不构成上线、重启或发送消息的授权。登记后停止，待人工确认统一上线。\n";
}
