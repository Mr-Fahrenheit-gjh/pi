import { createReadStream } from "node:fs";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { record, WorkbenchError } from "./openai-api-workbench";

export interface UsageTotals {
  requests: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  estimatedCostUsd: number; estimatedRequests: number; legacyRequests: number; unknownRequests: number;
}
export interface MonthlyUsage {
  month: string; timezone: "Asia/Shanghai"; partial: boolean; scannedFiles: number;
  totals: UsageTotals; byModel: Array<UsageTotals & {model: string}>;
}
const empty = (): UsageTotals => ({requests:0,input:0,output:0,cacheRead:0,cacheWrite:0,estimatedCostUsd:0,estimatedRequests:0,legacyRequests:0,unknownRequests:0});
export function currentUsageMonth(now = Date.now()): string { return new Date(now + 8 * 3600_000).toISOString().slice(0,7); }
function bounds(month: string): [number, number] {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) || month < "2000-01" || month > "2100-12") throw new WorkbenchError("invalid-month");
  const [year,m] = month.split("-").map(Number);
  return [Date.UTC(year,m-1,1)-8*3600_000,Date.UTC(year,m,1)-8*3600_000];
}
type UsageRecord = {model:string; time:number; responseId?:string; ledger:boolean; usage:UsageTotals; cost:number|null; source:"estimated"|"legacy"|"unknown"};
function tokens(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function usageOf(value: unknown): UsageTotals {
  const u = record(value);
  return {...empty(),input:tokens(u.input),output:tokens(u.output),cacheRead:tokens(u.cacheRead),cacheWrite:tokens(u.cacheWrite)};
}
function timestamp(value: unknown): number { return typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN; }
function add(target: UsageTotals, item: UsageRecord) {
  target.requests++;
  for (const key of ["input","output","cacheRead","cacheWrite"] as const) target[key] += item.usage[key];
  if (item.cost !== null) target.estimatedCostUsd += item.cost;
  if (item.source === "estimated") target.estimatedRequests++;
  else if (item.source === "legacy") target.legacyRequests++;
  else target.unknownRequests++;
}

/** Read-only, bounded local scan. Only aggregate numbers leave the server. */
export async function scanMonthlyUsage(month: string, root = join(getAgentDir(),"sessions"), limits = {files:5000,bytes:256*1024*1024,ms:8000,records:200000}): Promise<MonthlyUsage> {
  const [start,end] = bounds(month), deadline = Date.now()+limits.ms;
  let partial = false, scannedFiles = 0, bytes = 0;
  const messages = new Map<string,UsageRecord>();
  const expired = () => Date.now() > deadline || bytes >= limits.bytes || messages.size >= limits.records;
  async function* files(dir: string, depth: number): AsyncGenerator<string> {
    if (depth > 3) {partial=true;return;}
    let handle;
    try { handle = await opendir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") partial=true; return; }
    for await (const entry of handle) {
      if (expired() || scannedFiles >= limits.files) {partial=true;return;}
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) yield* files(join(dir,entry.name),depth+1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield join(dir,entry.name);
    }
  }
  for await (const path of files(root,0)) {
    if (expired() || scannedFiles >= limits.files) {partial=true;break;}
    scannedFiles++;
    const local = new Map<string,string[]>(), ledger = new Map<string,Record<string,unknown>>();
    const consume = (line: string) => {
      let entry: Record<string,unknown>;
      try {entry=record(JSON.parse(line));} catch {if(line.trim())partial=true;return;}
      if (entry.type === "custom" && entry.customType === "openai-api-usage") {
        const data=record(entry.data), time=timestamp(data.messageTimestamp);
        if (data.version === 1 && time >= start && time < end && typeof data.model === "string") {
          if (ledger.size >= limits.records) {partial=true;return;}
          ledger.set(`${time}\0${data.model}`,data);
        }
        return;
      }
      if (entry.type !== "message") return;
      const message = record(entry.message);
      if (message.role !== "assistant" || message.provider !== "openai") return;
      const time=timestamp(message.timestamp ?? entry.timestamp);
      if (!(time >= start && time < end) || typeof message.model !== "string") return;
      const match=`${time}\0${message.model}`, key=`${typeof entry.id === "string" ? entry.id : "v1"}\0${match}`;
      const ids=local.get(match) ?? []; if (!ids.includes(key)) ids.push(key); local.set(match,ids);
      if (messages.has(key)) return;
      const usage=usageOf(message.usage), oldCost=record(record(message.usage).cost).total;
      const total=usage.input+usage.output+usage.cacheRead+usage.cacheWrite;
      const cost=typeof oldCost === "number" && Number.isFinite(oldCost) && oldCost >= 0 && (oldCost > 0 || total === 0) ? oldCost : null;
      messages.set(key,{model:message.model,time,ledger:false,
        ...(typeof message.responseId === "string" && message.responseId ? {responseId:message.responseId} : {}),
        usage,cost,source:cost === null ? "unknown" : "legacy"});
    };
    const stream=createReadStream(path,{encoding:"utf8",highWaterMark:64*1024});
    let buffer="", skipping=false;
    try {
      for await (const chunk of stream) {
        bytes+=Buffer.byteLength(chunk);
        if (expired()) {partial=true;break;}
        buffer+=chunk;
        let newline;
        while ((newline=buffer.indexOf("\n")) >= 0) {
          const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
          if (!skipping && line.length <= 2*1024*1024) consume(line); else partial=true;
          skipping=false;
          if (expired()) {partial=true;break;}
        }
        if (expired()) break;
        if (buffer.length > 2*1024*1024) {buffer="";skipping=true;partial=true;}
      }
      if (!expired() && buffer.trim() && !skipping) consume(buffer);
    } catch {partial=true;} finally {stream.destroy();}
    for (const [match,data] of ledger) {
      const ids=local.get(match);
      if (!ids || ids.length !== 1) {partial=true;continue;}
      const target=messages.get(ids[0]);if(!target)continue;
      const cost=data.estimatedCostUsd, recordedUsage=usageOf(data.usage);
      const tokenTotal=recordedUsage.input+recordedUsage.output+recordedUsage.cacheRead+recordedUsage.cacheWrite;
      // Actual-tier absence or an unpriced model must never turn into a free request.
      const known=data.costStatus === "estimated" && typeof data.actualTier === "string"
        && typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && (cost > 0 || tokenTotal === 0);
      target.usage=recordedUsage;target.cost=known ? cost : null;target.source=known ? "estimated" : "unknown";target.ledger=true;
      if (typeof data.responseId === "string" && data.responseId) target.responseId=data.responseId;
    }
  }
  // Entries can be reserialized with different IDs, and v1 logs have no IDs.
  // Prefer the server response ID; otherwise use timestamp + model, including
  // copied history without its later ledger. Never dedupe by session filename.
  const responseAliases=new Map<string,Set<string>>();
  for (const item of messages.values()) if(item.responseId) {
    const match=`${item.time}\0${item.model}`, ids=responseAliases.get(match) ?? new Set<string>();
    ids.add(item.responseId);responseAliases.set(match,ids);
  }
  const unique=new Map<string,UsageRecord>();
  for (const item of messages.values()) {
    const match=`${item.time}\0${item.model}`, aliases=responseAliases.get(match);
    const responseId=item.responseId ?? (aliases?.size===1 ? [...aliases][0] : undefined);
    const key=responseId ? `response:${item.model}\0${responseId}` : `time:${match}`;
    const prior=unique.get(key);
    if (!prior || (item.ledger && !prior.ledger)) unique.set(key,item);
    else if (JSON.stringify(prior.usage)!==JSON.stringify(item.usage)) partial=true;
  }
  const totals=empty(), byModel=new Map<string,UsageTotals>();
  for (const item of unique.values()) {
    add(totals,item);const group=byModel.get(item.model) ?? empty();add(group,item);byModel.set(item.model,group);
  }
  return {month,timezone:"Asia/Shanghai",partial,scannedFiles,totals,byModel:[...byModel].map(([model,total])=>({model,...total})).sort((a,b)=>b.requests-a.requests)};
}
const cache=new Map<string,{expires:number;value:Promise<MonthlyUsage>}>();
export function getMonthlyUsage(month: string): Promise<MonthlyUsage> {
  bounds(month);
  const key=`${getAgentDir()}\0${month}`, existing=cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.value;
  if ([...cache.values()].filter((entry)=>entry.expires===Infinity).length >= 12) throw new WorkbenchError("usage-busy",503);
  // At most one scan at a time, including requests for different months.
  const previous=[...cache.values()].map((entry)=>entry.value);
  const value=Promise.allSettled(previous).then(()=>scanMonthlyUsage(month));
  const entry={expires:Infinity,value};cache.set(key,entry);
  value.then(()=>{entry.expires=Date.now()+30000;},()=>{cache.delete(key);});
  for (const [old,item] of cache) if (cache.size>12 && item.expires!==Infinity && old!==key) cache.delete(old);
  return value;
}
