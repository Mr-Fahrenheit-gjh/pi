// A guarded, display-only patch for Pi's built-in resource listing.
// Returns source only: callers own installation, backup and reload authorization.
const originalList = `            return theme.fg("dim", \`  \${labels.join(", ")}\`);`;
const summaryList = `            const preview = labels.slice(0, 3).map((label) =>
                Array.from(label).length > 24 ? Array.from(label).slice(0, 23).join("") + "…" : label);
            const remaining = labels.length - preview.length;
            return theme.fg("accent", String(labels.length).padStart(3)) +
                theme.fg("dim", "  " + preview.join(" · ") + (remaining > 0 ? "  … +" + remaining : ""));`;
const originalSection = '() => `${sectionHeader(name, color)}\\n${collapsedBody()}`';
const summarySection = '() => `${theme.fg(color, name.padEnd(10))} ${collapsedBody()}`';

function replaceOnce(source, before, after) {
    const count = source.split(before).length - 1;
    if (count !== 1) throw new Error(`Startup summary patch: expected one matching block, got ${count}; core changed, refusing to patch.`);
    return source.replace(before, () => after);
}

export function patchStartupSummary(source) {
    if (source.includes('showLoadedResources(options){')) return patchBundledStartupSummary(source);
    if (source.includes(summaryList) && source.includes(summarySection)) return source;
    source = replaceOnce(source, originalList, summaryList);
    source = replaceOnce(source, originalSection, summarySection);
    // Keep normal rows adjacent; preserve spacing around warnings and diagnostics.
    return replaceOnce(source,
        '            this.loadedResourcesContainer.addChild(section);\n            this.loadedResourcesContainer.addChild(new Spacer(1));',
        '            this.loadedResourcesContainer.addChild(section);');
}

// The shipped `pi` executable loads a minified chunk, not the standalone module.
const bundledList = 'theme.fg("dim",`  ${labels.join(", ")}`)';
const bundledSummary = '(()=>{const preview=labels.slice(0,3).map(label=>Array.from(label).length>24?Array.from(label).slice(0,23).join("")+"…":label),remaining=labels.length-preview.length;return theme.fg("accent",String(labels.length).padStart(3))+theme.fg("dim","  "+preview.join(" · ")+(remaining>0?"  … +"+remaining:""))})()';
const bundledSection = '()=>`${sectionHeader(name,color)}\n${collapsedBody()}`';
const bundledSummarySection = '()=>`${theme.fg(color,name.padEnd(10))} ${collapsedBody()}`';
function patchBundledStartupSummary(source) {
    if (source.includes(bundledSummary) && source.includes(bundledSummarySection)) return source;
    source = replaceOnce(source, bundledList, bundledSummary);
    source = replaceOnce(source, bundledSection, bundledSummarySection);
    return replaceOnce(source,
        'this.loadedResourcesContainer.addChild(section),this.loadedResourcesContainer.addChild(new Spacer(1))',
        'this.loadedResourcesContainer.addChild(section)');
}
