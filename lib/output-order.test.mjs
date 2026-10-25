import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const { sortOutputPaths } = await createJiti(import.meta.url).import('./output-order.ts');

test('reading material precedes unknown files and engineering files, preserving recency within tiers', () => {
  const paths = ['/project/app.tsx', '/project/report.PDF', '/project/archive.zip', '/project/report.md', '/project/config.yaml', '/project/chart.png', '/project/README', '/project/slides.pptx', '/project/model.xlsx', '/project/index.html'];
  const original = [...paths];
  assert.deepEqual(sortOutputPaths(paths), [paths[1], paths[3], paths[5], paths[7], paths[8], paths[9], paths[2], paths[6], paths[0], paths[4]]);
  assert.deepEqual(paths, original, 'must not mutate hook-owned paths');
});

test('common engineering dotfiles and extensionless build files stay below documents', () => {
  const paths = ['C:\\work\\Dockerfile', '/work/CMakeLists.txt', '/work/.env.local', '/work/Makefile', '/work/.gitignore', '/work/package.json', '/work/run.sh', '/work/report.txt', '/work/summary.docx', '/work/data.csv'];
  assert.deepEqual(sortOutputPaths(paths), [...paths.slice(7), ...paths.slice(0, 7)]);
});

test('empty and homogeneous lists retain their order and exact opening paths', () => {
  assert.deepEqual(sortOutputPaths([]), []);
  for (const paths of [['/tmp/中文 #1.pdf', '/tmp/a.md'], ['/tmp/a.py', '/tmp/a.ts'], ['/tmp/a.zip', '/tmp/unknown']]) {
    assert.deepEqual(sortOutputPaths(paths), paths);
  }
});
