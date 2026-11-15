import {prepareFixture} from './web-fixture.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export function prepareHistoryFixture(agentDir) {
  const fixture=prepareFixture(agentDir);
  const provider=join(agentDir,'test-provider.ts');
  let code=readFileSync(provider,'utf8');
  code='import {appendFileSync} from "node:fs";\n'+code;
  code=code.replace('const text = JSON.stringify(context.messages).includes("SUGGESTION MODE") ? "帮我运行相关测试" : "候选主回复完成";',`const suggestion = JSON.stringify(context.messages).includes("SUGGESTION MODE");
        const input = JSON.stringify(context.messages);
        appendFileSync(${JSON.stringify(join(agentDir,'model-calls.jsonl'))}, JSON.stringify({kind:suggestion?"suggestion":"main",context:suggestion?input:undefined})+"\\n");
        const text = suggestion ? (input.includes("open-A") ? "说明A这轮结果的用法" : "说明B这轮结果的用法") : "候选主回复完成";`);
  writeFileSync(provider,code);
  for (const [letter,turns] of [['a',6],['b',1]]) {
    const path=join(agentDir,'sessions/test',`suggestions-${letter}.jsonl`);
    const entries=readFileSync(path,'utf8').trim().split('\n').map(JSON.parse).slice(0,3);
    let parent='model';
    for (let i=0;i<turns;i++) {
      const user={type:'message',id:`user-${i}`,parentId:parent,timestamp:new Date().toISOString(),message:{role:'user',content:`open-${letter.toUpperCase()} user-${i}`,timestamp:Date.now()}};
      const original=JSON.parse(readFileSync(path,'utf8').trim().split('\n').at(-1));
      const assistant={...original,id:`answer-${i}`,parentId:user.id,message:{...original.message,content:[{type:'text',text:`open-${letter.toUpperCase()} answer-${i}`}]} };
      entries.push(user,assistant);parent=assistant.id;
    }
    writeFileSync(path,entries.map(entry=>JSON.stringify(entry)).join('\n')+'\n');
  }
  return fixture;
}
