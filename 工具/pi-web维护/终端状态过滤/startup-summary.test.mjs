import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { patchStartupSummary } from './startup-summary.mjs';

const coreRoot = process.env.PI_CORE_ROOT || '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const source = readFileSync(join(coreRoot, 'dist/modes/interactive/interactive-mode.js'), 'utf8');
const patched = patchStartupSummary(source);

function render(skills, diagnostics = []) {
    const start = patched.indexOf('    showLoadedResources(options) {');
    const end = patched.indexOf('\n    /**', start);
    const children = [];
    const theme = { fg: (_color, text) => text };
    class ExpandableText {
        constructor(collapsed, expanded) { this.collapsed = collapsed; this.expanded = expanded; }
    }
    class Spacer {}
    class ThemedText { constructor(body) { this.body = body; } }
    const method = runInNewContext(`({${patched.slice(start, end)}}).showLoadedResources`, {
        theme, ExpandableText, Spacer, ThemedText,
    });
    const ctx = {
        loadedResourcesContainer: { clear() { children.length = 0; }, addChild(child) { children.push(child); } },
        shouldShowStartupDetails: () => true,
        getStartupExpansionState: () => false,
        buildScopeGroups: (items) => items,
        formatScopeGroups: (items) => items.map((item) => item.path).join('\n'),
        formatDiagnostics: (items) => items.map((item) => item.message).join('\n'),
        session: {
            promptTemplates: [],
            resourceLoader: {
                getSkills: () => ({ skills, diagnostics }),
                getPrompts: () => ({ prompts: [], diagnostics: [] }),
                getThemes: () => ({ themes: [], diagnostics: [] }),
                getExtensions: () => ({ extensions: [], errors: [], warnings: [] }),
                getSystemPromptSource: () => null,
                getAppendSystemPromptSources: () => [],
                getAgentsFiles: () => ({ agentsFiles: [] }),
            },
            extensionRunner: { getCommandDiagnostics: () => [], getShortcutDiagnostics: () => [] },
        },
        getBuiltInCommandConflictDiagnostics: () => [],
    };
    method.call(ctx);
    return children;
}

test('many skills collapse to one bounded row with count, preserving the full expanded list', () => {
    const skills = Array.from({ length: 100 }, (_, i) => ({ name: `skill-${String(i).padStart(3, '0')}`, filePath: `/skills/${i}/SKILL.md` }));
    const rows = render(skills);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.collapsed(), 'Skills     100  skill-000 · skill-001 · skill-002  … +97');
    assert.equal(row.collapsed().split('\n').length, 1);
    assert.equal(row.expanded(), '[Skills]\n' + skills.map((skill) => skill.filePath).join('\n'));
});

test('long names are shortened by codepoint and small lists have no remainder badge', () => {
    const [row] = render([{ name: '😀'.repeat(40), filePath: '/full/path' }]);
    assert.ok(row.collapsed().includes('😀'.repeat(23) + '…'));
    assert.ok(!row.collapsed().includes('+'));
    assert.ok(row.expanded().includes('/full/path'));
});

test('empty categories stay hidden and warnings stay visible in full', () => {
    assert.equal(render([]).length, 0);
    const rows = render([], [{ message: 'Conflicting skill: investigate this path' }]);
    assert.equal(rows[0].body(), '[Skill conflicts]\nConflicting skill: investigate this path');
});

test('the actual CLI bundle has the same bounded summary and remains valid JavaScript', () => {
    const dir = join(coreRoot, 'dist/bundle/chunks');
    const matches = readdirSync(dir).filter((name) => name.endsWith('.js'))
        .map((name) => readFileSync(join(dir, name), 'utf8'))
        .filter((text) => text.includes('showLoadedResources(options){'));
    assert.equal(matches.length, 1, 'expected one CLI resource renderer');
    const output = patchStartupSummary(matches[0]);
    assert.equal(patchStartupSummary(output), output);
    const start = output.indexOf('formatCompactList=(items,options2)=>') + 'formatCompactList='.length;
    const end = output.indexOf(',addLoadedSection=', start);
    const format = runInNewContext('(' + output.slice(start, end) + ')', { theme: { fg: (_color, text) => text } });
    assert.equal(format(['d', 'c', 'b', 'a']), '  4  a · b · c  … +1');
    assert.equal(format(['d', 'c'], {sort: false}), '  2  d · c');
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: output, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
});

test('patch is idempotent and refuses an unknown or partially patched core', () => {
    assert.equal(patchStartupSummary(patched), patched);
    assert.throws(() => patchStartupSummary('unknown version'), /refusing to patch/);
    assert.throws(() => patchStartupSummary(patched.replace('preview = labels.slice(0, 3)', 'preview = labels.slice(0, 2)')), /refusing to patch/);
});
