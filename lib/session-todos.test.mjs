import assert from "node:assert/strict";
import test from "node:test";
import {createJiti} from "jiti";
const jiti=createJiti(import.meta.url);
const {readSessionTodos}=await jiti.import("./session-todos.ts");
const task=(id,status="pending")=>({id,subject:"Task "+id,status});
const state=tasks=>({type:"custom",customType:"rpiv-todo-state",data:{tasks,nextId:10}});
const legacy=tasks=>({type:"message",message:{role:"toolResult",toolName:"todo",details:{tasks,nextId:10}}});
test("reads authoritative custom state even when stale tool results follow it",()=>{
 assert.deepEqual(readSessionTodos([legacy([task(1)]),state([task(2,"in_progress")]),legacy([task(1)])]),[task(2,"in_progress")]);
});
test("last state wins including clear, without tombstoned or malformed records",()=>{
 assert.deepEqual(readSessionTodos([state([task(1)]),state([task(2),task(3,"deleted"),{id:4,status:"pending"}])]),[task(2)]);
 assert.deepEqual(readSessionTodos([state([task(1)]),state([])]),[]);
});
test("supports legacy history and ignores unrelated/custom corrupt payloads",()=>{
 assert.deepEqual(readSessionTodos([legacy([task(1,"completed")])]),[task(1,"completed")]);
 assert.deepEqual(readSessionTodos([{type:"custom",customType:"other",data:{tasks:[task(1)],nextId:2}},null,{type:"custom",customType:"rpiv-todo-state",data:"bad"}]),[]);
});
test("tombstones never hide later active tasks",()=>{
 const deleted=Array.from({length:1000},(_,id)=>task(id,"deleted"));
 assert.deepEqual(readSessionTodos([state([...deleted,task(1001,"in_progress")])]),[task(1001,"in_progress")]);
});

test("does not mutate persisted tasks or infer todos from text",()=>{
 const entry=state([task(1)]); const output=readSessionTodos([entry]);output[0].subject="changed";
 assert.equal(entry.data.tasks[0].subject,"Task 1");
 assert.deepEqual(readSessionTodos([{type:"message",message:{role:"assistant",content:"Task 1 pending"}}]),[]);
});
