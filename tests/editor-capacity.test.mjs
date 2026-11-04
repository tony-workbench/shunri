// The task editor: the 150-minute daily study limit it enforces, and how its lock
// edits interact with calendar restrictions. The editor code is taken from app.js
// and run on a real WorkspaceStore with an in-memory storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../storage.js';
import { validDate, wallInstant, addDays } from '../time.js';
import { validateIntentDays as validatePlan, moveIntent } from '../intent-planner.js';
import { validateMutation, adjustmentRecord } from '../workflow.js';
import { normalizeLearningDays } from '../learning.js';
import { parseTime, formatTime } from '../scheduler.js';
import { enqueueChanges, syncResumeProposal } from '../sync-queue.js';
import { needsCalendarCoverage, proposeRestore, archivedTasks } from '../schedule-context.js';
import { lockManualMove } from '../task-attributes.js';
import { mergeCalendar, classifyCalendar, calendarKey, canManageCalendarSource, localCalendarSignature } from '../calendar-data.js';
import { interpretCalendar } from '../calendar-semantics.js';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const extract = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
};
const day = '2026-10-12';
const task = (id, start, duration, extra = {}) => ({
  id, uid: id, title: id, start, duration, rest: 20, type: 'task', done: false, deferred: false, locked: false,
  counted: true, tags: ['study'], learning: true, planId: 'job-prepare', dependencies: [], ...extra,
});

function rig(days) {
  const kv = new Map();
  const memory = { getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => kv.set(k, v), removeItem: (k) => kv.delete(k) };
  const store = new WorkspaceStore(memory);
  store.load();
  assert.equal(store.save((s) => { s.personal.days = days; }).ok, true);
  const nodes = new Map(), notices = [];
  const context = vm.createContext({
    store, state: store.state, mode: 'personal', proposal: null, lastSaved: false, structuredClone,
    needsCalendarCoverage, proposeRestore, archivedTasks, lockManualMove, crypto: webcrypto,
    validDate, parseTime, formatTime, wallInstant, addDays,
    learningTask: (t) => t.learning || t.tags?.includes('study'),
    normalizeLearningDays, validatePlan, validateMutation, moveIntent, enqueueChanges, adjustmentRecord,
    today: () => day, demoOrigin: () => day, render() {}, notice: (...args) => notices.push(args), runSyncQueue: async () => {},
    $: (id) => { if (!nodes.has(id)) nodes.set(id, { close() {} }); return nodes.get(id); },
    data: () => context.state.personal,
    all: (days = context.state.personal.days) => Object.entries(days).flatMap(([date, tasks]) => tasks.map((t) => ({ date, task: t }))),
    find: (id) => context.all().find((e) => e.task.id === id),
    isActivity: (t) => t.type === 'activity',
    movable: (t) => !t.done && !t.locked && !t.externalReadOnly && !t.deferred && t.type !== 'activity',
    calculateMove: async (id, targetDate, targetStart, rebuild) =>
      moveIntent(rebuild(structuredClone(context.state.personal.days)), context.state.personal.settings, { taskId: id, targetDate, targetStart }),
  });
  vm.runInContext([
    extract('function save(mutator,', 'const currentDay ='),
    extract('function changeList(', 'function removeTask('),
    extract('function prepareWorkbenchProposal(', 'async function adoptLearning('),
    extract('async function saveWorkbenchTask(', 'bench = createWorkbench('),
    extract('function confirmProposal(', 'function undoLast('),
    'globalThis.actions={' + extract('  complete: (e) => {', '  saveTask: saveWorkbenchTask,') + '};',
  ].join('\n'), context);
  return {
    ctx: context, store, memory, notices, snapshot: () => JSON.stringify(store.state),
    draft: (duration, kind = 'learning') => ({ title: 'new', when: day + 'T13:20', duration, rest: 20, kind, dependencies: [], bufferBefore: 0, bufferAfter: 0, locked: false }),
  };
}

// ---- 150-minute daily study limit ----

