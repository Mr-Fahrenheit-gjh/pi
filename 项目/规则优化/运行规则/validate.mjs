import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import { buildSystemPrompt } from '/opt/homebrew/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js';

const here = import.meta.dirname;
const root = path.resolve(here, '../../..');
assert.ok(process.argv.slice(2).every(arg => arg === '--source'), '只支持显式 --source；默认严格校验运行副本');
const sourceOnly = process.argv.includes('--source');
const runtimeAgentDir = path.join(homedir(), '.pi/agent');
const read = p => readFileSync(p, 'utf8');
const pairs = [
  ['APPEND_SYSTEM.md', 'APPEND_SYSTEM.md'],
  ['references/execution.md', 'rules/execution.md'],
  ['references/delegation.md', 'rules/delegation.md'],
  ['browser-harness/SKILL.md', 'skills/browser-harness/SKILL.md'],
];
const append = read(path.join(here, 'APPEND_SYSTEM.md'));
const agents = read(path.join(root, 'AGENTS.md'));
const execution = read(path.join(here, 'references/execution.md'));
const delegation = read(path.join(here, 'references/delegation.md'));
const repositories = read(path.join(here, 'references/repositories.md'));
const browser = read(path.join(here, 'browser-harness/SKILL.md'));
const checks = [];
const failures = [];
const check = (name, fn) => {
  try { fn(); checks.push(name); }
  catch (error) { failures.push({ name, error: error.message }); }
};
// 预算按 UTF-16 字符计，不是 token；先清重，再分别限制两层及总量。
const residentBudget = { global: 1100, workspace: 1250, total: 2350 };
const temporary = mkdtempSync(path.join(tmpdir(), 'pi-layered-loading-'));
const agentDir = sourceOnly ? path.join(temporary, 'agent') : runtimeAgentDir;
if (sourceOnly) {
  for (const [source, destination] of pairs) {
    const target = path.join(agentDir, destination);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(here, source), target);
  }
}
const skipped = sourceOnly ? ['运行副本一致性及运行目录覆盖文件/手动技能状态（--source 不证明启用）'] : [];
const includesAll = (body, terms) => terms.forEach(term => assert.ok(body.includes(term), term));

if (!sourceOnly) check('四份运行文件与版本源一致', () => {
  for (const [source, destination] of pairs) assert.ok(read(path.join(agentDir, destination)) === read(path.join(here, source)), `pending drift: ${destination}；未启用源码，须另获同步/重载授权`);
});
check('常驻入口保持预算，不恢复全局AGENTS或替换SYSTEM', () => {
  assert.ok(append.length <= residentBudget.global, `global ${append.length} > ${residentBudget.global}`);
  assert.ok(agents.length <= residentBudget.workspace, `workspace ${agents.length} > ${residentBudget.workspace}`);
  assert.ok(append.length + agents.length <= residentBudget.total, '常驻入口总预算超限');
  assert.ok(!existsSync(path.join(agentDir, 'SYSTEM.md')));
  assert.ok(!existsSync(path.join(agentDir, 'AGENTS.md')));
});
check('重要边界保留在常驻入口，不藏到参考文件', () => {
  includesAll(append, ['不扩大范围', '依赖变更', '全局安装', '系统配置', '最小相关验证', '未验证', '不要求每次批准', 'Hy-Memory 六工具', '`content / target / scope`', '同步落盘回读', '不要重发写操作', '不把未确认保存说成已保存']);
  assert.ok(!/回复后静默保存|timing:\s*now/.test(append), '不得恢复旧记忆保存时序');
  includesAll(agents, ['launchctl', 'sudo', '只暂存相关文件', '不覆盖他人暂存', '改写历史或推送', '私密运行数据', '未完成', '锁文件']);
});
check('工程任务默认pstack，重要边界先澄清', () => {
  includesAll(append, ['所有工程类任务', '不论大小', '`pstack`', '先澄清', '可查事实先自行核实', '不重复询问已确认事项', '不擅自安装或冒充已调用']);
  const pstack = read(path.join(root, '.pi/skills/pstack/entry/SKILL.md'));
  includesAll(pstack, ['所有工程类任务默认使用', '小改动不机械展开完整流程', '先澄清']);
  includesAll(append, ['~/.pi/agent/skills/grilling/SKILL.md', '每次只问一个未决决策并给建议', '等回答再继续', '动手前须用户确认理解一致']);
  if (!sourceOnly) assert.match(read(path.join(agentDir, 'skills/grilling/SKILL.md')), /^disable-model-invocation: true$/m);
});
check('按需入口路径存在，正文无自动导入语法', () => {
  for (const name of ['execution', 'delegation']) assert.ok(existsSync(path.join(agentDir, 'rules', `${name}.md`)));
  for (const name of ['README.md', 'references/repositories.md']) assert.ok(existsSync(path.join(here, name)));
  assert.ok(existsSync(path.join(root, '.pi/skills/pi-web-maintenance/SKILL.md')));
  assert.ok(!/^@\S+/m.test(append + agents));
  includesAll(append, ['先读', '只读命中当前任务']);
});
check('委派、恢复与仓库约束仍有权威入口', () => {
  includesAll(delegation, ['尽早委派', '继续不同的主线工作', '默认只读', '一个写入者', '不授予额外权限', 'task_wait', '本机实际通知契约', '基础设施失败', '完整工具与技能', '不完整重做', 'fresh']);
  includesAll(execution, ['中断不等于取消', '最近原始记录和实际状态文件', '不删除用途不明的文件', '当前工作目录内']);
  includesAll(repositories, ['独立仓库.json', 'revision/branch', '不是子模块', '共用 Git 公共目录', '分别确认', '禁止用', '守卫发布']);
});
check('浏览器扩展授权替换旧禁令，未放开日常profile调试或桌面控制', () => {
  includesAll(browser, ['用户已允许', 'OpenCLI 扩展', '不需每次重复询问', '只绑定', '无关标签页', 'opencli doctor', 'remote-debugging', 'osascript', '任务结束时不能关闭它们']);
  assert.ok(!agents.includes('禁止连接用户正在使用的 Chrome'));
  assert.ok(!browser.includes('或使用日常 Chrome 的 profile。'));
});

