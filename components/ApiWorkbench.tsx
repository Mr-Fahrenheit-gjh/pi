"use client";
import { runtimeFetch as fetch } from "@/lib/runtime-client.mjs";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchOptions, WorkbenchSnapshot } from "@/lib/openai-api-workbench";
import type { MonthlyUsage } from "@/lib/openai-api-usage";
import { ConfigPanelShell, ConfigDetail, ConfigDetailStack, ConfigDetailHeader, ConfigDetailHeaderInfo, ConfigDetailTitle, ConfigDetailActions, ConfigField, ConfigSectionTitle, ConfigFooter, ConfigButton } from "./SettingsUi";

const tierLabels = {inherit:"",default:"Standard",priority:"Fast",ultrafast:"Ultrafast",flex:"Flex"};
const links = [
  ["usage", "https://platform.openai.com/usage"],
  ["limits", "https://platform.openai.com/settings/organization/limits"],
  ["billing", "https://platform.openai.com/settings/organization/billing/overview"],
  ["docs", "https://developers.openai.com/api/docs/guides/prompt-caching"],
] as const;
const usd = (value: number) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:6}).format(value);
const count = (value: number) => value.toLocaleString();
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url,init);
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "workbench-unavailable");
  return data as T;
}
export function ApiWorkbench({onClose,onManageKeys}: {onClose:()=>void;onManageKeys:()=>void}) {
  const {t} = useI18n();
  const [snapshot,setSnapshot] = useState<WorkbenchSnapshot|null>(null);
  const [modelId,setModelId] = useState("");
  const [options,setOptions] = useState<WorkbenchOptions|null>(null);
  const [repair,setRepair] = useState(false), [unify,setUnify] = useState(false);
  const [busy,setBusy] = useState(false), [error,setError] = useState(""), [saved,setSaved] = useState(false);
  const [month,setMonth] = useState(()=>new Date(Date.now()+8*3600_000).toISOString().slice(0,7));
  const [usage,setUsage] = useState<MonthlyUsage|null>(null), [usageError,setUsageError] = useState(false), [usageLoading,setUsageLoading] = useState(false);
  const [usageRefresh,setUsageRefresh] = useState(0);
  const selected=snapshot?.models.find((model)=>model.id===modelId);
  const chatModels=snapshot?.models.filter((model)=>model.capability==="chat") ?? [];
  const specialized=snapshot?.models.filter((model)=>model.capability!=="chat") ?? [];
  const selectModel=(id: string, data=snapshot) => {
    const model=data?.models.find((item)=>item.id===id);
    setModelId(id);setOptions(model?.options ?? null);setRepair(false);setUnify(false);setSaved(false);
  };
  useEffect(()=>{
    let active=true;
    json<WorkbenchSnapshot>("/api/openai-workbench").then(data=>{
      if (!active) return;
      setSnapshot(data);
      const model=data.models.find(item=>item.id==="gpt-6.1-sol") ?? data.models.find(item=>item.capability==="chat");
      if(model){setModelId(model.id);setOptions(model.options);}
    }).catch(err=>{if(active)setError(err.message);});
    return ()=>{active=false;};
  },[]);
  useEffect(()=>{
    const abort=new AbortController();
    setUsageLoading(true);setUsageError(false);setUsage(null);
    json<MonthlyUsage>(`/api/openai-workbench/usage?month=${encodeURIComponent(month)}`,{signal:abort.signal})
      .then(data=>{if(!abort.signal.aborted)setUsage(data);})
      .catch(()=>{if(!abort.signal.aborted)setUsageError(true);})
      .finally(()=>{if(!abort.signal.aborted)setUsageLoading(false);});
    return ()=>abort.abort();
  },[month,usageRefresh]);
  const change=<K extends keyof WorkbenchOptions>(key:K,value:WorkbenchOptions[K])=>{
    if(options)setOptions({...options,[key]:value});setSaved(false);
  };
  const save=async()=>{
    if(!snapshot || !selected || !options)return;
    setBusy(true);setError("");setSaved(false);
    try {
      const result=await json<{revision:string}>("/api/openai-workbench",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({modelId,expectedRevision:snapshot.revision,options,repair,clearThinkingOverrides:unify})});
      setSnapshot({...snapshot,revision:result.revision});
      setSaved(true);
      // A successful write must remain a success even if the subsequent offline runtime refresh fails.
      try {const data=await json<WorkbenchSnapshot>("/api/openai-workbench");setSnapshot(data);const updated=data.models.find(item=>item.id===modelId);if(updated)setOptions(updated.options);setRepair(false);setUnify(false);} catch { /* next visit retries */ }
    } catch(err) {setError(err instanceof Error ? err.message : "workbench-unavailable");}
    finally {setBusy(false);}
  };
  const errorText=error ? t(`apiWorkbench.error.${["stale-config","invalid-config","thinking-overrides","invalid-limits"].includes(error) ? error : "generic"}`) : "";
  const multiplier=options?.tier==="priority" ? 2 : options?.tier==="ultrafast" ? 6 : options?.tier==="flex" ? 0.5 : 1;
  return <ConfigPanelShell embedded title={t("apiWorkbench.title")} onClose={onClose}>
    <ConfigDetail><ConfigDetailStack className="api-workbench">
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo><ConfigDetailTitle>{t("apiWorkbench.title")}</ConfigDetailTitle><p>{t("apiWorkbench.intro")}</p></ConfigDetailHeaderInfo>
        <ConfigDetailActions><ConfigButton size="small" onClick={onManageKeys}>{t("apiWorkbench.keys")}</ConfigButton></ConfigDetailActions>
      </ConfigDetailHeader>
      <p className="api-workbench-note">{t(`apiWorkbench.auth.${snapshot?.auth ?? "loading"}`)}</p>
      {!snapshot && !error && <p role="status">{t("i18n.loading")}</p>}
      {snapshot && <>
        <ConfigField label={t("apiWorkbench.model")}><select aria-label={t("apiWorkbench.model")} value={modelId} onChange={event=>selectModel(event.target.value)} disabled={busy}>
          {!chatModels.length && <option value="">{t("apiWorkbench.noModels")}</option>}
          {chatModels.map(model=><option key={model.id} value={model.id}>{model.id}</option>)}
        </select></ConfigField>
        {selected && options && <>
          <p className="api-workbench-note">{t(selected.reasoning ? "apiWorkbench.reasoning" : "apiWorkbench.noReasoning")} · {t(selected.imageInput ? "apiWorkbench.imageInput" : "apiWorkbench.textInput")}</p>
          {!selected.editable && <p className="api-workbench-note">{t("apiWorkbench.readOnly")}</p>}
          <fieldset disabled={busy || !selected.editable} className="api-workbench-fields">
            <div className="api-workbench-grid">
              <ConfigField label={t("apiWorkbench.tier")}><select aria-label={t("apiWorkbench.tier")} value={options.tier} onChange={event=>change("tier",event.target.value as WorkbenchOptions["tier"])}>
                <option value="inherit">{t("apiWorkbench.unchanged")}</option>
                {selected.tiers.map(tier=><option key={tier} value={tier}>{tierLabels[tier]}</option>)}
              </select></ConfigField>
              <ConfigField label={t("apiWorkbench.cache")}><select aria-label={t("apiWorkbench.cache")} value={options.cache} onChange={event=>change("cache",event.target.value as WorkbenchOptions["cache"])}>
                <option value="inherit">{t("apiWorkbench.unchanged")}</option>
                <option value="30m">{t("apiWorkbench.cache30m")}</option><option value="12h">{t("apiWorkbench.cache12h")}</option><option value="off">{t("apiWorkbench.cacheOff")}</option>
              </select></ConfigField>
            </div>
            <p className="api-workbench-note">{t("apiWorkbench.tierHint")}</p>
            <p className="api-workbench-note">{t("apiWorkbench.cacheHint")}</p>
            <details><summary>{t("apiWorkbench.advanced")}</summary>
              <div className="api-workbench-grid">
                <ConfigField label={t("apiWorkbench.context")}><input type="number" aria-label={t("apiWorkbench.context")} min={1024} max={1050000} value={options.contextWindow} onChange={event=>change("contextWindow",Number(event.target.value))}/></ConfigField>
                <ConfigField label={t("apiWorkbench.output")}><input type="number" aria-label={t("apiWorkbench.output")} min={16} max={128000} value={options.maxTokens} onChange={event=>change("maxTokens",Number(event.target.value))}/></ConfigField>
                <ConfigField label={t("apiWorkbench.verbosity")}><select aria-label={t("apiWorkbench.verbosity")} value={options.verbosity} onChange={event=>change("verbosity",event.target.value as WorkbenchOptions["verbosity"])}>
                  <option value="inherit">{t("apiWorkbench.unchanged")}</option>{(["low","medium","high"] as const).map(value=><option key={value} value={value}>{value}</option>)}
                </select></ConfigField>
              </div>
              <p className="api-workbench-note">{t("apiWorkbench.contextHint")}</p>
            </details>
            {selected.needsRepair && <label className="api-workbench-check"><input type="checkbox" checked={repair} onChange={event=>{setRepair(event.target.checked);setSaved(false);}}/>{t("apiWorkbench.repair")}</label>}
            {selected.thinkingOverrides && <label className="api-workbench-check"><input type="checkbox" checked={unify} onChange={event=>{setUnify(event.target.checked);setSaved(false);}}/>{t("apiWorkbench.unify")}</label>}
          </fieldset>
          {selected.rates && <div className="api-workbench-note"><p>{t("apiWorkbench.rates")}</p><p>
            {t("apiWorkbench.input")}: {usd(selected.rates.input*multiplier)} · {t("apiWorkbench.outputTokens")}: {usd(selected.rates.output*multiplier)} · {t("apiWorkbench.cacheRead")}: {usd(selected.rates.cacheRead*multiplier)} · {t("apiWorkbench.cacheWrite")}: {usd(selected.rates.cacheWrite*multiplier*(options.cache==="12h"?2:1))}
          </p><p>{t("apiWorkbench.priceHint")}</p></div>}
          <p className="api-workbench-note">{t("apiWorkbench.activation")}</p>
        </>}
        {!!specialized.length && <details><summary>{t("apiWorkbench.specialized")} ({specialized.length})</summary><p className="api-workbench-note">{t("apiWorkbench.specializedHint")}</p><ul className="api-workbench-models">{specialized.map(model=><li key={model.id}><code>{model.id}</code> — {t(`apiWorkbench.capability.${model.capability}`)}</li>)}</ul></details>}
      </>}
      {errorText && <p role="alert" className="settings-general-error">{errorText}</p>}
      <ConfigFooter status={<span role="status">{saved ? t("apiWorkbench.saved") : t("apiWorkbench.target")}</span>}>
        <ConfigButton variant="primary" disabled={busy || !selected?.editable} onClick={()=>void save()}>{busy?t("i18n.loading"):t("i18n.save")}</ConfigButton>
      </ConfigFooter>
      <section className="api-workbench-usage" aria-label={t("apiWorkbench.monthly")}>
        <ConfigDetailHeader><ConfigSectionTitle>{t("apiWorkbench.monthly")}</ConfigSectionTitle><ConfigDetailActions>
          <input type="month" aria-label={t("apiWorkbench.month")} min="2000-01" max="2100-12" value={month} onChange={event=>{if(event.target.value)setMonth(event.target.value);}}/>
          <ConfigButton size="small" disabled={usageLoading} onClick={()=>setUsageRefresh(value=>value+1)}>{t("i18n.refresh")}</ConfigButton>
        </ConfigDetailActions></ConfigDetailHeader>
        <p className="api-workbench-note">{t("apiWorkbench.usageHint")}</p>
        {usageLoading && <p role="status">{t("i18n.loading")}</p>}{usageError && <p role="alert">{t("apiWorkbench.usageError")}</p>}
        {usage && <>
          {usage.partial && <p role="alert" className="api-workbench-warning">{t("apiWorkbench.partial")}</p>}
          <p>{t("apiWorkbench.requests")}: {count(usage.totals.requests)} · {t("apiWorkbench.estimate")}: {usd(usage.totals.estimatedCostUsd)}</p>
          <p className="api-workbench-note">{t("apiWorkbench.legacy")}: {usage.totals.legacyRequests} · {t("apiWorkbench.unknown")}: {usage.totals.unknownRequests}</p>
          <div className="api-workbench-table"><table><thead><tr><th>{t("apiWorkbench.model")}</th><th>{t("apiWorkbench.requests")}</th><th>{t("apiWorkbench.input")}</th><th>{t("apiWorkbench.outputTokens")}</th><th>{t("apiWorkbench.cacheRead")}</th><th>{t("apiWorkbench.cacheWrite")}</th><th>{t("apiWorkbench.estimate")}</th><th>{t("apiWorkbench.unknown")}</th></tr></thead>
          <tbody>{usage.byModel.map(row=><tr key={row.model}><td>{row.model}</td><td>{count(row.requests)}</td><td>{count(row.input)}</td><td>{count(row.output)}</td><td>{count(row.cacheRead)}</td><td>{count(row.cacheWrite)}</td><td>{usd(row.estimatedCostUsd)}</td><td>{row.unknownRequests}</td></tr>)}</tbody></table></div>
          {!usage.totals.requests && <p className="api-workbench-note">{t("apiWorkbench.emptyUsage")}</p>}
        </>}
        <nav className="api-workbench-links">{links.map(([name,href])=><a key={name} href={href} target="_blank" rel="noopener noreferrer">{t(`apiWorkbench.link.${name}`)}</a>)}</nav>
        <p className="api-workbench-note">{t("apiWorkbench.budgetHint")}</p>
        <p className="api-workbench-note">{t("apiWorkbench.batchHint")} <a href="https://developers.openai.com/api/docs/guides/batch" target="_blank" rel="noopener noreferrer">Batch API ↗</a></p>
      </section>
    </ConfigDetailStack></ConfigDetail>
  </ConfigPanelShell>;
}