test('creating a task that would push a day past the 150-minute study limit is rejected and leaves the saved workspace unchanged',async()=>{for(const[old,added]of[[80,80],[60,100]]){const r=rig({[day]:[task('a',660,old)]}),before=r.snapshot();const p=await r.ctx.saveWorkbenchTask(r.draft(added),null,r.store.state.revision);assert.equal(p.result.status,'conflict');assert.match(p.result.conflicts[0].message,/160 in total/);assert.equal(p.editorConflict,true);assert.equal(r.snapshot(),before);const reload=new WorkspaceStore(r.memory);reload.load();assert.equal(JSON.stringify(reload.state),before);assert.equal(p.result.alternatives.length,0,'an indivisible 160-minute original package cannot be relocated to bypass capacity');}});
test('a new task is accepted up to exactly 150 study minutes in a day, and completed work and other plans count toward that limit',async()=>{for(const n of[69,70]){const r=rig({[day]:[task('a',660,80)]});assert.equal((await r.ctx.saveWorkbenchTask(r.draft(n),null,r.store.state.revision)).ok,true);assert.equal(validatePlan(r.store.state.personal.days,r.store.state.personal.settings).daily.find(d=>d.date===day).learningFocus,80+n);}
 for(const extra of[{done:true,completedDate:day},{planId:'another'},{done:true,doneAt:'2026-10-13T00:00:00Z'}]){const r=rig({[day]:[task('a',660,80,extra)]}),before=r.snapshot();const p=await r.ctx.saveWorkbenchTask(r.draft(80),null,r.store.state.revision);assert.equal(p.result.status,'conflict');assert.equal(r.snapshot(),before);}});
test('editing a task is rejected when it grows a day past 150 minutes, but an already over-full day may shrink and may not grow further',async()=>{for(const[original,next,expected]of[[70,90,'conflict'],[80,75,'ok'],[80,90,'conflict']]){const r=rig({[day]:[task('a',660,original),task('b',800,original)]}),before=r.snapshot(),draft={...r.draft(next),title:'a',when:day+'T11:00'};const p=await r.ctx.saveWorkbenchTask(draft,r.ctx.find('a'),r.store.state.revision);assert.equal(p.result.status,expected);assert.equal(r.snapshot(),before);if(expected==='ok'){r.ctx.confirmProposal();assert.equal(r.store.state.personal.days[day].find(t=>t.id==="a").duration,next);}}});
test('existing overlaps between fixed events and excess study time on other dates do not block an unrelated valid edit',async()=>{const r=rig({[day]:[task('fixed1',540,60,{type:'activity',locked:true,tags:[],learning:false}),task('fixed2',550,60,{type:'activity',locked:true,tags:[],learning:false})],'2026-10-20':[task('x',660,80),task('y',800,80)]});assert.equal((await r.ctx.saveWorkbenchTask(r.draft(30,'task'),null,r.store.state.revision)).ok,true);});
test('completing a task or undoing a completion is refused when it would move completed work into a day over the study limit',()=>{const r=rig({[day]:[task('a',660,80,{done:true,completedDate:'2026-10-13'}),task('b',800,80)]}),before=r.snapshot();assert.equal(r.ctx.actions.complete(r.ctx.find('a')),false);assert.equal(r.snapshot(),before);
 const t=r.ctx.find('a').task;r.store.state.personal.completionUndo={id:'a',date:day,after:structuredClone(t),before:{...t,done:false}};r.ctx.state=r.store.state;const withUndo=r.snapshot();assert.equal(r.ctx.actions.undoComplete(),false);assert.equal(r.snapshot(),withUndo);});