const loading = [];
const outside = path.join(temporary, 'outside');
mkdirSync(outside);
try {
  for (const cwd of [root, here, outside]) {
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: SettingsManager.inMemory({}),
      noExtensions: true, noPromptTemplates: true, noThemes: true,
      ...(sourceOnly ? { noSkills: true, additionalSkillPaths: [path.join(agentDir, 'skills/browser-harness/SKILL.md')] } : {}),
    });
    await loader.reload();
    assert.equal(loader.getSystemPrompt(), undefined, '保留Pi内置提示词');
    assert.ok(loader.getAppendSystemPrompt().join('\n').trim() === append.trim(), 'pending drift: SDK实际APPEND与版本源不同；该运行级加载未通过，须另获同步/重载授权');
    const { agentsFiles } = loader.getAgentsFiles();
    const workspaceContext = agentsFiles.find(file => path.resolve(file.path) === path.join(root, 'AGENTS.md'));
    if (cwd === outside) assert.equal(workspaceContext, undefined, '工作区规则不能泄漏到外部目录');
    else assert.equal(workspaceContext?.content, agents, '根目录与子目录均继承工作区短规则');
    const { skills, diagnostics } = loader.getSkills();
    const skill = skills.find(s => s.name === 'browser-harness');
    assert.ok(skill);
    assert.equal(path.resolve(skill.filePath), path.join(agentDir, 'skills/browser-harness/SKILL.md'));
    assert.ok(!diagnostics.some(d => d.path === skill.filePath), '浏览器技能无加载诊断');
    const prompt = buildSystemPrompt({ cwd, appendSystemPrompt: append, contextFiles: agentsFiles, skills });
    includesAll(prompt, [skill.description, '以下替代内置 Pi 文档的无条件通读要求']);
    for (const body of [execution, delegation, repositories, browser]) assert.ok(!prompt.includes(body.trim()), '参考或技能正文不得常驻');
    assert.ok(prompt.indexOf('以下替代内置 Pi 文档') > prompt.indexOf('Always read pi .md files completely'), '补充规则位于内置规则之后');
    loading.push({ scope: cwd === root ? '工作区' : cwd === here ? '工作区子目录' : '独立临时目录', workspaceContext: Boolean(workspaceContext), browserSkill: true, referenceBodiesInPrompt: false });
  }
  checks.push('安装SDK三种目录实际加载：短入口常驻，参考与技能正文不常驻');
} catch (error) {
  failures.push({ name: '安装SDK分层加载', error: error.message });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: failures.length === 0, mode: sourceOnly ? 'source' : 'runtime', checks, failures, skipped,
  residentBudget, residentCharacters: { global: append.length, workspace: agents.length, total: append.length + agents.length }, loading,
  scope: sourceOnly ? '无凭据临时agent目录，从版本源装载；未检查运行副本、未启用。关闭扩展、不调用模型/网络，不代表完整系统提示总量或模型行为/性能验收。'
    : '运行副本一致性与新进程SDK资源加载；关闭扩展、不调用模型、不重启服务，不代表已有会话已加载或模型行为/性能验收。' }, null, 2));
if (failures.length) process.exitCode = 1;
