import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
if (!dir) throw new Error('Pass experiment directory');
const all = readFileSync(join(dir, 'trials.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const measured = all.filter(r => r.phase === 'measure');
const valid = measured.filter(r => r.success && r.exactOutput);
const median = a => { const s = [...a].sort((x,y) => x-y); return s.length ? (s[Math.floor((s.length-1)/2)] + s[Math.ceil((s.length-1)/2)]) / 2 : null; };
const quantile = (a,p) => { const s = [...a].sort((x,y) => x-y); return s[Math.floor((s.length-1)*p)]; };
let seed = 20261004;
function random() { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2**32; }
function compare(a,b) {
  const pairs = valid.filter(r => r.mode === a).map(r => [r, valid.find(s => s.round === r.round && s.mode === b)]).filter(p => p[1]);
  if (!pairs.length) return null;
  const logs = pairs.map(([x,y]) => Math.log(x.durationMs / y.durationMs));
  const estimate = Math.exp(logs.reduce((x,y)=>x+y,0)/logs.length);
  const boot = Array.from({length:10000}, () => Math.exp(Array.from({length:logs.length}, () => logs[Math.floor(random()*logs.length)]).reduce((x,y)=>x+y,0)/logs.length));
  return { baseline:a, candidate:b, pairedRounds:pairs.length, candidateFasterRounds:pairs.filter(([x,y])=>y.durationMs<x.durationMs).length,
    geometricMeanSpeedup:estimate, bootstrap95PercentInterval:[quantile(boot,0.025),quantile(boot,0.975)],
    pairedSpeedups:pairs.map(([x,y])=>({round:x.round,speedup:x.durationMs/y.durationMs})) };
}
const summary = {
  measuredTrials: measured.length, validTrials: valid.length,
  groups: Object.fromEntries(['standard','fast','ultrafast'].map(mode => {
    const rows = valid.filter(r=>r.mode===mode);
    return [mode, { n: rows.length,
      totalSecondsMedian:median(rows.map(r=>r.durationMs/1000)),
      totalSecondsRange:rows.length ? [Math.min(...rows.map(r=>r.durationMs/1000)),Math.max(...rows.map(r=>r.durationMs/1000))] : null,
      firstTextSecondsMedian:median(rows.map(r=>r.firstTextMs/1000)),
      endToEndTokensPerSecondMedian:median(rows.map(r=>r.endToEndTokensPerSecond)),
      visibleOutputWindowTokensPerSecondMedian:median(rows.map(r=>r.usage.output/((r.lastTextMs-r.firstTextMs)/1000))),
      outputTokens:[...new Set(rows.map(r=>r.usage.output))], reasoningTokens:[...new Set(rows.map(r=>r.usage.reasoning))],
      cacheReadTokens:[...new Set(rows.map(r=>r.usage.cacheRead))], reportedTiers:[...new Set(rows.map(r=>r.reportedTier))],
      responseModels:[...new Set(rows.map(r=>r.responseModel))],
    }];
  })),
  comparisons:[compare('standard','fast'),compare('standard','ultrafast'),compare('ultrafast','fast')],
  allTrialsUsage: all.reduce((acc,r)=>({input:acc.input+(r.usage?.input||0),output:acc.output+(r.usage?.output||0),cacheRead:acc.cacheRead+(r.usage?.cacheRead||0)}),{input:0,output:0,cacheRead:0}),
  note:'Paired block bootstrap intervals are exploratory with only 8 rounds; not proof of internal tier assignment or general task performance. Preflight excluded from performance summaries.',
};
writeFileSync(join(dir,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