test('confirming a proposal revalidates it and refuses an over-limit schedule even when the proposal claims to be ok',()=>{const r=rig({[day]:[task('a',660,80)]}),before=r.snapshot(),days=structuredClone(r.store.state.personal.days);days[day].push(task('b',800,80));r.ctx.proposal={mode:'personal',revision:r.store.state.revision,label:'Edit plan',settings:r.store.state.personal.settings,result:{status:'ok',days}};r.ctx.confirmProposal();assert.equal(r.snapshot(),before);assert.ok(r.ctx.proposal);assert.match(r.notices.at(-1)[0],/above the 150-minute limit/);});
test('choosing the offered next-date option recalculates the same package and dependencies, then confirms safely',async()=>{const r=rig({[day]:[task('done',540,80,{done:true,completedDate:day})]}),draft=r.draft(80),p=await r.ctx.saveWorkbenchTask(draft,null,r.store.state.revision);assert.equal(p.result.status,'conflict');assert.ok(p.result.alternatives.length);const fixed=await r.ctx.saveWorkbenchTask(draft,null,r.store.state.revision,p.result.alternatives[0]);assert.equal(fixed.result.status,'ok');assert.equal(fixed.result.days[day][0].id,'done');r.ctx.confirmProposal();assert.equal(r.ctx.proposal,null);assert.equal(validatePlan(r.store.state.personal.days,r.store.state.personal.settings).status,'ok');});
test('the capacity check counts work on its completion date and counts a restored deferred task',()=>{const before={'2026-10-11':[task('a',660,80,{done:true,completedDate:day})],[day]:[task('b',800,80,{deferred:true})]},after=structuredClone(before);after[day][0].deferred=false;assert.equal(validateMutation(before,after,{dayStart:540,dayEnd:1380}).status,'conflict');});
test('automatic alternatives prefer the 11:00 learning start while an explicit 09:00 target stays legal',()=>{const days={[day]:[task('a',660,30)]},settings={dayStart:540,dayEnd:1380,learningPreferredStart:660};const conflict=moveIntent(days,settings,{taskId:'a',targetDate:day,targetStart:1410});assert.equal(conflict.alternatives[0].targetStart,660);assert.equal(moveIntent(days,settings,{taskId:'a',targetDate:'2026-10-13',targetStart:540}).status,'ok');});

test('an unsaved next-date choice needs the calendar catalog read by calculateMove before it can be previewed or saved',async()=>{
 const r=rig({[day]:[task('done',540,80,{done:true,completedDate:day})]}),calls=[];
 r.ctx.calendarStatus={state:'connected'};
 r.ctx.calendarRequest=async action=>{calls.push(action);return{calendars:[{id:'owner',accessRole:'owner'}]};};
 r.ctx.readCalendar=async(date,options)=>{calls.push(options);return options.catalog?{ok:false,complete:false,message:'mock catalogue unavailable'}:{ok:true,complete:true};};
 vm.runInContext(extract('async function calculateMove(', 'function confirmProposal('),r.ctx);
 const before=r.snapshot(),draft=r.draft(80),initial=await r.ctx.saveWorkbenchTask(draft,null,r.store.state.revision);
 assert.equal(initial.result.status,'conflict');assert.ok(initial.result.alternatives.length);
 const candidate=await r.ctx.saveWorkbenchTask(draft,null,r.store.state.revision,initial.result.alternatives[0]);
 assert.equal(candidate.result.status,'conflict');assert.match(candidate.result.conflicts[0].message,/remaining study catalog/);
 assert.equal(calls[0],'calendars');assert.equal(calls.filter(c=>c.catalog).length,1);assert.equal(r.snapshot(),before);
});

// ---- Locks and calendar restriction ownership ----

function restrictionFixture() {
 const event={calendarId:'synthetic@example.test',id:'synthetic-event',summary:'Legacy opaque item',accessRole:'owner',canManage:true,organizer:{self:true},calendarTimeZone:'America/Los_Angeles',start:{dateTime:day+'T11:00:00-07:00'},end:{dateTime:day+'T12:00:00-07:00'},etag:'"v1"'};
 const initial=mergeCalendar({days:{},settings:{timeZone:'America/Los_Angeles'}},{events:[event]}),item=initial.data.days[day][0];
 Object.assign(item,{locked:false,externalReadOnly:false,start:800});item.calendarLink.managed=true;
 item.calendarOccupation={startInstant:wallInstant(day,800,'America/Los_Angeles'),endInstant:wallInstant(day,860,'America/Los_Angeles')};
 const restricted=mergeCalendar(initial.data,{events:[{...event,canManage:false,etag:'"restricted"'}]});
 return{event,restricted,item:restricted.data.days[day][0]};
}

test('the editor rejects locking a read-only calendar entry and leaves its provenance unchanged',async()=>{
 const{restricted,item}=restrictionFixture(),r=rig(restricted.data.days),before=r.snapshot();
 await assert.rejects(r.ctx.saveWorkbenchTask({...r.draft(item.duration,'task'),locked:true},r.ctx.find(item.id),r.store.state.revision),/until management is authorized/);
 assert.equal(r.snapshot(),before);
});

