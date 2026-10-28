import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = ['slim.js', ...['src','test','scripts'].flatMap(dir =>
 readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.js')).map(f => `${dir}/${f}`))];
for (const file of files) {
 const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
 if(result.status!==0) process.exit(result.status ?? 1);
}
console.log('JavaScript syntax checks passed');