test('locking, or unlocking while moving, an editable calendar entry ends its earlier restriction-based lock ownership',async()=>{
 for(const locked of[true,false]){
  const{restricted,item,event}=restrictionFixture();
  // Model a locally editable record after another confirmed management path.
  item.externalReadOnly=false;item.calendarSource.canManage=true;item.calendarLink.managed=true;
  const r=rig(restricted.data.days),draft={...r.draft(item.duration,'task'),title:item.title,rest:item.rest,locked,when:day+(locked?'T13:20':'T14:00')};
  const p=await r.ctx.saveWorkbenchTask(draft,r.ctx.find(item.id),r.store.state.revision);
  assert.equal(p.result.status,'ok');assert.equal(p.result.days[day][0].calendarRestrictionLock,false);
  assert.equal(r.ctx.find(item.id).task.calendarRestrictionLock,true,'draft must not mutate durable provenance');
  r.ctx.confirmProposal();
  assert.equal(r.ctx.find(item.id).task.calendarRestrictionLock,false);
  const polled=mergeCalendar(r.store.state.personal,{events:[{...event,managed:true,managedUid:item.uid,etag:'"eligible"'}]});
  assert.equal(polled.data.days[day][0].locked,locked);
 }
});

test('moving a task in the editor locks it as a user lock unless the user turns that off, and the lock survives a reload',async()=>{
 for(const lockOnMove of[true,false]){
  const r=rig({[day]:[task('a',660,30,{learning:false,tags:[],counted:false}),task('b',800,30,{learning:false,tags:[],counted:false})]});
  const draft={...r.draft(30,'task'),title:'a',rest:20,when:day+'T12:00',lockOnMove};
  const p=await r.ctx.saveWorkbenchTask(draft,r.ctx.find('a'),r.store.state.revision);
  assert.equal(p.result.status,'ok');
  assert.equal(r.ctx.find('a').task.locked,false,'nothing is locked before Yes');
  r.ctx.confirmProposal();
  const a=r.ctx.find('a').task;
  assert.equal(a.start,720);assert.equal(a.type,'task');assert.equal(a.locked,lockOnMove);
  assert.equal(a.lockSource??null,lockOnMove?'user':null);
  const reload=new WorkspaceStore(r.memory);reload.load();
  assert.equal(reload.state.personal.days[day].find(t=>t.id==='a').locked,lockOnMove,'the lock survives reload');
 }
});

test('adopting a learning plan clears the earlier restriction lock before a later user lock is applied',async()=>{
 const{restricted,item}=restrictionFixture();item.calendarSource.canManage=true;item.tags=['study'];item.planId='synthetic-plan';
 const r=rig(restricted.data.days),calls=[];
 Object.assign(r.ctx,{date:day,canManageCalendarSource,localCalendarSignature,interpretCalendar,classifyCalendar,calendarRequest:async(action,payload)=>{calls.push({action,payload});return{results:payload.tasks.map(t=>({uid:t.uid,ok:true,calendarLink:{...t.calendarLink,managed:true,etag:'"adopted"'}}))};}});
 vm.runInContext(extract('async function adoptLearning(','async function saveWorkbenchTask('),r.ctx);
 await r.ctx.adoptLearning('synthetic-plan');
 assert.equal(calls.length,1);assert.equal(calls[0].action,'adopt');assert.equal(calls[0].payload.tasks.length,1);
 const adopted=r.ctx.find(item.id).task;
 assert.equal(adopted.calendarRestrictionLock,undefined);assert.equal(adopted.locked,false);assert.equal(adopted.externalReadOnly,false);
 const p=await r.ctx.saveWorkbenchTask({...r.draft(item.duration,'task'),title:item.title,rest:item.rest,locked:true},r.ctx.find(item.id),r.store.state.revision);
 assert.equal(p.result.status,'ok');r.ctx.confirmProposal();
 assert.equal(r.ctx.find(item.id).task.locked,true);assert.equal(r.ctx.find(item.id).task.calendarRestrictionLock,undefined);
});

for(const guard of['done','deferred'])test(`reversing a ${guard} task after its calendar source recovers does not leave a bare lock`,()=>{
 const{restricted,item,event}=restrictionFixture();item[guard]=true;if(guard==='deferred')item.archived=true;
 const recovered=mergeCalendar(restricted.data,{events:[{...event,managed:true,managedUid:item.uid,etag:'"eligible"'}]});
 assert.equal(recovered.data.days[day][0][guard],true);
 assert.equal(syncResumeProposal(recovered.data).items.length,0);
 const r=rig(recovered.data.days);
 if(guard==='done')assert.equal(r.ctx.actions.complete(r.ctx.find(item.id)),true,JSON.stringify(r.notices));
 else{
  assert.ok(r.ctx.actions.restore(r.ctx.find(item.id),{date:day,minute:0}));
 }
 assert.equal(r.ctx.find(item.id).task[guard],false);
 assert.equal(r.ctx.find(item.id).task.locked,false);
 assert.deepEqual(syncResumeProposal(r.store.state.personal).items.map(e=>e.uid),[item.uid]);
});

for(const unlock of[false,true])
test(`an explicit ${unlock?'unlock':'lock'} in the editor survives restriction changes and learning classification`,async()=>{
 for(const classificationLocked of[false,true]){
 const{restricted,item,event}=restrictionFixture(),verified={...event,managed:true,managedUid:item.uid,etag:'"eligible"'};
 const eligible=mergeCalendar(restricted.data,{events:[verified]});
 const initial=classificationLocked?classifyCalendar(eligible.data,{selections:{[calendarKey(item)]:{kind:'task',locked:true}}}):eligible;
 const r=rig(initial.data.days);
 async function saveLock(locked){
  await r.ctx.saveWorkbenchTask({...r.draft(item.duration,'task'),title:item.title,rest:item.rest,locked,when:day+(locked?'T13:20':'T14:00')},r.ctx.find(item.id),r.store.state.revision);
  assert.equal(r.ctx.proposal.result.status,'ok');r.ctx.confirmProposal();
  assert.equal(r.ctx.find(item.id).task.locked,locked);
 }
 await saveLock(true);
 assert.equal(r.ctx.find(item.id).task.lockSource,'user');
 if(unlock){await saveLock(false);assert.equal(r.ctx.find(item.id).task.lockSource,null);}
 if(unlock&&classificationLocked){
  assert.equal(r.ctx.find(item.id).task.calendarClassification.locked,undefined);
  const replayed=classifyCalendar(r.store.state.personal,{});
  assert.equal(replayed.data.days[day][0].locked,false,'one-time classification replay must not undo an explicit editor unlock');
  const policy=structuredClone(r.store.state.personal);
  policy.calendar.classificationRules=[{calendarId:event.calendarId,match:'calendar',kind:'task',locked:true}];
  const originalRules=structuredClone(policy.calendar.classificationRules),governed=classifyCalendar(policy,{});
  assert.equal(governed.data.days[day][0].locked,true,'an unchanged persistent rule still has existing precedence');
  assert.deepEqual(governed.data.calendar.classificationRules,originalRules);
 }
 const blocked=mergeCalendar(r.store.state.personal,{events:[{...event,canManage:false,etag:'"restricted-again"'}]});
 const classified=classifyCalendar(blocked.data,{selections:{[calendarKey(item)]:{kind:'learning'}}});
 let recovered=classified;
 for(let read=0;read<2;read++)recovered=mergeCalendar(recovered.data,{events:[verified]});
 const saved=recovered.data.days[day][0];
 assert.equal(saved.locked,!unlock);assert.equal(saved.lockSource,unlock?null:'user');
 assert.equal(syncResumeProposal(recovered.data).items.length,unlock?1:0);
 }
});

test('choosing the fixed kind without ticking the lock box does not record a user lock',async()=>{
 const r=rig({[day]:[]});
 assert.equal((await r.ctx.saveWorkbenchTask({...r.draft(30,'fixed'),locked:false},null,r.store.state.revision)).ok,true);
 const saved=r.store.state.personal.days[day][0];
 assert.equal(saved.type,'activity');assert.equal(saved.locked,true);assert.equal(saved.lockSource,undefined);
});
