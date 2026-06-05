import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Sun, Moon, Plus, X, Check, ChevronLeft, ChevronRight, Settings, Download,
         Zap, Lock, Star, Printer, BarChart2, Calendar, Users, AlertTriangle, Clock, Search } from "lucide-react";

// ─── Constants ────────────────────────────────────────────────────────────────
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const TAG_COLORS = {
  'Deep Work':'#1A7AA8','Admin/Email':'#4A8A6A','Portfolio':'#7850A4',
  'Gym':'#B85820','School/Class':'#245EA8','Social':'#B87818',
  'Reset':'#368070','Errands':'#846040','Chores':'#4C6888',
  'Study':'#2468A8','Food':'#A84020','Rest':'#4C6E8A',
  'Health':'#2E9E6A',
};
const TAGS = Object.keys(TAG_COLORS);
const PCOLS = ['','#607890','#3888C0','#B89010','#C05010','#B01818'];
const DW_TAGS    = ['Deep Work','Study','Portfolio','School/Class'];
const LIGHT_TAGS = ['Admin/Email','Social','Errands','Chores','Food','Health'];

// Time constants (minutes)
const DW_S  = 17*60;      // Deep Work starts 5:00 PM
const DW_E  = 19*60+30;   // Deep Work ends 7:30 PM
const EVE   = 19*60+30;   // Evening threshold 7:30 PM
const GYM_E = 22*60;      // Global 10 PM cutoff — nothing auto-scheduled after this
const LATE  = 23*60;      // 11 PM strict gate

// ─── Preferences (decoupled from hardcoded constants) ─────────────────────────
const DEFAULT_PREFS = {
  gymDays:      ['Tue','Thu','Sun'],
  gymCutoff:    '22:00',   // per-gym-day cutoff (settable earlier than global 10 PM)
  eveningLimit: 2,          // max flexible tasks after EVE per day (overridden by burnout mode)
};

const CORE0 = [
  {id:'sleep',   name:'Sleep',    days:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], startTime:'00:00', endTime:'07:30', tag:'Rest'},
  {id:'gym',     name:'Gym',      days:['Tue','Thu','Sun'], startTime:'19:00', endTime:'20:30', tag:'Gym'},
  {id:'laundry', name:'Laundry',  days:['Wed'], startTime:'19:00', endTime:'21:00', tag:'Chores'},
  {id:'shabbat', name:'Shabbat',  days:['Fri'], startTime:'18:30', endTime:'21:00', tag:'Social', optOut:false},
  {id: 'grocery', name:'Groceries', days:['Sat'],startTime:'10:00', endTime:'12:00', tag:'Chores'},
  {id:'work',name:"Work", days:['Mon',"Tue",'Wed','Thu','Fri'],startTime:'08:30', endTime:'17:00',tag:'Study'},
  {id:'from_work',name:"Travel Home", days:['Mon',"Tue",'Wed','Thu','Fri'],startTime:'17:00', endTime:'17:40',tag:'Errands'},
  {id:'to_work',name:"Travel To Work", days:['Mon',"Tue",'Wed','Thu','Fri'],startTime:'08:00', endTime:'08:30',tag:'Errands'},
];

const DEMO = [
];

// ─── Utilities ────────────────────────────────────────────────────────────────
const toM  = s => { if(!s) return 0; const [h,m]=s.split(':').map(Number); return h*60+m; };
const toS  = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const fT   = s => { if(!s) return ''; let [h,m]=s.split(':').map(Number); const past=h>=24; if(past) h-=24; const p=h>=12?'pm':'am'; const h2=h%12||12; const base=m===0?`${h2}${p}`:`${h2}:${String(m).padStart(2,'0')}${p}`; return past?`${base}+`:base; };
const dK   = d => d.toISOString().split('T')[0];
const isTod= d => new Date().toDateString()===d.toDateString();
const dN   = d => DAYS[d.getDay()];
const hRgb = h => { if(!h||h.length<7) return '100,120,140'; return `${parseInt(h.slice(1,3),16)},${parseInt(h.slice(3,5),16)},${parseInt(h.slice(5,7),16)}`; };
const tC   = t => TAG_COLORS[t]||'#607080';
const getWk= (off=0) => {
  const s=new Date(); s.setDate(s.getDate()-s.getDay()+off*7); s.setHours(0,0,0,0);
  return Array.from({length:7},(_,i)=>{ const d=new Date(s); d.setDate(s.getDate()+i); return d; });
};

// ─── Conflict Detection ───────────────────────────────────────────────────────
function computeConflicts(evs) {
  const conflicts = new Set();
  const sorted = [...evs].filter(e=>e.scheduledStart||e.startTime)
    .sort((a,b)=>toM(a.scheduledStart||a.startTime)-toM(b.scheduledStart||b.startTime));
  for(let i=0;i<sorted.length;i++){
    const a=sorted[i];
    const isAFixed=a.isFixed||a.type==='fixed';
    const as=toM(a.scheduledStart||a.startTime), ae=toM(a.scheduledEnd||a.endTime||a.startTime)+((a.duration&&!a.scheduledEnd&&!a.endTime)?a.duration:0);
    for(let j=i+1;j<sorted.length;j++){
      const b=sorted[j];
      const isBFixed=b.isFixed||b.type==='fixed';
      const bs=toM(b.scheduledStart||b.startTime);
      if(bs>=ae) break;
      // Intentional overlap between two user-defined core blocks — never flag as a conflict
      if(isAFixed&&isBFixed) continue;
      conflicts.add(a.id); conflicts.add(b.id);
    }
  }
  return conflicts;
}

// ─── ML Duration Utilities ────────────────────────────────────────────────────
function computeMlMultipliers(mlLog) {
  const byTag={};
  const now=Date.now();
  mlLog.forEach(({tag,estimated,actual,satisfaction,date})=>{
    if(!tag||!estimated||!actual) return;
    if(!byTag[tag]) byTag[tag]={num:0,den:0,count:0};
    // Recency decay: half-life of 21 days — recent entries dominate
    const ageDays=date?(now-new Date(date).getTime())/86400000:30;
    const decay=Math.pow(0.5, ageDays/21);
    // Satisfaction weight: low-sat entries are noisy (bad day ≠ bad estimate)
    // sat null → neutral 1.0; 1→0.4, 2→0.7, 3→1.0, 4→1.2, 5→1.4
    const satW=satisfaction!=null?Math.max(0.4,0.4+(satisfaction-1)*0.25):1.0;
    const w=decay*satW;
    byTag[tag].num  += actual*w;
    byTag[tag].den  += estimated*w;
    byTag[tag].count+= 1;
  });
  const mults={};
  Object.entries(byTag).forEach(([tag,{num,den,count}])=>{
    if(count>=3&&den>0) mults[tag]=Math.min(2.0,Math.max(0.5,num/den));
  });
  return mults;
}
function computeMlInsights(mlLog) {
  const mults=computeMlMultipliers(mlLog);
  const now=Date.now();
  // Count recent entries per tag (last 14 days) for confidence display
  const recent14={};
  mlLog.forEach(({tag,date})=>{
    if(!tag) return;
    const age=date?(now-new Date(date).getTime())/86400000:99;
    if(age<=14) recent14[tag]=(recent14[tag]||0)+1;
  });
  return Object.entries(mults).map(([tag,mult])=>{
    const pct=Math.round((mult-1)*100);
    const conf=recent14[tag]>=5?'high confidence':recent14[tag]>=3?'learning':'early data';
    if(Math.abs(pct)<10) return `${tag}: estimates are accurate (${conf}).`;
    return pct>0
      ?`${tag}: tasks take ~${pct}% longer than estimated — durations auto-adjusted. (${conf})`
      :`${tag}: tasks finish ~${Math.abs(pct)}% faster than estimated — durations auto-adjusted. (${conf})`;
  });
}

// ─── Academic + Recent-task Suggestion Utilities ──────────────────────────────
const ACADEMIC_TAGS = new Set(['Study','School/Class','Deep Work','Portfolio']);

function getRecentTaskSuggestions(sched) {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const todayDk = dK(new Date());

  // Collect completed tasks from the past 7 days (not completed today — they're current)
  const recent = sched.filter(t =>
    t.isCompleted &&
    t.completedDate &&
    t.completedDate !== todayDk &&
    new Date(t.completedDate).getTime() >= sevenDaysAgo
  );

  // Deduplicate by name+tag combo, track frequency and most recent date
  const map = {};
  recent.forEach(t => {
    const tag = t.tags?.[0] || '';
    const key = (t.name + '|' + tag).toLowerCase();
    if (!map[key]) map[key] = {name:t.name, tag, duration:t.duration||60, count:0, lastDate:t.completedDate, tags:t.tags||[]};
    map[key].count += 1;
    if (t.completedDate > map[key].lastDate) map[key].lastDate = t.completedDate;
  });

  // Sort by recency then frequency, take top 4
  return Object.values(map)
    .sort((a,b) => b.lastDate.localeCompare(a.lastDate) || b.count - a.count)
    .slice(0, 4);
}

// ─── simulateGaps — non-mutating "Find Best Time" utility ─────────────────────
// Returns the top 3 largest open blocks for a given duration without touching
// the live tasks array. Safe to call from anywhere in the UI.
function simulateGaps(durationMins, scheduledTasks, core, wkDates, gymDays=DEFAULT_PREFS.gymDays, gymCutoff=DEFAULT_PREFS.gymCutoff) {
  const S=9*60, E=27*60;
  const gymCutoffMins = toM(gymCutoff);
  const results = [];
  const now = new Date(); now.setHours(0,0,0,0);
  const todayDk = dK(now);
  const nowM = new Date().getHours()*60 + new Date().getMinutes();

  wkDates.forEach(date => {
    const dn=dN(date), dk2=dK(date);
    if(date < now && dk2 !== todayDk) return; // skip true past days

    // For today: start looking 15 min from now at earliest
    const dayStart = dk2 === todayDk ? Math.max(S, nowM + 15) : S;

    const fixed = core.filter(b=>b.days.includes(dn)&&!b.optOut)
      .map(b=>({sM:toM(b.startTime),eM:toM(b.endTime)}));
    const sched2 = scheduledTasks.filter(t=>t.scheduledDate===dk2&&t.scheduledStart)
      .map(t=>({sM:toM(t.scheduledStart),eM:toM(t.scheduledStart)+(t.duration||30)}));

    const occ = [...fixed,...sched2].sort((a,b)=>a.sM-b.sM);
    let cur=S; const rawGaps=[];
    occ.forEach(o=>{ if(o.sM>cur) rawGaps.push({s:cur,e:o.sM}); cur=Math.max(cur,o.eM); });
    if(cur<E) rawGaps.push({s:cur,e:E});

    const isGymDay = gymDays.includes(dn);

    rawGaps.forEach(g => {
      const st = Math.max(g.s, dayStart);
      const availEnd = g.e;
      if(availEnd - st < durationMins) return;
      if(st >= LATE) return;                                    // never suggest after 11 PM
      if(isGymDay && st >= gymCutoffMins) return;
      if(st >= GYM_E) return;                                   // global 10 PM cutoff

      // Time-of-day label for the reason
      let tod = st < 12*60 ? 'morning' : st < 17*60 ? 'afternoon' : 'evening';
      const avail = availEnd - st;
      const score = Math.min(1.0, Math.round(((avail / (durationMins * 2)) * 100)) / 100);

      results.push({
        dk: dk2, dn, date,
        startM: st, endM: st + durationMins,
        gapSize: avail,
        startTime: toS(st), endTime: toS(st + durationMins),
        day: DAYS[date.getDay()], dateStr: dk2,
        score,
        reason: `${avail >= 120 ? 'Large ' : ''}${tod} block · ${Math.round(avail/60*10)/10}h available`,
      });
    });
  });

  // Return top 3 by available gap size
  return results.sort((a,b) => b.gapSize - a.gapSize).slice(0, 3);
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
// Signature change: `prefs` object replaces individual gymDays/gymCutoffMins params.
// burnoutEveLimit is kept separate as it's computed dynamically from sat history.
function runSched(tasks, core, wkDates, prefs=DEFAULT_PREFS, burnoutEveLimit=2, mlMultipliers={}) {
  const gymDays      = prefs.gymDays      ?? DEFAULT_PREFS.gymDays;
  const gymCutoffMins= toM(prefs.gymCutoff ?? DEFAULT_PREFS.gymCutoff);
  const prefEveLimit = prefs.eveningLimit  ?? DEFAULT_PREFS.eveningLimit;
  // Effective limit is the stricter of burnout protection and user preference
  const effectiveEveLimit = Math.min(burnoutEveLimit, prefEveLimit);

  const S=9*60, E=27*60; // auto-scheduling window: 9 AM – 3 AM next day

  // ── Date anchors for Tomorrow-by-Default ─────────────────────────────────
  const todayDate = new Date(); todayDate.setHours(0,0,0,0);
  const todayDk   = dK(todayDate);
  const tomorrowDate = new Date(todayDate); tomorrowDate.setDate(todayDate.getDate()+1);
  const tomorrowDk = dK(tomorrowDate);
  const nowM = new Date().getHours()*60 + new Date().getMinutes(); // current minute-of-day

  // Preferred-time zone barriers (strict minute ranges)
  const PREF_ZONES = {
    morning:   {start:9*60,  end:12*60},   // 09:00–12:00
    afternoon: {start:12*60, end:17*60},   // 12:00–17:00
    evening:   {start:17*60, end:23*60},   // 17:00–23:00
  };

  const days = wkDates.map(date => ({
    date, dn:dN(date), dk:dK(date),
    fixed: core.filter(b=>b.days.includes(dN(date))&&!b.optOut).map(b=>({sM:toM(b.startTime),eM:toM(b.endTime)})),
    asgn:[],
    dwEnds:[], // Feature 4: post-DW 30-min light reservation tracking
  }));

  // Pre-place pinned tasks first (they hold their slots regardless of algorithm)
  tasks.filter(t=>t.isPinned&&t.scheduledDate&&!t.isCompleted).forEach(t=>{
    const d=days.find(d=>d.dk===t.scheduledDate); if(d) d.asgn.push(t);
  });

  // Priority queue: P5 first, then by deadline proximity, then by creation time
  const q=tasks.filter(t=>t.type==='flexible'&&!t.isCompleted&&!t.isPinned)
    .sort((a,b)=>b.priority-a.priority||(a.deadline&&b.deadline?new Date(a.deadline)-new Date(b.deadline):a.deadline?-1:b.deadline?1:(a.createdAt||0)-(b.createdAt||0)));

  const now=new Date(); now.setHours(0,0,0,0);

  q.forEach(task => {
    // Week-gate: recurring flexible instances carry a notBefore date string so they
    // only get placed when their target week is the current view, not all at once.
    // Both sides must be YYYY-MM-DD strings for lexicographic comparison to work.
    if(task.notBefore && task.notBefore > dK(wkDates[wkDates.length-1])) {
      task.scheduledDate=null; task.scheduledStart=null; task.scheduledEnd=null;
      return;
    }
    // Feature 14: apply ML-adjusted duration
    const mlTag      = task.tags?.[0]||'';
    const effectiveDur = Math.round(task.duration*(mlMultipliers[mlTag]||1));
    const isDW       = task.tags?.some(t=>DW_TAGS.includes(t));
    const zone       = PREF_ZONES[task.preferredTime]; // undefined = 'any'

    // Build candidate day list sorted by ascending scheduled load (spread evenly).
    // P4/P5: Saturday stays first (high-capacity anchor), then remaining days by load.
    // P1–P3: all days sorted purely by load.
    const loadOf=d=>{
      const fixedMins=d.fixed.reduce((s,f)=>s+Math.max(0,f.eM-f.sM),0);
      return fixedMins+d.asgn.reduce((s,t)=>s+(t.duration||0),0);
    };
    const sortByLoad=arr=>[...arr].sort((a,b)=>loadOf(a)-loadOf(b));
    let cands;
    if(task.priority>=4){
      const sat=days.find(d=>d.dn==='Sat');
      const rest=sortByLoad(days.filter(d=>d.dn!=='Sat'));
      cands=sat?[sat,...rest]:sortByLoad(days);
    } else {
      cands=sortByLoad(days);
    }

    // ── Tomorrow-by-Default ─────────────────────────────────────────────────
    // Today (index 0 of week) is locked unless one of these override conditions:
    //  1. task.target === 'today'  (explicit user force via UI)
    //  2. task.deadline === todayDk  (due today)
    //  3. P4/P5 with deadline === tomorrowDk  (urgent, due tomorrow)
    // Fallback (Pass C/D below): all other days exhausted → try today starting 3h from now
    const todayForcedDirect =
      task.target === 'today' ||
      task.deadline === todayDk ||
      (task.priority >= 4 && task.deadline === tomorrowDk);

    const todayDay       = days.find(d=>d.dk===todayDk);
    // Primary candidates: everyone except today (unless directly eligible)
    const primaryCands   = cands.filter(d=>d.dk!==todayDk||todayForcedDirect);

    // ── Deadline Fence ───────────────────────────────────────────────────────
    // Never schedule a task after its deadline day. This is the critical guard
    // that stops "due Friday" tasks from landing on Saturday when earlier days
    // fill up (P5 puts Sat first, which could be past a 2-day deadline).
    // Falls back to primaryCands if the deadline is already passed (overdue warning handles it).
    const effectivePrimary = task.deadline
      ? primaryCands.filter(d=>d.dk<=task.deadline)
      : primaryCands;
    const safePrimary = effectivePrimary.length>0 ? effectivePrimary : primaryCands;

    // ── Gap evaluator ────────────────────────────────────────────────────────
    // Tries to fit the task in each candidate day's free windows.
    // useStrictPref: if true, aligns slot to task.preferredTime zone.
    // todayMinStart: minimum minute to start on today (used for fallback pass).
    const tryPlace = (candidates, useStrictPref, todayMinStart=S) => {
      for(const day of candidates){
        if(day.date<now&&!isTod(day.date)) continue; // skip true past days

        const isToday  = day.dk===todayDk;
        const dayMin   = isToday ? Math.max(S, todayMinStart) : S;

        // Build occupied blocks and compute raw gaps from S
        const occ = [
          ...day.fixed,
          ...day.asgn.filter(t=>t.scheduledStart).map(t=>({
            sM:toM(t.scheduledStart),
            // Use scheduledEnd when present (honours ML-adjusted duration); fall back to
            // base duration so asgn items placed earlier in this same runSched pass are
            // accounted for with the correct end time — prevents two bumped tasks
            // being placed in the same slot when rescheduled simultaneously.
            eM:t.scheduledEnd ? toM(t.scheduledEnd) : toM(t.scheduledStart)+(t.duration||30),
          })),
        ].sort((a,b)=>a.sM-b.sM);

        let cur=S; const rawGaps=[];
        occ.forEach(o=>{ if(o.sM>cur) rawGaps.push({s:cur,e:o.sM}); cur=Math.max(cur,o.eM); });
        if(cur<E) rawGaps.push({s:cur,e:E});

        // Clip all gap starts to dayMin (handles "today 3h from now" fallback cleanly)
        const gaps = rawGaps.map(g=>({s:Math.max(g.s,dayMin),e:g.e})).filter(g=>g.e>g.s);

        const eveN   = day.asgn.filter(t=>t.scheduledStart&&toM(t.scheduledStart)>=EVE).length;
        const isGym  = gymDays.includes(day.dn);

        for(const g of gaps){
          // ── Time-of-Day Preference Guard ──────────────────────────────────
          // Align gap start to preferred zone. If the gap begins before the zone,
          // advance st to zone.start (allows a 9am–9pm gap to serve afternoon tasks).
          // If the adjusted start is past zone end, skip. Per spec: any gap whose
          // effective start falls outside the zone is continued.
          let st = g.s;
          if(useStrictPref && zone) {
            st = Math.max(st, zone.start);
            if(st >= zone.end) continue; // gap starts entirely past preferred zone
          }
          const en = st + effectiveDur;
          if(en > g.e) continue; // task doesn't fit in remaining gap space

          // ── Hard Constraint Gates ─────────────────────────────────────────
          // Gym Cutoff: per-day cutoff on gym days (user-configurable)
          if(isGym && st >= gymCutoffMins) continue;
          // Global 10 PM gate: no flexible task starts at or after 10 PM
          if(st >= GYM_E) continue;
          // 11 PM Strict Gate: only P5 tasks with deadline = today may exceed this
          if(st >= LATE){
            if(!(task.priority===5 && task.deadline===day.dk)) continue;
          } else if(st >= EVE && eveN >= effectiveEveLimit) continue; // evening task limit
          // Deep Work Protection: non-DW tasks can't start inside the DW window
          if(st < DW_E && en > DW_S && !task.tags?.some(t=>DW_TAGS.includes(t))) continue;
          // Feature 4: post-DW 30-min reset buffer — DW tasks skip it too
          if(isDW && day.dwEnds.some(dwE=>st>=dwE&&st<dwE+30)) continue;

          // ── Schedule ──────────────────────────────────────────────────────
          task.scheduledDate  = day.dk;
          task.scheduledStart = toS(st);
          task.scheduledEnd   = toS(en);
          day.asgn.push(task);
          if(isDW) day.dwEnds.push(en);
          return true;
        }
      }
      return false;
    };

    let found = false;
    const safeTodayMin = Math.max(S, nowM + 15);

    // Pass A: preferred time zone + deadline-fenced primary candidates
    if(!found) found = tryPlace(safePrimary, !!zone, safeTodayMin);
    // Pass B: relax preferred zone, still deadline-fenced
    if(!found && zone) found = tryPlace(safePrimary, false, safeTodayMin);
    // Pass C: today as last-resort fallback (all other days full) — 3h from now, preferred zone
    if(!found && !todayForcedDirect && todayDay) found = tryPlace([todayDay], !!zone, nowM+180);
    // Pass D: today fallback, any time
    if(!found && !todayForcedDirect && todayDay) found = tryPlace([todayDay], false, nowM+180);

    if(!found){ task.scheduledDate=null; task.scheduledStart=null; task.scheduledEnd=null; }
  });

  // ── Feature 10: Pass 2 — force-schedule unplaced deadline P2s by displacing P4s ──
  tasks.filter(t=>!t.isAutoInserted&&t.priority===2&&t.deadline&&!t.scheduledDate&&!t.isCompleted).forEach(task=>{
    const targetDay=days.find(d=>d.dk===task.deadline);
    if(!targetDay) return;
    const displace=targetDay.asgn.find(t=>!t.isAutoInserted&&!t.deadline&&t.priority<=4&&t.scheduledStart&&!t.isPinned&&!t.isFixed);
    if(displace){
      task.scheduledDate=targetDay.dk; task.scheduledStart=displace.scheduledStart; task.scheduledEnd=toS(toM(displace.scheduledStart)+(task.duration||30));
      const dt=tasks.find(t=>t.id===displace.id);
      if(dt){ dt.scheduledDate=null; dt.scheduledStart=null; dt.scheduledEnd=null; }
      targetDay.asgn=targetDay.asgn.filter(t=>t.id!==displace.id);
      targetDay.asgn.push(task);
    }
  });

  // ── Feature 5: Pass 3 — insert 30-min Reset buffer after ≥3h contiguous DW blocks ──
  const pendingBuffers = [];
  days.forEach(day=>{
    const dwT=day.asgn.filter(t=>t.tags?.some(tag=>DW_TAGS.includes(tag))&&t.scheduledStart)
      .sort((a,b)=>toM(a.scheduledStart)-toM(b.scheduledStart));
    let runStart=null,runEnd=null;
    const tryInsert=()=>{
      if(runStart!==null&&runEnd-runStart>=180){
        const rid='auto_rst_'+day.dk+'_'+runEnd;
        if(!tasks.find(t=>t.id===rid)&&!pendingBuffers.find(t=>t.id===rid)){
          const bufS=runEnd, bufE=runEnd+30;
          const blocked=[
            ...day.fixed,
            ...day.asgn.filter(t=>t.scheduledStart).map(t=>({sM:toM(t.scheduledStart),eM:toM(t.scheduledStart)+(t.duration||30)})),
          ].some(o=>bufS<o.eM&&bufE>o.sM);
          if(!blocked){
            pendingBuffers.push({id:rid,name:'Reset Buffer',type:'flexible',duration:30,priority:0,tags:['Reset'],
              notes:'Auto-inserted: 3h+ deep work block',isCompleted:false,isAutoInserted:true,isPinned:false,isFixed:false,
              scheduledDate:day.dk,scheduledStart:toS(runEnd),scheduledEnd:toS(runEnd+30),createdAt:0});
          }
        }
      }
    };
    dwT.forEach(t=>{
      const ts=toM(t.scheduledStart),te=ts+t.duration;
      if(runStart===null){runStart=ts;runEnd=te;}
      else if(ts<=runEnd+15){runEnd=Math.max(runEnd,te);}
      else{tryInsert();runStart=ts;runEnd=te;}
    });
    tryInsert();
  });

  // ── Overdue flag: stamp tasks whose deadline has already passed ──────────
  tasks.forEach(task => {
    task.isOverdue = !!(task.deadline && task.deadline < todayDk && !task.isCompleted);
  });

  return [...tasks, ...pendingBuffers];
}

// ─── ICS Generator ────────────────────────────────────────────────────────────
function genICS(events) {
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//TideFlow//EN','CALSCALE:GREGORIAN'];
  events.forEach(ev=>{
    const d=(ev.scheduledDate||'').replace(/-/g,'');
    const st=(ev.scheduledStart||'00:00').replace(':','');
    const en=(ev.scheduledEnd||'01:00').replace(':','');
    lines.push('BEGIN:VEVENT',`DTSTART:${d}T${st}00`,`DTEND:${d}T${en}00`,`SUMMARY:${ev.name}`,`UID:${ev.id}@tideflow`);
    if(ev.notes) lines.push(`DESCRIPTION:${ev.notes.replace(/\n/g,'\\n')}`);
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ─── ML / Satisfaction Insights ───────────────────────────────────────────────
function computeInsights(history) {
  if(history.length<3) return ['Rate 3+ days to unlock insights.'];
  const ins=[], byDow={};
  history.forEach(h=>{ const d=new Date(h.date).getDay(); if(!byDow[d]) byDow[d]=[]; byDow[d].push(h); });
  Object.entries(byDow).forEach(([dow,rts])=>{
    if(rts.length<2) return;
    const avgL=rts.reduce((a,b)=>a+b.load,0)/rts.length;
    const avgE=rts.reduce((a,b)=>a+b.exec,0)/rts.length;
    if(avgL<=2) ins.push(`${DAYS[dow]}s feel overwhelming (avg ${avgL.toFixed(1)}/5) — schedule less.`);
    else if(avgL>=4.5) ins.push(`${DAYS[dow]}s feel underloaded — you can take on more.`);
    if(avgE<=2) ins.push(`${DAYS[dow]} schedule often drifts — add more buffer.`);
  });
  const ol=history.reduce((a,b)=>a+b.load,0)/history.length;
  if(ol<=2.5) ins.push('Overall load feels high — increase your buffer %.');
  else if(ol>=4.2) ins.push('Overall load feels light — scheduler can be more aggressive.');
  return ins.length?ins:['Schedule is working well. Keep rating daily.'];
}

// ─── Grid constants ───────────────────────────────────────────────────────────
// GS = 0: grid renders from midnight so Sleep (00:00–09:00) and other early blocks
// position correctly without the clamping bug that stretched them across the day.
// GE = 27: keeps visibility up to 3 AM next day (same as before).
const GS=0, GE=27, HH=64;
const hrs=Array.from({length:GE-GS},(_,i)=>{ const h=GS+i; return h>=24?h-24:h; });
const hrsRaw=Array.from({length:GE-GS},(_,i)=>GS+i); // 27 hours = rows
const yMn=m=>((Math.max(m,GS*60)-GS*60)/60)*HH;       // minutes → px from top
const yH =m=>(m/60)*HH;                                 // duration minutes → px height
// Cross-midnight duration helper: if a block's endTime < startTime, add 24h to end.
const crossMidDur=(startMin,endMin)=>endMin>startMin?endMin-startMin:endMin+1440-startMin;

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--fd:'Playfair Display',serif;--fb:'DM Sans',sans-serif;--r:12px;--rs:8px;--sh:0 4px 20px rgba(0,0,0,.1);--shl:0 8px 40px rgba(0,0,0,.18);--t:.18s}
.lt{--bg:#EAD9BC;--sf:#FFFAEA;--s2:#F5E8CC;--bd:#DDD0A4;--tx:#261A06;--t2:#7A6030;--t3:#B09060;--pr:#186EA0;--prl:rgba(24,110,160,.12);--ac:#C05A20;--ok:#388050;--er:#B02820;--hb:#14385A;--ht:#EEE0C0;--dw:rgba(24,110,160,.06)}
.dk{--bg:#07101F;--sf:#0D1C32;--s2:#13263E;--bd:#183050;--tx:#E6D4A8;--t2:#7890B0;--t3:#38506A;--pr:#34B8B0;--prl:rgba(52,184,176,.12);--ac:#E89820;--ok:#34B8B0;--er:#D86060;--hb:#040C18;--ht:#E4D0A0;--dw:rgba(52,184,176,.05)}
body{overflow:hidden}
.app{height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--tx);font-family:var(--fb);font-size:14px;overflow:hidden;transition:background .3s,color .3s}
.hdr{background:var(--hb);position:relative;z-index:50;flex-shrink:0}
.hi{display:flex;align-items:center;gap:10px;padding:13px 20px}
.logo{font-family:var(--fd);font-size:19px;font-weight:700;color:var(--ht);flex:1;white-space:nowrap}
.logo small{font-family:var(--fb);font-size:11px;font-weight:400;opacity:.42;margin-left:8px;letter-spacing:.5px}
.hw{position:absolute;bottom:-1px;left:0;right:0;height:14px}
.ntabs{display:flex;gap:2px;background:rgba(255,255,255,.07);padding:3px;border-radius:9px}
.ntab{padding:5px 11px;border-radius:7px;border:none;background:transparent;color:rgba(255,255,255,.5);font-family:var(--fb);font-size:12px;font-weight:500;cursor:pointer;transition:all var(--t)}
.ntab.on{background:rgba(255,255,255,.14);color:#fff}
.ntab:hover:not(.on){color:rgba(255,255,255,.78)}
.hbtn{width:33px;height:33px;border-radius:7px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.06);color:var(--ht);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all var(--t);flex-shrink:0}
.hbtn:hover{background:rgba(255,255,255,.14)}
.abtn{display:flex;align-items:center;gap:5px;padding:0 14px;height:33px;border-radius:7px;border:none;background:var(--ac);color:#fff;font-family:var(--fb);font-size:12px;font-weight:600;cursor:pointer;transition:all var(--t);white-space:nowrap;flex-shrink:0}
.abtn:hover{opacity:.88;transform:translateY(-1px)}
.wn{display:flex;align-items:center;gap:10px;padding:9px 20px;border-bottom:1px solid var(--bd);flex-shrink:0;background:var(--sf)}
.wnt{font-family:var(--fd);font-size:16px;font-weight:500;flex:1}
.narr{width:29px;height:29px;border-radius:7px;border:1px solid var(--bd);background:transparent;color:var(--t2);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all var(--t)}
.narr:hover{background:var(--prl);color:var(--pr);border-color:var(--pr)}
.tbtn{padding:3px 10px;border-radius:6px;border:1px solid var(--bd);background:transparent;color:var(--t2);font-size:12px;cursor:pointer;font-family:var(--fb);transition:all var(--t)}
.tbtn:hover{background:var(--prl);color:var(--pr)}
.main{flex:1;overflow:hidden;display:flex;flex-direction:column}
.tv{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:18px}
.tvtop{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.tvdate{font-family:var(--fd);font-size:28px;font-weight:700;line-height:1.1}
.pcard{background:var(--sf);border-radius:var(--r);padding:13px 17px;border:1px solid var(--bd);min-width:170px}
.plbl{font-size:11px;color:var(--t2);margin-bottom:4px}
.pbar{height:4px;background:var(--bd);border-radius:99px;overflow:hidden;margin-bottom:5px}
.pfill{height:100%;border-radius:99px;transition:width .6s ease;background:linear-gradient(90deg,var(--pr),var(--ok))}
.ppct{font-family:var(--fd);font-size:17px;font-weight:700;color:var(--pr)}
.er{display:flex;align-items:stretch;gap:9px;padding:4px;cursor:pointer;border-radius:8px;transition:background var(--t)}
.er:hover{background:var(--prl)}
.etm{width:58px;flex-shrink:0;text-align:right;padding-top:3px}
.et1{font-size:12px;font-weight:500;color:var(--t2)}
.et2{font-size:10px;color:var(--t3);margin-top:1px}
.eln{width:2px;background:var(--bd);border-radius:1px;position:relative;flex-shrink:0;min-height:38px}
.eln::before{content:'';position:absolute;top:7px;left:50%;transform:translateX(-50%);width:6px;height:6px;border-radius:50%;background:var(--bd)}
.ec{flex:1;background:var(--sf);border-radius:7px;padding:8px 12px;border:1px solid var(--bd);border-left:3px solid var(--tc,var(--pr));display:flex;align-items:center;justify-content:space-between;gap:9px;min-height:44px;transition:all var(--t)}
.ec.done{opacity:.42}.ec.done .en{text-decoration:line-through}.ec.fx{background:var(--s2)}.ec.overdue{border-left-color:var(--er)!important;background:rgba(176,40,32,.06)}
.rec-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--pr);margin-left:5px;vertical-align:middle;flex-shrink:0}
.en{font-size:13px;font-weight:500;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ckb{width:25px;height:25px;border-radius:50%;border:2px solid var(--bd);background:transparent;color:var(--t3);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all var(--t);flex-shrink:0}
.ckb:hover,.ckb.done{border-color:var(--ok);background:var(--ok);color:#fff}
.tray{background:var(--sf);border-radius:var(--r);border:1.5px dashed var(--bd);padding:13px}
.trttl{font-size:12px;font-weight:600;color:var(--t2);margin-bottom:9px;display:flex;align-items:center;gap:5px}
.tri{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:6px;background:var(--s2);margin-bottom:4px;cursor:pointer;transition:all var(--t);font-size:12px}
.tri:hover{background:var(--prl)}
.pdot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
/* Grid: now 27 rows (midnight → 3 AM next day) × 64px = 1728px */
.gv{flex:1;overflow:hidden;display:flex;flex-direction:column}
.ghdr{display:grid;grid-template-columns:50px repeat(7,1fr);border-bottom:1px solid var(--bd);background:var(--sf);flex-shrink:0}
.ghc{padding:7px 3px;text-align:center;border-left:1px solid var(--bd);cursor:pointer;transition:background var(--t)}
.ghc:hover{background:var(--prl)}
.gdn{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--t2)}
.gnum{font-family:var(--fd);font-size:17px;font-weight:700;margin-top:1px;line-height:1}
.gnum.tc{width:28px;height:28px;border-radius:50%;background:var(--pr);color:#fff;display:flex;align-items:center;justify-content:center;margin:1px auto 0;font-size:14px}
.gscr{flex:1;overflow-y:auto}
.gbody{display:grid;grid-template-columns:50px repeat(7,1fr);min-height:1728px}
.tlbls{background:var(--sf);border-right:1px solid var(--bd)}
.tlbl{height:64px;display:flex;align-items:flex-start;justify-content:flex-end;padding:3px 5px 0;font-size:10px;color:var(--t3);border-bottom:1px solid var(--bd)}
/* 6 AM pre-work zone: subtle tint on hours before 9 AM */
.tlbl.prework{color:rgba(var(--t3),.5)}
.dcol{border-left:1px solid var(--bd);position:relative;min-height:1728px}
/* Pre-work shading: 6–9 AM band — starts at 6*64=384px from top (GS=0 baseline) */
.prework-shade{position:absolute;left:0;right:0;top:384px;height:192px;background:repeating-linear-gradient(
  -45deg,transparent,transparent 4px,rgba(0,0,0,.025) 4px,rgba(0,0,0,.025) 5px
);pointer-events:none;z-index:0}
.hl{position:absolute;left:0;right:0;height:1px;background:var(--bd)}
.dw{position:absolute;left:0;right:0;background:var(--dw);border-top:1px dashed rgba(24,110,160,.22);pointer-events:none;z-index:1}
.dwl{position:absolute;right:3px;top:2px;font-size:8px;color:rgba(24,110,160,.35);font-weight:700;text-transform:uppercase;letter-spacing:.4px}
.ctl{position:absolute;left:0;right:0;height:2px;background:#D04040;z-index:20}
.ctl::before{content:'';position:absolute;left:-4px;top:-4px;width:10px;height:10px;border-radius:50%;background:#D04040}
.gev{position:absolute;left:2px;right:2px;border-radius:5px;padding:3px 6px;overflow:hidden;cursor:pointer;transition:opacity var(--t);border-left:3px solid var(--tc,var(--pr));z-index:5}
.gev:hover{opacity:.78}.gev.fx{opacity:.6}
.gevn{font-size:10px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--tx)}
.gevt{font-size:9px;color:var(--t2);margin-top:1px}
.dv{flex:1;overflow:hidden;display:flex}
.dvl{flex:1;overflow-y:auto;padding:20px;border-right:1px solid var(--bd)}
.dvr{width:272px;flex-shrink:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:20px}
.dvrttl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--t3);margin-bottom:10px}
.wkload{display:flex;gap:5px;align-items:flex-end;height:48px}
.wkdcol{display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;cursor:pointer}
.wkdbar{width:100%;border-radius:3px;background:var(--bd);position:relative;overflow:hidden;min-height:4px;height:40px}
.wkdfill{position:absolute;bottom:0;left:0;right:0;border-radius:3px;transition:height .3s}
.wkdlbl{font-size:9px;color:var(--t3);font-weight:600}
.wkdlbl.tod{color:var(--pr)}
.tbrow{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.tbbar{flex:1;height:7px;background:var(--bd);border-radius:4px;overflow:hidden}
.tbfill{height:100%;border-radius:4px}
.po{position:fixed;width:305px;background:var(--sf);border-radius:var(--r);border:1px solid var(--bd);box-shadow:var(--shl);z-index:500;padding:17px;animation:popIn .14s ease}
.poh{display:flex;align-items:flex-start;gap:7px;margin-bottom:9px}
.pon{flex:1;font-family:var(--fd);font-size:15px;font-weight:600;background:transparent;border:none;color:var(--tx);outline:none;border-bottom:1px dashed transparent;padding-bottom:1px;width:100%}
.pon:focus{border-bottom-color:var(--pr)}
.pox{width:25px;height:25px;border-radius:6px;border:none;background:var(--s2);color:var(--t2);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.pom{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:9px}
.poch{font-size:10px;padding:2px 8px;border-radius:99px;font-weight:500}
.pont{width:100%;background:var(--s2);border:1px solid var(--bd);border-radius:6px;padding:8px 10px;color:var(--tx);font-family:var(--fb);font-size:12px;resize:none;outline:none;min-height:56px;margin-bottom:9px;transition:border-color var(--t)}
.pont:focus{border-color:var(--pr)}
.poa{display:flex;gap:6px}
.pob{flex:1;padding:6px 9px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--tx);font-family:var(--fb);font-size:12px;font-weight:500;cursor:pointer;transition:all var(--t);display:flex;align-items:center;justify-content:center;gap:4px}
.pob:hover{background:var(--prl);border-color:var(--pr);color:var(--pr)}
.pob.ok{background:var(--ok);border-color:var(--ok);color:#fff}.pob.ok:hover{opacity:.85}
.pob.er:hover{background:rgba(176,40,32,.1);border-color:var(--er);color:var(--er)}
.mbk{position:fixed;inset:0;background:rgba(0,0,0,.52);backdrop-filter:blur(5px);z-index:400;display:flex;align-items:center;justify-content:center;padding:20px}
.modal{background:var(--sf);border-radius:14px;border:1px solid var(--bd);box-shadow:var(--shl);width:100%;max-width:450px;max-height:86vh;overflow-y:auto;padding:22px;animation:popIn .15s ease}
.mttl{font-family:var(--fd);font-size:19px;font-weight:700;margin-bottom:18px;display:flex;align-items:center;justify-content:space-between}
.fg{margin-bottom:14px}
.fl{font-size:10px;font-weight:700;color:var(--t2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px;display:block}
.finput{width:100%;background:var(--s2);border:1px solid var(--bd);border-radius:6px;padding:8px 12px;color:var(--tx);font-family:var(--fb);font-size:13px;outline:none;transition:border-color var(--t)}
.finput:focus{border-color:var(--pr)}
.frow{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.ttype{display:flex;background:var(--s2);border-radius:6px;padding:3px}
.ttb{flex:1;padding:6px;border-radius:5px;border:none;background:transparent;color:var(--t2);font-family:var(--fb);font-size:12px;font-weight:500;cursor:pointer;transition:all var(--t)}
.ttb.on{background:var(--sf);color:var(--tx);box-shadow:0 1px 4px rgba(0,0,0,.1)}
.pgrid{display:flex;gap:4px}
.pb{flex:1;aspect-ratio:1;border-radius:6px;border:2px solid var(--bd);background:transparent;font-family:var(--fd);font-size:13px;font-weight:700;cursor:pointer;transition:all var(--t);color:var(--t2)}
.pb.on{border-color:var(--pr);background:var(--prl);color:var(--pr)}
.tgs{display:flex;flex-wrap:wrap;gap:4px}
.tg{padding:3px 9px;border-radius:99px;border:1.5px solid var(--bd);background:transparent;font-family:var(--fb);font-size:11px;font-weight:500;cursor:pointer;transition:all var(--t);color:var(--t2)}
.tg.on{border-color:var(--tc);background:var(--tbg);color:var(--tc)}
.adv{display:flex;align-items:center;gap:4px;background:none;border:none;color:var(--t2);font-family:var(--fb);font-size:12px;cursor:pointer;padding:2px 0;margin-bottom:12px}
.sub{width:100%;padding:12px;border-radius:var(--r);border:none;background:var(--pr);color:#fff;font-family:var(--fb);font-size:13px;font-weight:600;cursor:pointer;transition:all var(--t);margin-top:4px}
.sub:hover{opacity:.88;transform:translateY(-1px)}
.sdbk{position:fixed;inset:0;background:rgba(0,0,0,.42);backdrop-filter:blur(3px);z-index:600;display:flex;justify-content:flex-end}
.sd{width:310px;height:100%;background:var(--sf);border-left:1px solid var(--bd);padding:19px;overflow-y:auto;animation:slideIn .2s ease}
.sdttl{font-family:var(--fd);font-size:17px;font-weight:700;margin-bottom:18px;display:flex;align-items:center;justify-content:space-between}
.ss{margin-bottom:18px}
.ssttl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--t3);margin-bottom:9px}
.srow{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--bd)}
.slbl{font-size:13px}
.ssub{font-size:10px;color:var(--t3);margin-top:1px}
.tog{width:40px;height:21px;border-radius:11px;background:var(--bd);position:relative;cursor:pointer;border:none;transition:background var(--t);flex-shrink:0}
.tog.on{background:var(--pr)}
.togk{position:absolute;top:2.5px;left:2.5px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform var(--t);box-shadow:0 1px 3px rgba(0,0,0,.2)}
.tog.on .togk{transform:translateX(19px)}
.ins-item{font-size:12px;color:var(--t2);padding:8px 10px;background:var(--s2);border-radius:6px;margin-bottom:6px;border-left:2px solid var(--pr);line-height:1.5}
.sat-num{width:38px;height:38px;border-radius:50%;border:2px solid var(--bd);background:transparent;font-family:var(--fd);font-size:14px;font-weight:700;cursor:pointer;transition:all var(--t);color:var(--t2);display:flex;align-items:center;justify-content:center}
.sat-num.on{border-color:var(--pr);background:var(--prl);color:var(--pr)}
.ics-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;background:var(--s2);margin-bottom:5px;cursor:pointer;transition:background var(--t)}
.ics-item:hover{background:var(--prl)}
.ics-chk{width:16px;height:16px;border-radius:4px;border:2px solid var(--bd);flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all var(--t)}
.ics-chk.on{background:var(--pr);border-color:var(--pr)}
.emp{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:48px 20px;color:var(--t3);text-align:center}
.emptl{font-family:var(--fd);font-size:17px;color:var(--t2)}
.empsb{font-size:12px;max-width:200px;line-height:1.55}
/* Feature: Force-today badge in AddModal */
.today-override{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:8px;background:rgba(192,90,32,.08);border:1.5px solid rgba(192,90,32,.3);cursor:pointer;transition:all var(--t);margin-bottom:14px}
.today-override.active{background:rgba(192,90,32,.16);border-color:var(--ac)}
.today-override input{accent-color:var(--ac);width:14px;height:14px;cursor:pointer}
/* ── Suggestions Page ─────────────────────────────────── */
.sug-pg{padding:18px 14px 40px;max-width:640px;margin:0 auto}
.sug-hdr{margin-bottom:18px}
.sug-title{font-size:20px;font-weight:800;letter-spacing:-.3px;color:var(--t1);margin-bottom:3px}
.sug-sub{font-size:12px;color:var(--t3);font-weight:400}
.sug-state{background:var(--sf);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin-bottom:20px}
.sug-state-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--t3);margin-bottom:10px}
.sug-dim-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
.sug-dim{display:flex;flex-direction:column;gap:3px}
.sug-dim-name{font-size:10px;font-weight:600;color:var(--t2);letter-spacing:.2px}
.sug-dim-bar{height:5px;border-radius:99px;background:var(--s2);overflow:hidden}
.sug-dim-fill{height:100%;border-radius:99px;transition:width .5s ease}
.sug-free{font-size:11px;color:var(--t2);margin-top:8px;padding-top:8px;border-top:1px solid var(--bd);display:flex;justify-content:space-between}
.sug-card{background:var(--sf);border:1.5px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:12px;transition:all var(--t);position:relative;overflow:hidden}
.sug-card:hover{border-color:var(--pr);box-shadow:0 2px 12px rgba(0,0,0,.08)}
.sug-card-hd{display:flex;align-items:flex-start;gap:10px;margin-bottom:8px}
.sug-emoji{font-size:22px;line-height:1;flex-shrink:0;margin-top:1px}
.sug-card-info{flex:1;min-width:0}
.sug-card-name{font-size:14px;font-weight:700;color:var(--t1);margin-bottom:3px}
.sug-card-dur{font-size:11px;color:var(--t3);margin-bottom:0}
.sug-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:99px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;flex-shrink:0;margin-top:2px}
.sug-badge.free{background:rgba(59,130,246,.12);color:#3b82f6}
.sug-badge.light{background:rgba(245,158,11,.12);color:#d97706}
.sug-badge.deep{background:rgba(139,92,246,.12);color:#7c3aed}
.sug-badge.social{background:rgba(16,185,129,.12);color:#059669}
.sug-badge.academic{background:rgba(36,104,168,.14);color:#245ea8}
.sug-badge.recent{background:rgba(96,112,144,.12);color:var(--t2)}
.sug-section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--t3);margin:18px 0 10px;display:flex;align-items:center;gap:6px}
.sug-why{font-size:12px;color:var(--t2);line-height:1.55;margin-bottom:12px;font-style:italic;padding-left:32px}
.sug-actions{display:flex;gap:8px;align-items:center;padding-left:32px;flex-wrap:wrap}
.sug-add{padding:6px 14px;border-radius:99px;border:none;background:var(--pr);color:#fff;font-size:11px;font-weight:600;cursor:pointer;font-family:var(--fb);transition:all var(--t)}
.sug-add:hover{opacity:.88}
.sug-dismiss{padding:6px 10px;border-radius:99px;border:1px solid var(--bd);background:transparent;color:var(--t3);font-size:11px;cursor:pointer;font-family:var(--fb);transition:all var(--t)}
.sug-dismiss:hover{color:var(--t1);border-color:var(--t2)}
.sug-reroll{padding:6px 10px;border-radius:99px;border:1px solid var(--bd);background:transparent;color:var(--pr);font-size:11px;cursor:pointer;font-family:var(--fb);font-weight:600;transition:all var(--t)}
.sug-time-row{display:flex;gap:8px;align-items:center;padding-left:32px;margin-bottom:10px;flex-wrap:wrap}
.sug-time-row input{padding:5px 8px;border-radius:6px;border:1px solid var(--bd);background:var(--s2);color:var(--t1);font-size:12px;font-family:var(--fb);width:108px}
.sug-sq-name{font-size:12px;font-weight:600;color:var(--pr);padding-left:32px;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.sug-empty{text-align:center;padding:48px 20px;color:var(--t3)}
.sug-empty-icon{font-size:36px;margin-bottom:10px}
.sug-burnout-strip{background:rgba(139,92,246,.07);border:1.5px solid rgba(139,92,246,.2);border-radius:10px;padding:10px 14px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11px;color:var(--t2)}
.sug-sat-callout{background:var(--s2);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:11px;color:var(--t2);line-height:1.5;border-left:3px solid var(--pr)}
.sg-slot{padding:10px 12px;background:var(--s2);border-radius:8px;border:1px solid var(--bd);margin-bottom:6px;cursor:pointer;transition:all var(--t);display:flex;align-items:flex-start;gap:9px}
.sg-slot:hover{border-color:var(--pr);background:var(--prl)}
.sg-rank{width:20px;height:20px;border-radius:50%;background:var(--ok);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.sg-time{font-size:13px;font-weight:600}
.sg-why{font-size:10px;color:var(--t2);margin-top:2px;line-height:1.4}
/* AI group scheduling */
.ai-slot{padding:10px 12px;background:var(--s2);border-radius:8px;border:1px solid var(--bd);margin-bottom:6px;cursor:pointer;transition:all var(--t)}
.ai-slot:hover{border-color:var(--pr);background:var(--prl)}
.ai-slot-rank{width:20px;height:20px;border-radius:50%;background:var(--pr);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.ai-slot-time{font-size:13px;font-weight:600}
.ai-slot-why{font-size:10px;color:var(--t2);margin-top:2px;line-height:1.4}
/* Evening limit slider */
.eve-slider{width:100%;accent-color:var(--pr);cursor:pointer;margin-top:4px}
@media print{.no-print{display:none!important}.print-pg{display:block!important}.app{height:auto;overflow:visible}body{overflow:visible}}
@media print{.print-preview-overlay{position:static!important;background:white!important;padding:0!important}.print-preview-no-print{display:none!important}.app,.app>*{display:none!important}.print-preview-overlay{display:block!important}}
/* Core edit in popover */
.core-edit{background:var(--s2);border-radius:8px;padding:10px;margin-bottom:9px;border:1px solid var(--bd)}
.core-edit-row{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:7px}
/* ML tag rows */
.ml-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:11px}
.ml-bar{flex:1;height:5px;background:var(--bd);border-radius:3px;overflow:hidden}
.ml-fill{height:100%;border-radius:3px;transition:width .5s}
/* Drag tooltip */
.drag-float{position:fixed;background:var(--hb);color:var(--ht);border-radius:7px;padding:5px 11px;font-size:11px;pointer-events:none;z-index:998;box-shadow:0 4px 14px rgba(0,0,0,.32);white-space:nowrap;transform:translateY(-50%);display:flex;align-items:center;gap:5px}
/* Bounce toast */
.bounce-toast{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:999;background:var(--er);color:#fff;border-radius:8px;padding:7px 16px;font-size:12px;font-weight:600;white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,.28);animation:popIn .15s ease;pointer-events:none}
/* Bump toast */
.bump-toast{background:var(--ok)}
/* Bump-confirm modal */
.bco{position:fixed;inset:0;background:rgba(0,0,0,.52);backdrop-filter:blur(3px);z-index:700;display:flex;align-items:center;justify-content:center;padding:20px}
.bcm{background:var(--sf);border-radius:14px;border:1px solid var(--bd);box-shadow:var(--shl);width:100%;max-width:380px;padding:22px;animation:popIn .15s ease}
.bci{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:8px;margin-bottom:6px;cursor:pointer;border:1.5px solid var(--bd);background:var(--s2);transition:border-color var(--t),background var(--t)}
.bci.on{background:var(--prl);border-color:var(--pr)}
.bcw{margin-top:10px;padding:9px 12px;border-radius:7px;background:rgba(176,40,32,.07);border:1px solid rgba(176,40,32,.22);font-size:12px;color:var(--er);line-height:1.55}
/* Conflict badge */
.gev.conflict{border-left-color:#D04040!important}
.conflict-dot{position:absolute;top:2px;right:3px;width:7px;height:7px;border-radius:50%;background:#D04040;z-index:10}
/* Initiation nudge */
.nudge-banner{border-radius:var(--r);padding:11px 15px;display:flex;align-items:center;gap:10px;font-size:13px;font-weight:500;border:1.5px solid var(--ac);background:rgba(192,90,32,.08);color:var(--ac);animation:nudgePulse 1.4s ease-in-out infinite}
@keyframes nudgePulse{0%,100%{box-shadow:0 0 0 0 rgba(192,90,32,.35)}50%{box-shadow:0 0 0 8px rgba(192,90,32,0)}}
/* Auto-reset label */
.gev.auto-reset{border-left-color:var(--ok)!important;opacity:.75}
.gev.dragging{pointer-events:none}
.print-pg{display:none}
@keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
@keyframes popIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
@keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bd);border-radius:2px}
`;

// ─── EvRow ────────────────────────────────────────────────────────────────────
function EvRow({ev, onDone, onDoneCore, onClick}) {
  const tc=tC(ev.tags?.[0]||ev.tag||'');
  const isF  = ev.isCoreBlock === true;
  const done = ev.isCompleted;
  const tag  = ev.tags?.[0]||ev.tag||'';
  const isOverdue = !isF && ev.isOverdue && !done;
  const showPin   = !isF && ev.isPinned;
  const isCoreTrackable = isF && ev.trackable === true;
  return (
    <div className="er" onClick={onClick}>
      <div className="etm">
        <div className="et1">{fT(ev.scheduledStart||ev.startTime)}</div>
        <div className="et2">{fT(ev.scheduledEnd||ev.endTime)}</div>
      </div>
      <div className="eln"/>
      <div className={`ec${done?' done':''}${isF?' fx':''}${isOverdue?' overdue':''}`} style={{'--tc':tc}}>
        <div style={{flex:1,minWidth:0}}>
          <div className="en">
            {ev.name}
            {ev.recurrenceGroupId&&<span className="rec-dot" title="Recurring"/>}
            {showPin&&<span className="rec-dot" style={{background:'var(--ac)',marginLeft:4}} title="Pinned — time locked"/>}
          </div>
          {tag&&<div style={{fontSize:10,color:tc,fontWeight:500,marginTop:2}}>{tag}</div>}
          {isOverdue&&<div style={{fontSize:9,color:'var(--er)',fontWeight:700,marginTop:2,letterSpacing:.3}}>OVERDUE · {ev.deadline}</div>}
        </div>
        {isCoreTrackable
          ? <button className={`ckb${done?' done':''}`} onClick={e=>{e.stopPropagation();onDoneCore&&onDoneCore(ev.id,ev.scheduledDate);}}>
              <Check size={10}/>
            </button>
          : isF
            ? <Lock size={12} style={{color:'var(--t3)',flexShrink:0}}/>
            : ev.trackable!==false
              ? <button className={`ckb${done?' done':''}`} onClick={e=>{e.stopPropagation();onDone(ev.id);}}>
                  <Check size={10}/>
                </button>
              : <span style={{fontSize:9,color:'var(--t3)',padding:'0 2px',letterSpacing:.2,flexShrink:0}}>–</span>}
      </div>
    </div>
  );
}

// ─── Today View ───────────────────────────────────────────────────────────────
function TodayView({sched, core, onDone, onSel, onAdd, onRate, completedCoreInstances={}, onDoneCore}) {
  const [now, setNow] = useState(new Date());
  useEffect(()=>{ const iv=setInterval(()=>setNow(new Date()),30000); return ()=>clearInterval(iv); },[]);
  const t=now, tk=dK(t), dn=dN(t);
  const dateStr=t.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  const fx=core.filter(b=>b.days.includes(dn)&&!b.optOut&&toM(b.endTime)>GS*60)
    .map(b=>({...b,isFixed:true,isCoreBlock:true,scheduledStart:b.startTime,scheduledEnd:b.endTime,tags:[b.tag],
      scheduledDate:tk,isCompleted:!!completedCoreInstances[b.id+'|'+tk]}));
  const active=sched.filter(s=>s.scheduledDate===tk&&!s.isCompleted);
  const done  =sched.filter(s=>s.completedDate===tk&&s.isCompleted);
  const unsch =sched.filter(s=>s.type==='flexible'&&!s.scheduledDate&&!s.isCompleted);
  const all   =[...fx,...active].sort((a,b)=>toM(a.scheduledStart||a.startTime)-toM(b.scheduledStart||b.startTime));
  const tot=active.length+done.length, pct=tot>0?done.length/tot:0;
  const nm=t.getHours()*60+t.getMinutes();
  const cur=all.find(e=>{const s=toM(e.scheduledStart||e.startTime),en=toM(e.scheduledEnd||e.endTime);return nm>=s&&nm<en;});
  const nudgeTask=all.find(e=>{
    if(e.isCompleted||e.isCoreBlock) return false;
    const s=toM(e.scheduledStart||e.startTime);
    return s>nm&&s-nm<=5;
  });
  return (
    <div className="tv" style={{animation:'fadeIn .22s ease'}}>
      {nudgeTask&&(
        <div className="nudge-banner">
          <Clock size={16}/>
          <span>Starting in {toM(nudgeTask.scheduledStart||nudgeTask.startTime)-nm} min: <strong>{nudgeTask.name}</strong> — time to wrap up and get ready.</span>
        </div>
      )}
      {sched.filter(t=>t.isOverdue&&!t.isCompleted).length>0&&(
        <div style={{background:'rgba(176,40,32,.1)',borderRadius:'var(--r)',padding:'10px 14px',border:'1.5px solid var(--er)',fontSize:12,color:'var(--er)',fontWeight:500,display:'flex',gap:8,alignItems:'flex-start',marginBottom:8}}>
          <AlertTriangle size={14} style={{flexShrink:0,marginTop:1}}/>
          <div>
            <div style={{fontWeight:700,marginBottom:3}}>Overdue deadline{sched.filter(t=>t.isOverdue&&!t.isCompleted).length>1?'s':''}</div>
            {sched.filter(t=>t.isOverdue&&!t.isCompleted).map(t=>(
              <div key={t.id} style={{fontWeight:400,marginTop:1,opacity:.9}}>"{t.name}" — was due {t.deadline}</div>
            ))}
          </div>
        </div>
      )}
      {sched.filter(t=>t.priority>=4&&!t.scheduledDate&&!t.isCompleted).length>0&&(
        <div style={{background:'rgba(176,40,32,.1)',borderRadius:'var(--r)',padding:'10px 14px',border:'1px solid var(--er)',fontSize:12,color:'var(--er)',fontWeight:500,display:'flex',gap:8,alignItems:'center'}}>
          <span>⚠️</span>
          <span>{sched.filter(t=>t.priority>=4&&!t.scheduledDate&&!t.isCompleted).map(t=>t.name).join(', ')} — high priority but no slot found this week</span>
        </div>
      )}
      <div className="tvtop">
        <div>
          <div className="tvdate">{dateStr.split(',')[0]}</div>
          <div style={{fontFamily:'var(--fd)',fontSize:14,color:'var(--t2)',marginTop:2}}>{dateStr.split(',').slice(1).join(',')}</div>
          {cur&&<div style={{marginTop:5,fontSize:11,color:'var(--pr)',fontWeight:500}}>Now: {cur.name}</div>}
        </div>
        <div className="pcard">
          <div className="plbl">{done.length} of {tot} tasks done</div>
          <div className="pbar"><div className="pfill" style={{width:`${pct*100}%`}}/></div>
          <div className="ppct">{Math.round(pct*100)}%</div>
        </div>
      </div>
      {all.length>0 ? (
        <div>
          {all.map(e=><EvRow key={e.id} ev={e} onDone={onDone} onDoneCore={onDoneCore} onClick={()=>onSel(e)}/>)}
          {done.length>0&&<div style={{marginTop:14}}>
            <div style={{fontSize:10,color:'var(--t3)',fontWeight:700,textTransform:'uppercase',letterSpacing:1,marginBottom:7,paddingLeft:6}}>Completed</div>
            {done.map(e=><EvRow key={e.id} ev={e} onDone={onDone} onDoneCore={onDoneCore} onClick={()=>onSel(e)}/>)}
          </div>}
        </div>
      ) : (
        <div className="emp">
          <div style={{fontSize:38}}>🏖️</div>
          <div className="emptl">Clear day ahead</div>
          <div className="empsb">Add tasks — the scheduler will find your best windows</div>
          <button className="abtn" onClick={onAdd} style={{marginTop:8}}><Plus size={12}/>Add Task</button>
        </div>
      )}
      {unsch.length>0&&<div className="tray">
        <div className="trttl"><Zap size={12} style={{color:'var(--ac)'}}/>Unscheduled ({unsch.length})</div>
        {unsch.map(t=>(
          <div key={t.id} className="tri" onClick={()=>onSel(t)}>
            <div className="pdot" style={{background:PCOLS[t.priority]||'#888'}}/>
            <span style={{flex:1}}>{t.name}</span>
            <span style={{color:'var(--t3)'}}>{t.duration}m · P{t.priority}</span>
          </div>
        ))}
      </div>}
      <button onClick={onRate} style={{display:'flex',alignItems:'center',gap:6,padding:'10px 14px',borderRadius:'var(--r)',border:'1px solid var(--bd)',background:'var(--sf)',color:'var(--t2)',cursor:'pointer',fontSize:12,fontFamily:'var(--fb)',width:'100%',justifyContent:'center',transition:'all var(--t)'}}>
        <Star size={13}/>Rate today's schedule
      </button>
    </div>
  );
}

// ─── Grid View ────────────────────────────────────────────────────────────────
function GridView({wkDates, sched, core, onSel, onDayClick, onReschedule}) {
  const nm=new Date().getHours()*60+new Date().getMinutes();

  const dragRef=useRef(null);
  const gridBodyRef=useRef(null);
  const [dragState,setDragState]=useState(null);
  const [bounceMsg,setBounceMsg]=useState('');
  const [bumpMsg,setBumpMsg]=useState('');
  // bumpConfirm holds pending drag drop that needs user sign-off on pinned/fixed overlaps
  const [bumpConfirm,setBumpConfirm]=useState(null);

  // Called when user clicks Confirm in the pinned-task bump dialog.
  // All listed pinned tasks are bumped; flex overlaps are bumped unconditionally.
  const handleBumpConfirm=useCallback((confirm,bumpedPinnedIds)=>{
    const {ev,targetDate,newStartM,newEndM,flex}=confirm;
    const bumpedIds=[...bumpedPinnedIds,...flex.map(t=>t.id)];
    if(bumpedPinnedIds.length>0){
      const names=bumpedPinnedIds.map(id=>confirm.pinned.find(t=>t.id===id)?.name).filter(Boolean).map(n=>`"${n}"`).join(', ');
      setBumpMsg(`↩ ${names} bumped — will be rescheduled`);
      setTimeout(()=>setBumpMsg(''),3000);
    }
    onReschedule(ev.id,targetDate,toS(newStartM),toS(newEndM),bumpedIds);
    setBumpConfirm(null);
  },[onReschedule]);

  const getDay=date=>{
    const dn=dN(date), dk2=dK(date);
    const fx=core.filter(b=>b.days.includes(dn)&&!b.optOut&&toM(b.endTime)>GS*60)
      .map(b=>({...b,isFixed:true,isCoreBlock:true,scheduledStart:b.startTime,scheduledEnd:b.endTime,tags:[b.tag]}));
    const flex=sched.filter(t=>t.scheduledDate===dk2);
    return [...fx,...flex];
  };

  const conflictSets=useMemo(()=>{
    const map={};
    wkDates.forEach(date=>{ map[dK(date)]=computeConflicts(getDay(date)); });
    return map;
  },[wkDates,sched,core]);

  // ── pointerdown ───────────────────────────────────────────────────────────
  const handlePointerDown=useCallback((e,ev,date)=>{
    if(ev.isCoreBlock||ev.isAutoInserted) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const origStartM=toM(ev.scheduledStart);
    // Use scheduledEnd – scheduledStart for exact duration; fall back to ev.duration
    const dur=ev.scheduledEnd
      ? toM(ev.scheduledEnd)-origStartM
      : ev.duration||30;
    dragRef.current={ev, origDate:dK(date), startY:e.clientY, origStartM, dur};
    setDragState({id:ev.id, deltaM:0, targetDate:dK(date), ghostX:e.clientX, ghostY:e.clientY});
  },[]);

  // ── pointermove ───────────────────────────────────────────────────────────
  const handlePointerMove=useCallback((e)=>{
    if(!dragRef.current) return;
    const dy=e.clientY-dragRef.current.startY;
    const snapped=Math.round((dy/HH*60)/15)*15;
    let targetDate=dragRef.current.origDate;
    if(gridBodyRef.current){
      const rect=gridBodyRef.current.getBoundingClientRect();
      const xInGrid=e.clientX-rect.left-50;
      const colW=(rect.width-50)/7;
      const colIdx=Math.max(0,Math.min(6,Math.floor(xInGrid/colW)));
      targetDate=dK(wkDates[colIdx]);
    }
    setDragState(p=>p?{...p,deltaM:snapped,targetDate,ghostX:e.clientX,ghostY:e.clientY}:null);
  },[wkDates]);

  // ── pointerup: validate → bounce OR bump → commit ─────────────────────────
  const handlePointerUp=useCallback((e)=>{
    if(!dragRef.current) return;
    const {ev,origDate,origStartM,dur}=dragRef.current;
    const delta=dragState?.deltaM||0;
    const targetDate=dragState?.targetDate||origDate;
    const moved=delta!==0||targetDate!==origDate;

    if(moved&&onReschedule){
      const newStartM=Math.max(GS*60, origStartM+delta);
      const newEndM=newStartM+dur;

      // ── Collision: bounce off fixed/core blocks ───────────────────────────
      const targetDayObj=wkDates.find(d=>dK(d)===targetDate);
      const targetDN=targetDayObj?dN(targetDayObj):'';
      const fixedHit=core.filter(b=>b.days.includes(targetDN)&&!b.optOut).find(b=>{
        const bs=toM(b.startTime), be=toM(b.endTime);
        return newStartM<be&&newEndM>bs;
      });
      if(fixedHit){
        setBounceMsg(`⛔ Can't overlap "${fixedHit.name}" — fixed block`);
        setTimeout(()=>setBounceMsg(''),2800);
        dragRef.current=null; setDragState(null);
        return;
      }

      // ── Collision: split overlapping tasks into pinned (need confirm) vs flex ──
      const overlapping=sched.filter(t=>{
        if(t.isCoreBlock||t.isAutoInserted||t.id===ev.id) return false;
        if(t.scheduledDate!==targetDate||!t.scheduledStart) return false;
        const ts=toM(t.scheduledStart);
        const te=t.scheduledEnd?toM(t.scheduledEnd):ts+(t.duration||30);
        return newStartM<te&&newEndM>ts;
      });
      const pinnedOverlaps=overlapping.filter(t=>t.isPinned||t.type==='fixed');
      const flexOverlaps  =overlapping.filter(t=>!t.isPinned&&t.type!=='fixed');

      if(pinnedOverlaps.length>0){
        // Defer to confirmation modal — all pinned tasks pre-checked by default
        setBumpConfirm({
          ev,targetDate,newStartM,newEndM,
          pinned:pinnedOverlaps,
          flex:flexOverlaps,
        });
        dragRef.current=null; setDragState(null);
        return;
      }

      // No pinned overlaps — auto-bump flex tasks and commit immediately
      if(flexOverlaps.length>0){
        const names=flexOverlaps.map(t=>`"${t.name}"`).join(', ');
        setBumpMsg(`↩ ${names} bumped — will be rescheduled`);
        setTimeout(()=>setBumpMsg(''),3000);
      }
      onReschedule(ev.id,targetDate,toS(newStartM),toS(newEndM),flexOverlaps.map(t=>t.id));
    }
    dragRef.current=null; setDragState(null);
  },[dragState,onReschedule,core,sched,wkDates,setBumpConfirm]);

  const dragging=dragRef.current;
  const ghostStartM=dragging?Math.max(GS*60, dragging.origStartM+(dragState?.deltaM||0)):0;
  const ghostDateStr=dragState?.targetDate||'';

  return (
    <div className="gv" style={{animation:'fadeIn .22s ease',position:'relative'}}
      onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}>

      {bounceMsg&&<div className="bounce-toast">{bounceMsg}</div>}
      {bumpMsg&&<div className="bounce-toast bump-toast">{bumpMsg}</div>}

      {/* ── Pinned-task bump confirmation modal ─────────────────────────── */}
      {bumpConfirm&&(()=>{
        const {pinned,flex}=bumpConfirm;
        return(
          <div className="bco" onPointerDown={e=>e.stopPropagation()}>
            <div className="bcm">
              <div style={{fontFamily:'var(--fd)',fontSize:17,fontWeight:700,marginBottom:5,color:'var(--tx)'}}>
                {pinned.length===1?'A pinned task':'Pinned tasks'} in the way
              </div>
              <div style={{fontSize:12,color:'var(--t2)',marginBottom:14,lineHeight:1.55}}>
                {pinned.length===1?'This task is':'These tasks are'} pinned at this time.
                Confirming will bump {pinned.length===1?'it':'them'} — {pinned.length===1?'it':'they'}'ll be rescheduled automatically.
              </div>
              {pinned.map(t=>{
                const dur=t.scheduledEnd?toM(t.scheduledEnd)-toM(t.scheduledStart):t.duration||30;
                return(
                  <div key={t.id} className="bci on" style={{cursor:'default'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:500,color:'var(--tx)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{t.name}</div>
                      <div style={{fontSize:11,color:'var(--t2)',marginTop:2}}>{fT(t.scheduledStart)} · {dur}m · P{t.priority}</div>
                    </div>
                    <div style={{fontSize:10,fontWeight:600,color:'var(--ac)',flexShrink:0,paddingLeft:6}}>PINNED</div>
                  </div>
                );
              })}
              {flex.length>0&&(
                <div style={{fontSize:11,color:'var(--t3)',marginTop:8,paddingLeft:2}}>
                  {flex.map(t=>`"${t.name}"`).join(', ')} {flex.length===1?'is':'are'} flexible and will also be bumped.
                </div>
              )}
              <div style={{display:'flex',gap:8,marginTop:16}}>
                <button className="pob" onClick={()=>setBumpConfirm(null)}>Cancel</button>
                <button
                  className="sub"
                  style={{flex:2,margin:0,padding:'9px 0',fontSize:13}}
                  onClick={()=>handleBumpConfirm(bumpConfirm,[...bumpConfirm.pinned.map(t=>t.id)])}
                >Bump &amp; Place</button>
              </div>
            </div>
          </div>
        );
      })()}

      {dragState&&dragging&&(
        <div className="drag-float" style={{left:dragState.ghostX+16,top:dragState.ghostY}}>
          <span>{dragging.ev.name}</span>
          <span style={{opacity:.6}}>·</span>
          <span style={{color:'var(--pr)',fontWeight:700}}>
            {ghostDateStr!==dragging.origDate
              ?`${DAYS[wkDates.find(d=>dK(d)===ghostDateStr)?.getDay()??0]} `:''}
            {fT(toS(ghostStartM))}
          </span>
        </div>
      )}

      <div className="ghdr">
        <div/>{/* spacer: aligns with .tlbls time-label column */}
        {wkDates.map((d,i)=>(
          <div key={i} className="ghc" onClick={()=>onDayClick(d)}>
            <div className="gdn">{DAYS[d.getDay()]}</div>
            <div className={isTod(d)?'gnum tc':'gnum'}>{d.getDate()}</div>
          </div>
        ))}
      </div>

      <div className="gscr">
        <div className="gbody" ref={gridBodyRef}>
          <div className="tlbls">
            {hrsRaw.map(rawH=>{
              const h=rawH>=24?rawH-24:rawH;
              const isPreWork=rawH>=6&&rawH<9; // 6, 7, 8 AM pre-work zone
              const lbl=h===0?'12a':h===12?'12p':h>12?`${h-12}p`:`${h}a`;
              const isMid=rawH===24;
              return (
                <div key={rawH} className={`tlbl${isPreWork?' prework':''}`}
                  style={{borderTop:isMid?'1px dashed var(--pr)':undefined,color:isMid?'var(--pr)':isPreWork?'var(--t3)':undefined,opacity:isPreWork?.6:1}}>
                  {lbl}
                </div>
              );
            })}
          </div>

          {wkDates.map((date,di)=>{
            const tod=isTod(date), evs=getDay(date), dk2=dK(date);
            const conflicts=conflictSets[dk2]||new Set();
            const isDragTarget=!!dragState&&dragState.targetDate===dk2&&dragState.targetDate!==dragging?.origDate;

            return (
              <div key={di} className="dcol" style={{
                background:isDragTarget?'rgba(24,110,160,.055)':tod?'rgba(24,110,160,.018)':undefined,
                outline:isDragTarget?'1px solid rgba(24,110,160,.3)':'none',
                transition:'background .1s',
              }}>
                {/* Pre-work zone shading: 6–9 AM hatching */}
                <div className="prework-shade"/>

                {hrsRaw.map((rawH,hi)=>(
                  <div key={rawH} className="hl" style={{top:hi*HH,borderColor:rawH===24?'var(--pr)':undefined,opacity:rawH===24?0.5:1}}/>
                ))}

                <div className="dw" style={{top:yMn(DW_S),height:yH(DW_E-DW_S)}}><span className="dwl">Deep Work</span></div>
                {tod&&nm>GS*60&&nm<GE*60&&<div className="ctl" style={{top:yMn(nm)}}/>}

                {/* Ghost block in TARGET column during cross-column drag */}
                {isDragTarget&&dragging&&(()=>{
                  const ghostH=Math.max(yH(dragging.dur),16);
                  const ghostTop=Math.max(0,yMn(ghostStartM));
                  const tc=tC(dragging.ev.tags?.[0]||'');
                  return (
                    <div style={{position:'absolute',left:2,right:2,top:ghostTop,height:ghostH,
                      background:`rgba(${hRgb(tc)},.18)`,borderRadius:5,
                      border:`1.5px dashed ${tc}`,pointerEvents:'none',zIndex:8}}>
                      <div style={{fontSize:10,fontWeight:600,padding:'2px 5px',overflow:'hidden',
                        whiteSpace:'nowrap',textOverflow:'ellipsis',color:'var(--tx)'}}>
                        {dragging.ev.name}
                      </div>
                    </div>
                  );
                })()}

                {evs.map((ev,ei)=>{
                  const isDragging=dragState?.id===ev.id;
                  const sameCol=dragging?.origDate===dk2;
                  const deltaM=isDragging&&sameCol?dragState.deltaM:0;
                  const startM=toM(ev.scheduledStart||ev.startTime)+deltaM;
                  const evDur=ev.scheduledEnd
                    ? crossMidDur(toM(ev.scheduledStart||ev.startTime), toM(ev.scheduledEnd))
                    : ev.duration||30;
                  const top=yMn(startM), height=Math.max(yH(evDur),24);
                  if(top+height<0) return null;
                  const tc=tC(ev.tags?.[0]||ev.tag||'');
                  const hasConflict=conflicts.has(ev.id);
                  const crossCol=isDragging&&!sameCol;
                  const opacity=crossCol?0.25:isDragging?0.5:1;

                  return (
                    <div key={ev.id+ei}
                      className={`gev${ev.isCoreBlock?' fx':''}${hasConflict?' conflict':''}${isDragging?' dragging':''}${ev.isAutoInserted?' auto-reset':''}`}
                      style={{top:Math.max(top,0),height,background:`rgba(${hRgb(tc)},.13)`,
                        '--tc':tc,cursor:ev.isCoreBlock?'default':'grab',opacity,
                        transition:isDragging?'none':'opacity var(--t)'}}
                      onClick={()=>!dragState&&onSel(ev)}
                      onPointerDown={ev.isCoreBlock?undefined:(e)=>handlePointerDown(e,ev,date)}>
                      <div className="gevn">{ev.name}</div>
                      {height>24&&(
                        <div className="gevt">
                          {fT(ev.scheduledStart||ev.startTime)}
                          {isDragging&&sameCol&&deltaM!==0&&` → ${fT(toS(toM(ev.scheduledStart)+deltaM))}`}
                        </div>
                      )}
                      {hasConflict&&<div className="conflict-dot" title="Scheduling conflict"/>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Day View ─────────────────────────────────────────────────────────────────
function DayView({selDate, wkDates, sched, core, onSel, onDone, onDayChange, completedCoreInstances={}, onDoneCore}) {
  const dk2=dK(selDate), dn=dN(selDate);
  const dateStr=selDate.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  const fx=core.filter(b=>b.days.includes(dn)&&!b.optOut&&toM(b.endTime)>GS*60)
    .map(b=>({...b,isFixed:true,isCoreBlock:true,scheduledStart:b.startTime,scheduledEnd:b.endTime,tags:[b.tag],
      scheduledDate:dk2,isCompleted:!!completedCoreInstances[b.id+'|'+dk2]}));
  const dayTasks=sched.filter(t=>t.scheduledDate===dk2);
  const all=[...fx,...dayTasks].sort((a,b)=>toM(a.scheduledStart||a.startTime)-toM(b.scheduledStart||b.startTime));
  const totalH=(all.reduce((a,e)=>a+(toM(e.scheduledEnd||e.endTime)-toM(e.scheduledStart||e.startTime)),0)/60);
  const tagHours={};
  all.forEach(ev=>{
    const tag=ev.tags?.[0]||ev.tag||'Other';
    tagHours[tag]=(tagHours[tag]||0)+(toM(ev.scheduledEnd||ev.endTime)-toM(ev.scheduledStart||ev.startTime))/60;
  });
  const tagList=Object.entries(tagHours).sort((a,b)=>b[1]-a[1]);
  const maxH=tagList[0]?.[1]||1;
  const wkLoad=wkDates.map(d=>{
    const dn3=dN(d), dk3=dK(d);
    const fx2=core.filter(b=>b.days.includes(dn3)&&!b.optOut).reduce((a,b)=>{const dd=toM(b.endTime)-toM(b.startTime);return a+(dd>0?dd:0);},0)/60;
    const fl=sched.filter(t=>t.scheduledDate===dk3).reduce((a,t)=>a+t.duration/60,0);
    return Math.min((fx2+fl)/14,1);
  });
  return (
    <div className="dv" style={{animation:'fadeIn .22s ease'}}>
      <div className="dvl">
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:16}}>
          <button className="narr" onClick={()=>onDayChange(-1)}><ChevronLeft size={12}/></button>
          <div style={{flex:1}}>
            <div style={{fontFamily:'var(--fd)',fontSize:20,fontWeight:700}}>{dateStr.split(',')[0]}</div>
            <div style={{fontSize:12,color:'var(--t2)'}}>{dateStr.split(',').slice(1).join(',')}</div>
          </div>
          <button className="narr" onClick={()=>onDayChange(1)}><ChevronRight size={12}/></button>
        </div>
        {all.length>0
          ? all.map(e=><EvRow key={e.id} ev={e} onDone={onDone} onDoneCore={onDoneCore} onClick={()=>onSel(e)}/>)
          : <div className="emp"><div style={{fontSize:32}}>🏄</div><div className="emptl">Nothing scheduled</div><div className="empsb">Add tasks and they'll appear here</div></div>}
      </div>
      <div className="dvr no-print">
        <div>
          <div className="dvrttl">Week Overview</div>
          <div className="wkload">
            {wkDates.map((d,i)=>{
              const isSel=dK(d)===dk2, isT=isTod(d);
              return (
                <div key={i} className="wkdcol" onClick={()=>onDayChange(null,d)}>
                  <div className="wkdbar">
                    <div className="wkdfill" style={{height:`${wkLoad[i]*100}%`,background:isSel?'var(--pr)':isT?'var(--ac)':'var(--bd)'}}/>
                  </div>
                  <div className={`wkdlbl${isT?' tod':''}`} style={{fontWeight:isSel?700:400}}>{DAYS[d.getDay()][0]}</div>
                </div>
              );
            })}
          </div>
        </div>
        {all.length>0&&<div>
          <div className="dvrttl">Day Stats</div>
          <div style={{display:'flex',gap:8}}>
            {[['Tasks',all.length],['Done',dayTasks.filter(t=>t.isCompleted).length],['Hours',totalH.toFixed(1)+'h']].map(([l,v])=>(
              <div key={l} style={{flex:1,background:'var(--s2)',borderRadius:'var(--rs)',padding:'10px 8px',textAlign:'center',border:'1px solid var(--bd)'}}>
                <div style={{fontSize:18,fontFamily:'var(--fd)',fontWeight:700,color:'var(--pr)'}}>{v}</div>
                <div style={{fontSize:10,color:'var(--t2)',marginTop:2}}>{l}</div>
              </div>
            ))}
          </div>
        </div>}
        {tagList.length>0&&<div>
          <div className="dvrttl">Time by Tag</div>
          {tagList.map(([tag,h])=>(
            <div key={tag} className="tbrow">
              <div style={{width:72,fontSize:10,color:tC(tag),fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flexShrink:0}}>{tag}</div>
              <div className="tbbar"><div className="tbfill" style={{width:`${(h/maxH)*100}%`,background:tC(tag)}}/></div>
              <div style={{fontSize:10,color:'var(--t2)',width:28,textAlign:'right',flexShrink:0}}>{h.toFixed(1)}h</div>
            </div>
          ))}
        </div>}
      </div>
    </div>
  );
}

// ─── Satisfaction Modal ───────────────────────────────────────────────────────
const LOAD_LBL=['','Overwhelmed','Too much','About right','Could do more','Underloaded'];
const EXEC_LBL=['','Schedule useless','Significant drift','Roughly followed','Mostly on track','Nailed it'];
const SAT_LBL=['','😩 Awful','😕 Meh','😐 OK','🙂 Good','🤩 Great'];
function SatModal({onClose, onSave, todayTasks}) {
  const [load,setLoad]=useState(0), [exec,setExec]=useState(0);
  const [step,setStep]=useState(1); // 1 = day rating, 2 = per-task
  // per-task: { [id]: {sat:0, actual:''} }
  const [taskData,setTaskData]=useState(()=>{
    const m={};
    (todayTasks||[]).forEach(t=>{m[t.id]={sat:0,actual:''};});
    return m;
  });
  const ready=load>0&&exec>0;
  const setTD=(id,key,val)=>setTaskData(p=>({...p,[id]:{...p[id],[key]:val}}));

  const finish=()=>{
    const perTask=(todayTasks||[])
      .map(t=>{
        const d=taskData[t.id]||{};
        const actualMins=parseInt(d.actual)||null;
        return {id:t.id,name:t.name,tag:t.tags?.[0]||'',estimated:t.duration||60,actual:actualMins,satisfaction:d.sat||null};
      })
      .filter(t=>t.actual||t.satisfaction); // only save rows user filled in
    onSave({load,exec,perTask});
    onClose();
  };

  return (
    <div className="mbk" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal" style={{maxWidth:380}}>
        <div className="mttl">
          {step===1?'Rate today':'How did each task go?'}
          <button onClick={onClose} style={{width:25,height:25,borderRadius:6,border:'none',background:'var(--s2)',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--t2)'}}><X size={12}/></button>
        </div>

        {step===1&&(
          <>
            {[[load,setLoad,LOAD_LBL,'How did today feel?'],[exec,setExec,EXEC_LBL,'How well did the schedule work?']].map(([val,set,lbls,q])=>(
              <div key={q} style={{marginBottom:20}}>
                <div style={{fontSize:12,color:'var(--t2)',marginBottom:10}}>{q}</div>
                <div style={{display:'flex',gap:8,justifyContent:'center'}}>
                  {[1,2,3,4,5].map(n=><button key={n} className={`sat-num${val===n?' on':''}`} onClick={()=>set(n)}>{n}</button>)}
                </div>
                {val>0&&<div style={{fontSize:11,color:'var(--t2)',textAlign:'center',marginTop:6}}>{lbls[val]}</div>}
              </div>
            ))}
            {(todayTasks||[]).length>0?(
              <button className="sub" style={{opacity:ready?1:.5,cursor:ready?'pointer':'default'}}
                onClick={()=>{if(ready) setStep(2);}}>
                Next: rate tasks →
              </button>
            ):(
              <button className="sub" style={{opacity:ready?1:.5,cursor:ready?'pointer':'default'}}
                onClick={()=>{if(ready) finish();}}>
                Save Rating
              </button>
            )}
            <button onClick={onClose} style={{width:'100%',marginTop:8,padding:'8px',border:'none',background:'transparent',color:'var(--t2)',cursor:'pointer',fontSize:12,fontFamily:'var(--fb)'}}>Skip</button>
          </>
        )}

        {step===2&&(
          <>
            <div style={{fontSize:11,color:'var(--t3)',marginBottom:14,lineHeight:1.5}}>
              Optional — fill in what you actually spent. The ML model uses this to calibrate future time estimates.
            </div>
            <div style={{maxHeight:360,overflowY:'auto',display:'flex',flexDirection:'column',gap:10}}>
              {(todayTasks||[]).map(t=>{
                const d=taskData[t.id]||{};
                const tc=tC(t.tags?.[0]||'');
                return (
                  <div key={t.id} style={{background:'var(--s2)',borderRadius:8,padding:11,border:'1px solid var(--bd)',borderLeft:`3px solid ${tc}`}}>
                    <div style={{fontSize:12,fontWeight:600,color:'var(--tx)',marginBottom:8,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t.name}</div>
                    <div style={{fontSize:10,color:tc,marginBottom:8,fontWeight:500}}>{t.tags?.[0]||''} · est. {t.duration}m</div>
                    {/* Satisfaction row */}
                    <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:7}}>
                      <span style={{fontSize:10,color:'var(--t3)',width:56,flexShrink:0}}>How was it?</span>
                      <div style={{display:'flex',gap:4}}>
                        {[1,2,3,4,5].map(n=>(
                          <button key={n} onClick={()=>setTD(t.id,'sat',n)}
                            style={{width:26,height:26,borderRadius:'50%',border:`1.5px solid ${d.sat===n?'var(--pr)':'var(--bd)'}`,
                              background:d.sat===n?'var(--prl)':'transparent',
                              color:d.sat===n?'var(--pr)':'var(--t3)',
                              fontSize:11,cursor:'pointer',fontFamily:'var(--fb)',fontWeight:700,
                              display:'flex',alignItems:'center',justifyContent:'center',transition:'all var(--t)'}}>
                            {n}
                          </button>
                        ))}
                      </div>
                      {d.sat>0&&<span style={{fontSize:10,color:'var(--t2)'}}>{SAT_LBL[d.sat]}</span>}
                    </div>
                    {/* Actual time row */}
                    <div style={{display:'flex',alignItems:'center',gap:6}}>
                      <span style={{fontSize:10,color:'var(--t3)',width:56,flexShrink:0}}>Actual time</span>
                      <input
                        type="number" min="1" max="600" step="5"
                        placeholder={`${t.duration} min`}
                        value={d.actual}
                        onChange={e=>setTD(t.id,'actual',e.target.value)}
                        style={{width:80,padding:'4px 8px',borderRadius:6,border:'1px solid var(--bd)',
                          background:'var(--sf)',color:'var(--tx)',fontSize:12,fontFamily:'var(--fb)',outline:'none'}}/>
                      <span style={{fontSize:10,color:'var(--t3)'}}>min</span>
                      {d.actual&&parseInt(d.actual)!==t.duration&&(
                        <span style={{fontSize:10,color:parseInt(d.actual)>t.duration?'var(--er)':'var(--ok)',fontWeight:600}}>
                          {parseInt(d.actual)>t.duration?`+${parseInt(d.actual)-t.duration}`:`-${t.duration-parseInt(d.actual)}`}m
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{display:'flex',gap:8,marginTop:14}}>
              <button className="pob" style={{flex:1}} onClick={()=>setStep(1)}>← Back</button>
              <button className="sub" style={{flex:2,margin:0}} onClick={finish}>Save All</button>
            </div>
            <button onClick={()=>finish()} style={{width:'100%',marginTop:8,padding:'8px',border:'none',background:'transparent',color:'var(--t3)',cursor:'pointer',fontSize:11,fontFamily:'var(--fb)'}}>Skip task details</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── ICS Modal ────────────────────────────────────────────────────────────────
function ICSModal({sched, core, wkDates, onClose}) {
  const allEvs=useMemo(()=>{
    const fx=[];
    wkDates.forEach(date=>{
      const dn=dN(date);
      core.filter(b=>b.days.includes(dn)&&!b.optOut).forEach(b=>{
        fx.push({id:b.id+dK(date),name:b.name,scheduledDate:dK(date),scheduledStart:b.startTime,scheduledEnd:b.endTime,notes:'',tag:b.tag,isFixed:true,isCoreBlock:true});
      });
    });
    const flex=sched.filter(t=>t.scheduledDate&&t.scheduledStart&&!t.isCompleted);
    return [...fx,...flex].sort((a,b)=>(a.scheduledDate||'').localeCompare(b.scheduledDate||'')||toM(a.scheduledStart)-toM(b.scheduledStart));
  },[sched,core,wkDates]);
  const [sel,setSel]=useState(()=>new Set(allEvs.map(e=>e.id)));
  const toggle=id=>setSel(p=>{const n=new Set(p);n.has(id)?n.delete(id):n.add(id);return n;});
  const doExport=()=>{
    const evs=allEvs.filter(e=>sel.has(e.id));
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([genICS(evs)],{type:'text/calendar'}));
    a.download='tideflow_week.ics'; a.click(); onClose();
  };
  return (
    <div className="mbk" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal" style={{maxWidth:420}}>
        <div className="mttl">Export to Calendar<button onClick={onClose} style={{width:25,height:25,borderRadius:6,border:'none',background:'var(--s2)',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--t2)'}}><X size={12}/></button></div>
        <div style={{display:'flex',gap:8,marginBottom:12}}>
          <button onClick={()=>setSel(new Set(allEvs.map(e=>e.id)))} className="pob" style={{flex:'none',padding:'5px 12px',fontSize:11}}>All</button>
          <button onClick={()=>setSel(new Set())} className="pob" style={{flex:'none',padding:'5px 12px',fontSize:11}}>None</button>
          <div style={{flex:1,fontSize:11,color:'var(--t3)',display:'flex',alignItems:'center',justifyContent:'flex-end'}}>{sel.size} selected</div>
        </div>
        <div style={{maxHeight:300,overflowY:'auto'}}>
          {allEvs.map(ev=>{
            const on=sel.has(ev.id);
            const tc=tC(ev.isCoreBlock?(ev.tag||''):(ev.tags?.[0]||''));
            return (
              <div key={ev.id} className="ics-item" onClick={()=>toggle(ev.id)}>
                <div className={`ics-chk${on?' on':''}`}>{on&&<Check size={10} color="#fff"/>}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{ev.name}</div>
                  <div style={{fontSize:10,color:'var(--t3)'}}>{ev.scheduledDate} · {fT(ev.scheduledStart)}–{fT(ev.scheduledEnd)}</div>
                </div>
                <div style={{width:7,height:7,borderRadius:'50%',background:tc,flexShrink:0}}/>
              </div>
            );
          })}
        </div>
        <button className="sub" onClick={doExport} style={{marginTop:14}}>Export {sel.size} events (.ics)</button>
      </div>
    </div>
  );
}

// ─── Add Modal ────────────────────────────────────────────────────────────────
// ─── Add Class Modal ──────────────────────────────────────────────────────────
// Creates core blocks from a multi-time-slot class definition.
// Each slot group becomes a separate CORE entry with a shared groupId.
function AddClassModal({onClose, onAddCore}) {
  const [className,setClassName]=useState('');
  const [tag,setTag]=useState('School/Class');
  const [slots,setSlots]=useState([{id:1,days:[],startTime:'12:00',endTime:'13:15'}]);

  const addSlot=()=>setSlots(p=>[...p,{id:Date.now(),days:[],startTime:'12:00',endTime:'13:15'}]);
  const removeSlot=id=>setSlots(p=>p.filter(s=>s.id!==id));
  const updSlot=(id,k,v)=>setSlots(p=>p.map(s=>s.id===id?{...s,[k]:v}:s));
  const togDay=(slotId,day)=>setSlots(p=>p.map(s=>{
    if(s.id!==slotId) return s;
    return{...s,days:s.days.includes(day)?s.days.filter(d=>d!==day):[...s.days,day]};
  }));

  const submit=()=>{
    if(!className.trim()) return;
    const filled=slots.filter(s=>s.days.length>0);
    if(!filled.length) return;
    const groupId='cls_'+Date.now();
    const entries=filled.map((s,i)=>({
      id:groupId+'_'+i,
      name:className.trim(),
      days:s.days,
      startTime:s.startTime,
      endTime:s.endTime,
      tag,
      groupId,
      optOut:false,
    }));
    onAddCore(entries);
    onClose();
  };

  return (
    <div className="mbk" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal" style={{maxHeight:'85vh',overflowY:'auto'}}>
        <div className="mttl">Add Class / Recurring Block
          <button onClick={onClose} style={{width:25,height:25,borderRadius:6,border:'none',background:'var(--s2)',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--t2)'}}><X size={12}/></button>
        </div>
        <div className="fg">
          <label className="fl">Class / Block name</label>
          <input className="finput" placeholder="e.g. Econ 101, Club Meeting…" value={className} onChange={e=>setClassName(e.target.value)} autoFocus/>
        </div>
        <div className="fg">
          <label className="fl">Tag</label>
          <select className="finput" value={tag} onChange={e=>setTag(e.target.value)}>
            {TAGS.map(t=><option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div style={{fontSize:11,fontWeight:700,color:'var(--t2)',textTransform:'uppercase',letterSpacing:.5,marginBottom:8,marginTop:4}}>Time Slot Groups</div>
        <div style={{fontSize:10,color:'var(--t3)',marginBottom:10,lineHeight:1.5}}>
          Add one group per unique time. Days sharing the same time go in one group; different times get their own group.<br/>
          <em>e.g. Wed+Fri 12:30–1:45 · Thu 1:00–2:15 → two groups.</em>
        </div>
        {slots.map((slot,idx)=>(
          <div key={slot.id} style={{background:'var(--s2)',borderRadius:8,padding:10,marginBottom:8,border:'1px solid var(--bd)'}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
              <span style={{fontSize:11,fontWeight:600,color:'var(--t2)'}}>Group {idx+1}</span>
              {slots.length>1&&(
                <button onClick={()=>removeSlot(slot.id)}
                  style={{padding:'2px 8px',borderRadius:5,border:'1px solid rgba(176,40,32,.3)',background:'rgba(176,40,32,.06)',color:'var(--er)',fontSize:10,cursor:'pointer',fontFamily:'var(--fb)'}}>✕ Remove</button>
              )}
            </div>
            <label className="fl" style={{marginBottom:5}}>Days</label>
            <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:9}}>
              {DAYS.map(d=>{const on=slot.days.includes(d);return(
                <button key={d} onClick={()=>togDay(slot.id,d)}
                  style={{padding:'4px 9px',borderRadius:99,border:`1.5px solid ${on?'var(--pr)':'var(--bd)'}`,
                    background:on?'var(--prl)':'transparent',color:on?'var(--pr)':'var(--t2)',
                    fontSize:11,cursor:'pointer',fontFamily:'var(--fb)',fontWeight:on?600:400,transition:'all var(--t)'}}>{d}</button>
              );})}
            </div>
            <div style={{display:'flex',gap:8}}>
              <div style={{flex:1}}><label className="fl">Start</label><input className="finput" type="time" value={slot.startTime} onChange={e=>updSlot(slot.id,'startTime',e.target.value)}/></div>
              <div style={{flex:1}}><label className="fl">End</label><input className="finput" type="time" value={slot.endTime} onChange={e=>updSlot(slot.id,'endTime',e.target.value)}/></div>
            </div>
          </div>
        ))}
        <button onClick={addSlot}
          style={{width:'100%',padding:'8px',borderRadius:'var(--r)',border:'1.5px dashed var(--bd)',background:'transparent',
            color:'var(--t2)',fontSize:12,cursor:'pointer',fontFamily:'var(--fb)',marginBottom:14,transition:'all var(--t)'}}>
          + Add Time Group
        </button>
        <div style={{fontSize:10,color:'var(--t3)',marginBottom:10,padding:'8px 10px',background:'var(--s2)',borderRadius:6,lineHeight:1.5}}>
          These blocks repeat <strong>every week</strong> automatically. Remove them anytime via Settings → Core Schedule.
        </div>
        <button className="sub" onClick={submit} style={{opacity:className.trim()&&slots.some(s=>s.days.length>0)?1:.5}}>
          Add to Core Schedule
        </button>
      </div>
    </div>
  );
}

// ─── Add Task Modal ───────────────────────────────────────────────────────────
function AddModal({onClose, onAdd, onAddMultiple}) {
  const [type,setType]=useState('flexible');
  const [name,setName]=useState('');
  const [dur,setDur]=useState(60);
  const [pri,setPri]=useState(3);
  const [tags,setTags]=useState([]);
  const [notes,setNotes]=useState('');
  const [pref,setPref]=useState('any');
  const [dl,setDl]=useState('');
  const [fday,setFday]=useState('');
  const [fst,setFst]=useState('09:00');
  const [fen,setFen]=useState('10:00');
  const [adv,setAdv]=useState(false);
  const [forceToday,setForceToday]=useState(false);
  const [trackable,setTrackable]=useState(true);
  // Recurrence
  const [recurrence,setRecurrence]=useState('none');
  const [recurrenceEnd,setRecurrenceEnd]=useState('');

  const tog=t=>setTags(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t]);

  const sub=()=>{
    if(!name.trim()) return;
    const today=new Date();
    let schedDate=null,schedSt=null,schedEn=null,pinned=false,isF=false;
    if(type==='fixed'){
      const tIdx=fday?DAYS.indexOf(fday):today.getDay();
      const s=new Date(today); s.setDate(today.getDate()-today.getDay()+tIdx); s.setHours(0,0,0,0);
      schedDate=dK(s); schedSt=fst; schedEn=fen; pinned=true; isF=true;
    }
    const baseId='t'+Date.now();
    const base={
      id:baseId,
      name:name.trim(),
      type:'flexible',
      duration:parseInt(dur)||60,
      priority:pri,
      tags,notes,
      preferredTime:pref,
      deadline:dl||null,
      target:(type==='flexible'&&forceToday)?'today':undefined,
      scheduledDate:schedDate,scheduledStart:schedSt,scheduledEnd:schedEn,
      isPinned:pinned,isFixed:isF,
      isCompleted:false,completedDate:null,
      createdAt:Date.now(),
      recurrenceGroupId:null,
      trackable,
    };

    // No recurrence → simple single add
    if(!recurrence||recurrence==='none'||!recurrenceEnd){
      onAdd(base); onClose(); return;
    }

    // Build recurring series
    base.recurrenceGroupId=baseId; // root points to itself
    const freq=recurrence==='biweekly'?2:1;
    const instances=[base];
    let weekOff=freq;
    const maxWeeks=52; // safety cap

    while(weekOff<=maxWeeks){
      if(schedDate){
        // Fixed-time: same day-of-week, same time, each Nth week
        const origin=new Date(schedDate+'T00:00:00');
        origin.setDate(origin.getDate()+weekOff*7);
        const nextDk=dK(origin);
        if(nextDk>recurrenceEnd) break;
        instances.push({
          ...base,
          id:'t'+(Date.now()+weekOff),
          scheduledDate:nextDk,
          isRecurrenceInstance:true,
          recurrenceGroupId:baseId,
          isCompleted:false,completedDate:null,
          createdAt:Date.now()+weekOff,
        });
      } else {
        // Flexible: one instance per target week, notBefore gates scheduler
        const anchor=new Date(today);
        anchor.setDate(today.getDate()-today.getDay()+weekOff*7);
        anchor.setHours(0,0,0,0);
        const notBefore=dK(anchor);
        if(notBefore>recurrenceEnd) break;
        instances.push({
          ...base,
          id:'t'+(Date.now()+weekOff),
          scheduledDate:null,scheduledStart:null,scheduledEnd:null,
          isPinned:false,
          notBefore,
          isRecurrenceInstance:true,
          recurrenceGroupId:baseId,
          isCompleted:false,completedDate:null,
          createdAt:Date.now()+weekOff,
        });
      }
      weekOff+=freq;
    }
    onAddMultiple(instances);
    onClose();
  };

  const isRecurring=recurrence&&recurrence!=='none';

  return (
    <div className="mbk" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="modal">
        <div className="mttl">Add Task<button onClick={onClose} style={{width:25,height:25,borderRadius:6,border:'none',background:'var(--s2)',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--t2)'}}><X size={12}/></button></div>
        <div className="fg"><div className="ttype">
          <button className={`ttb${type==='flexible'?' on':''}`} onClick={()=>setType('flexible')}>Flexible</button>
          <button className={`ttb${type==='fixed'?' on':''}`} onClick={()=>setType('fixed')}>Fixed / Pinned</button>
        </div></div>
        <div className="fg"><label className="fl">Task name</label><input className="finput" placeholder="What needs to get done?" value={name} onChange={e=>setName(e.target.value)} autoFocus/></div>
        <div className="frow">
          <div className="fg" style={{marginBottom:0}}><label className="fl">Duration (min)</label><input className="finput" type="number" min="15" max="480" step="15" value={dur} onChange={e=>setDur(e.target.value)}/></div>
          <div className="fg" style={{marginBottom:0}}><label className="fl">Priority</label><div className="pgrid">{[1,2,3,4,5].map(p=><button key={p} className={`pb${pri===p?' on':''}`} onClick={()=>setPri(p)}>{p}</button>)}</div></div>
        </div>
        {type==='fixed'&&<div className="fg" style={{marginTop:14}}>
          <label className="fl">Day & Time</label>
          <div className="frow" style={{marginBottom:7}}>
            <select className="finput" value={fday} onChange={e=>setFday(e.target.value)}>
              <option value="">Today</option>
              {DAYS.map(d=><option key={d} value={d}>{d}</option>)}
            </select>
            <div style={{display:'flex',gap:5,alignItems:'center'}}>
              <input className="finput" type="time" value={fst} onChange={e=>setFst(e.target.value)} style={{flex:1}}/>
              <span style={{color:'var(--t3)',fontSize:11}}>–</span>
              <input className="finput" type="time" value={fen} onChange={e=>setFen(e.target.value)} style={{flex:1}}/>
            </div>
          </div>
        </div>}

        {/* Tomorrow-by-Default override */}
        {type==='flexible'&&!isRecurring&&(
          <label className={`today-override${forceToday?' active':''}`}>
            <input type="checkbox" checked={forceToday}
              onChange={e=>setForceToday(e.target.checked)}/>
            <div style={{flex:1}}>
              <div style={{fontSize:12,fontWeight:600,color:forceToday?'var(--ac)':'var(--t2)'}}>Schedule for today</div>
              <div style={{fontSize:10,color:'var(--t3)',marginTop:1}}>Overrides the tomorrow-first rule</div>
            </div>
          </label>
        )}

        {/* ── Recurrence ───────────────────────────────────────────── */}
        <div style={{marginTop:12,padding:'10px 12px',borderRadius:'var(--r)',border:`1.5px solid ${isRecurring?'var(--pr)':'var(--bd)'}`,background:isRecurring?'var(--prl)':'transparent',transition:'all var(--t)'}}>
          <div style={{fontSize:11,fontWeight:700,color:isRecurring?'var(--pr)':'var(--t2)',marginBottom:7,textTransform:'uppercase',letterSpacing:.4}}>Recurrence</div>
          <div className="frow" style={{alignItems:'flex-start'}}>
            <div className="fg" style={{marginBottom:0,flex:1}}>
              <label className="fl">Frequency</label>
              <select className="finput" value={recurrence} onChange={e=>setRecurrence(e.target.value)}>
                <option value="none">Does not repeat</option>
                <option value="weekly">Every week</option>
                <option value="biweekly">Every 2 weeks</option>
              </select>
            </div>
            {isRecurring&&(
              <div className="fg" style={{marginBottom:0,flex:1}}>
                <label className="fl">Ends on</label>
                <input className="finput" type="date" value={recurrenceEnd} onChange={e=>setRecurrenceEnd(e.target.value)}/>
              </div>
            )}
          </div>
          {isRecurring&&type==='fixed'&&fday&&recurrenceEnd&&(
            <div style={{fontSize:10,color:'var(--pr)',marginTop:6,fontWeight:500}}>
              Repeats every {recurrence==='biweekly'?'2 weeks':'week'} on {fday} at {fst} · ends {recurrenceEnd}
            </div>
          )}
          {isRecurring&&type==='flexible'&&recurrenceEnd&&(
            <div style={{fontSize:10,color:'var(--pr)',marginTop:6,fontWeight:500}}>
              One flexible instance per {recurrence==='biweekly'?'2 weeks':'week'} · auto-scheduled · ends {recurrenceEnd}
            </div>
          )}
        </div>

        <div className="fg"><label className="fl">Tags</label><div className="tgs">{TAGS.map(t=>{const tc=tC(t);const on=tags.includes(t);return(<button key={t} className={`tg${on?' on':''}`} style={{'--tc':tc,'--tbg':`rgba(${hRgb(tc)},.14)`}} onClick={()=>tog(t)}>{t}</button>);})}</div></div>

        {/* Trackable toggle */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'9px 12px',borderRadius:8,background:'var(--s2)',border:'1px solid var(--bd)',marginBottom:12}}>
          <div>
            <div style={{fontSize:12,fontWeight:600,color:'var(--tx)'}}>Show done ✓ button</div>
            <div style={{fontSize:10,color:'var(--t3)',marginTop:1}}>{trackable?'Task can be marked complete':'No completion button — reference/ambient task'}</div>
          </div>
          <button className={`tog${trackable?' on':''}`} onClick={()=>setTrackable(v=>!v)}><div className="togk"/></button>
        </div>
        <button className="adv" onClick={()=>setAdv(!adv)}>
          <ChevronRight size={12} style={{transform:adv?'rotate(90deg)':'none',transition:'.18s'}}/>{adv?'Fewer':'More'} options
        </button>
        {adv&&<div style={{animation:'fadeIn .18s ease'}}>
          <div className="frow">
            <div className="fg" style={{marginBottom:0}}><label className="fl">Preferred Time</label><select className="finput" value={pref} onChange={e=>setPref(e.target.value)}><option value="any">Any time</option><option value="morning">Morning (9–12)</option><option value="afternoon">Afternoon (12–5)</option><option value="evening">Evening (5–11)</option></select></div>
            <div className="fg" style={{marginBottom:0}}><label className="fl">Deadline</label><input className="finput" type="date" value={dl} onChange={e=>setDl(e.target.value)}/></div>
          </div>
          <div className="fg" style={{marginTop:11}}><label className="fl">Notes</label><textarea className="finput" rows={2} placeholder="Context..." value={notes} onChange={e=>setNotes(e.target.value)} style={{resize:'none'}}/></div>
        </div>}
        <button className="sub" onClick={sub}>
          {isRecurring&&recurrenceEnd?`Add Recurring Series`:'Add to Schedule'}
        </button>
      </div>
    </div>
  );
}

// ─── Popover ──────────────────────────────────────────────────────────────────
function Popover({task, pos, onClose, onUpd, onDone, onDel, onSkip, onEditCore}) {
  const [name,setName]=useState(task.name), [notes,setNotes]=useState(task.notes||'');
  const [coreStartTime,setCoreStartTime]=useState(task.startTime||task.scheduledStart||'');
  const [coreEndTime,setCoreEndTime]=useState(task.endTime||task.scheduledEnd||'');
  const [editingCore,setEditingCore]=useState(false);
  const isF=task.isCoreBlock===true;                // true only for core schedule blocks
  const tc=tC(task.tags?.[0]||task.tag||''), tag=task.tags?.[0]||task.tag||'';
  const save=()=>onUpd({...task,name,notes});
  const saveCore=()=>{ if(onEditCore) onEditCore({id:task.id,name,startTime:coreStartTime,endTime:coreEndTime}); setEditingCore(false); onClose(); };
  const L=Math.max(8,Math.min(pos.x,window.innerWidth-320)), T=Math.max(8,Math.min(pos.y,window.innerHeight-380));
  return (
    <>
      <div style={{position:'fixed',inset:0,zIndex:499}} onClick={()=>{save();onClose();}}/>
      <div className="po" style={{left:L,top:T}}>
        <div className="poh"><input className="pon" value={name} onChange={e=>setName(e.target.value)} onBlur={save}/><button className="pox" onClick={()=>{save();onClose();}}><X size={11}/></button></div>
        <div className="pom">
          {tag&&<span className="poch" style={{background:`rgba(${hRgb(tc)},.14)`,color:tc}}>{tag}</span>}
          {task.scheduledStart&&<span className="poch" style={{background:'var(--s2)',color:'var(--t2)'}}>⏰ {fT(task.scheduledStart)}</span>}
          {task.priority&&<span className="poch" style={{background:`rgba(${hRgb(PCOLS[task.priority]||'#888')},.14)`,color:PCOLS[task.priority]}}>P{task.priority}</span>}
          {task.duration&&<span className="poch" style={{background:'var(--s2)',color:'var(--t2)'}}>{task.duration}m</span>}
          {task.isAutoInserted&&<span className="poch" style={{background:'rgba(54,128,112,.14)',color:'var(--ok)'}}>Auto</span>}
          {task.isPinned&&!isF&&<span className="poch" style={{background:'rgba(192,90,32,.14)',color:'var(--ac)'}}>📌 Pinned — time locked</span>}
        </div>
        <textarea className="pont" placeholder="Notes..." value={notes} onChange={e=>setNotes(e.target.value)} onBlur={save}/>
        {isF&&editingCore&&(
          <div className="core-edit">
            <div style={{fontSize:10,fontWeight:700,color:'var(--t2)',textTransform:'uppercase',letterSpacing:.6,marginBottom:6}}>Edit Series</div>
            <input className="finput" value={name} onChange={e=>setName(e.target.value)} style={{marginBottom:7,fontSize:12}}/>
            <div className="core-edit-row">
              <div><div style={{fontSize:10,color:'var(--t3)',marginBottom:3}}>Start</div><input className="finput" type="time" value={coreStartTime} onChange={e=>setCoreStartTime(e.target.value)} style={{fontSize:12}}/></div>
              <div><div style={{fontSize:10,color:'var(--t3)',marginBottom:3}}>End</div><input className="finput" type="time" value={coreEndTime} onChange={e=>setCoreEndTime(e.target.value)} style={{fontSize:12}}/></div>
            </div>
            <div style={{display:'flex',gap:6,marginTop:8}}>
              <button className="pob ok" style={{fontSize:11}} onClick={saveCore}><Check size={10}/>Save Series</button>
              <button className="pob" style={{fontSize:11}} onClick={()=>setEditingCore(false)}><X size={10}/>Cancel</button>
            </div>
          </div>
        )}
        {!isF&&<div className="poa">
          {task.trackable!==false&&(
            <button className="pob ok" onClick={()=>{onDone(task.id);onClose();}}><Check size={11}/>{task.isCompleted?'Undo':'Done'}</button>
          )}
          <button className="pob" onClick={()=>{onUpd({...task,name,notes,isPinned:!task.isPinned});onClose();}}
            style={{borderColor:task.isPinned?'var(--ac)':'var(--bd)',color:task.isPinned?'var(--ac)':'var(--t2)',background:task.isPinned?`rgba(${hRgb(tC('Gym'))},.1)`:'var(--s2)'}}
            title={task.isPinned?'Unfix — allow scheduler to move this':'Fix to this time slot'}>
            <Lock size={11}/>{task.isPinned?'Unfix':'Fix'}
          </button>
          <button className="pob er" onClick={()=>{onDel(task.id);onClose();}}><X size={11}/>Del</button>
        </div>}
        {!isF&&(
          <button className="pob" style={{width:'100%',marginTop:4,fontSize:11,color:task.trackable!==false?'var(--t2)':'var(--pr)',borderColor:task.trackable!==false?'var(--bd)':'var(--pr)'}}
            onClick={()=>onUpd({...task,name,notes,trackable:task.trackable===false?true:false})}>
            {task.trackable!==false?'✓ Tracking on — tap to hide done button':'○ No done button — tap to restore'}
          </button>
        )}
        {isF&&!editingCore&&(
          <div style={{marginTop:8,display:'flex',gap:6}}>
            <button className="pob" style={{fontSize:11}} onClick={()=>setEditingCore(true)}>✎ Edit Series</button>
          </div>
        )}
        {isF&&task.id&&onSkip&&!editingCore&&(
          <div style={{marginTop:6}}>
            <button className="pob" style={{width:'100%',color:'var(--ac)',borderColor:'var(--ac)'}} onClick={()=>{onSkip(task.id,task.scheduledDate||dK(new Date()));onClose();}}>
              Skip this week only
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Core Block Editor (used inside SettingsPanel) ────────────────────────────
function CoreBlockEditor({block, setCore, removeCoreBlock}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(block.name);
  const [startTime, setStartTime] = useState(block.startTime);
  const [endTime, setEndTime] = useState(block.endTime);
  const [days, setDays] = useState(block.days);
  const [trackable, setTrackable] = useState(block.trackable===true);

  const save = () => {
    setCore(p=>p.map(b=>b.id===block.id?{...b,name,startTime,endTime,days,trackable}:b));
    setOpen(false);
  };
  const cancel = () => {
    setName(block.name); setStartTime(block.startTime);
    setEndTime(block.endTime); setDays(block.days);
    setTrackable(block.trackable===true);
    setOpen(false);
  };
  const toggleDay = d => setDays(p=>p.includes(d)?p.filter(x=>x!==d):[...p,d]);

  return (
    <div style={{borderBottom:'1px solid var(--bd)',paddingBottom:8,marginBottom:8}}>
      <div className="srow" style={{cursor:'pointer'}} onClick={()=>setOpen(o=>!o)}>
        <div style={{flex:1,minWidth:0}}>
          <div className="slbl" style={{display:'flex',alignItems:'center',gap:5}}>
            {block.name}
            {block.groupId&&<span style={{fontSize:9,background:'var(--prl)',color:'var(--pr)',padding:'1px 5px',borderRadius:99,fontWeight:600}}>CLASS</span>}
          </div>
          <div className="ssub">{block.startTime}–{block.endTime} · {block.days.length>4?'Daily':block.days.join(', ')}</div>
        </div>
        <div style={{display:'flex',gap:5,flexShrink:0}}>
          <button style={{padding:'3px 8px',borderRadius:6,border:'1px solid var(--bd)',background:'transparent',
            color:'var(--t2)',fontSize:11,cursor:'pointer',fontFamily:'var(--fb)',display:'flex',alignItems:'center',gap:4}}
            onClick={e=>{e.stopPropagation();setOpen(o=>!o);}}>✎ Edit</button>
          {removeCoreBlock&&(
            <button style={{padding:'3px 8px',borderRadius:6,border:'1px solid rgba(176,40,32,.3)',background:'rgba(176,40,32,.06)',
              color:'var(--er)',fontSize:11,cursor:'pointer',fontFamily:'var(--fb)'}}
              onClick={e=>{e.stopPropagation();if(confirm(`Remove "${block.name}" from Core Schedule?`))removeCoreBlock(block.id);}}>✕</button>
          )}
        </div>
      </div>
      {open&&(
        <div style={{marginTop:8,padding:10,background:'var(--s2)',borderRadius:8,border:'1px solid var(--bd)',animation:'fadeIn .14s ease'}}>
          <div style={{fontSize:10,fontWeight:700,color:'var(--t2)',textTransform:'uppercase',letterSpacing:.6,marginBottom:7}}>Edit Block</div>
          <label className="fl">Name</label>
          <input className="finput" value={name} onChange={e=>setName(e.target.value)} style={{marginBottom:8,fontSize:12}}/>
          <div style={{display:'flex',gap:8,marginBottom:8}}>
            <div style={{flex:1}}><label className="fl">Start</label><input className="finput" type="time" value={startTime} onChange={e=>setStartTime(e.target.value)} style={{fontSize:12}}/></div>
            <div style={{flex:1}}><label className="fl">End</label><input className="finput" type="time" value={endTime} onChange={e=>setEndTime(e.target.value)} style={{fontSize:12}}/></div>
          </div>
          <label className="fl" style={{marginBottom:5,display:'block'}}>Active Days</label>
          <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:10}}>
            {DAYS.map(d=>{const on=days.includes(d);return(
              <button key={d} onClick={()=>toggleDay(d)}
                style={{padding:'3px 8px',borderRadius:99,border:`1.5px solid ${on?'var(--pr)':'var(--bd)'}`,
                  background:on?'var(--prl)':'transparent',color:on?'var(--pr)':'var(--t2)',
                  fontSize:11,cursor:'pointer',fontFamily:'var(--fb)',transition:'all var(--t)'}}>{d}</button>
            );})}
          </div>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 10px',borderRadius:7,background:'var(--sf)',border:'1px solid var(--bd)',marginBottom:10}}>
            <div>
              <div style={{fontSize:11,fontWeight:600,color:'var(--tx)'}}>Show done ✓ button</div>
              <div style={{fontSize:10,color:'var(--t3)',marginTop:1}}>{trackable?'Can be checked off each day':'Displayed as locked (no completion)'}</div>
            </div>
            <button className={`tog${trackable?' on':''}`} onClick={()=>setTrackable(v=>!v)}><div className="togk"/></button>
          </div>
          <div style={{display:'flex',gap:6}}>
            <button className="pob ok" style={{fontSize:11}} onClick={save}><Check size={10}/>Save</button>
            <button className="pob" style={{fontSize:11}} onClick={cancel}><X size={10}/>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
function SettingsPanel({onClose, theme, setTheme, core, setCore, tasks, satHistory, onOpenICS,
                        prefs, setPrefs, mlLog, burnoutMode, wkDates, sched,
                        onAddClass, removeCoreBlock,
                        burningOutSince, setBurningOutSince}) {
  const shab=core.find(b=>b.id==='shabbat');
  const shabTime=shab?`${fT(shab.startTime)}–${fT(shab.endTime)}`:'18:30–21:00';
  const insights=useMemo(()=>computeInsights(satHistory),[satHistory]);
  const mlInsights=useMemo(()=>computeMlInsights(mlLog),[mlLog]);
  const mlMults=useMemo(()=>computeMlMultipliers(mlLog),[mlLog]);

  // Helper: update a single preference key without touching others
  const setPref=(key,val)=>setPrefs(p=>({...p,[key]:val}));

  // ── simulateGaps sandbox state ────────────────────────────────────────────
  const [sgDur,setSgDur]=useState(60);
  const [sgSlots,setSgSlots]=useState(null);
  const findBestTime=()=>{
    const slots=simulateGaps(sgDur, sched, core, wkDates, prefs.gymDays, prefs.gymCutoff);
    setSgSlots(slots);
  };

  // ── AI group scheduling state ─────────────────────────────────────────────
  const [aiDur,setAiDur]=useState(60);
  const [aiLoading,setAiLoading]=useState(false);
  const [aiSlots,setAiSlots]=useState(null);
  const [aiError,setAiError]=useState('');

  const exp=()=>{
    const d={tasks,core,satHistory,prefs,exported:new Date().toISOString()};
    const a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([JSON.stringify(d,null,2)],{type:'application/json'}));
    a.download='tideflow_backup.json'; a.click();
  };

  const findGroupSlots=async()=>{
    setAiLoading(true); setAiSlots(null); setAiError('');
    try {
      const fixedSummary=wkDates.map(date=>{
        const dn=dN(date),dk2=dK(date);
        const fx=core.filter(b=>b.days.includes(dn)&&!b.optOut).map(b=>`${b.name} ${b.startTime}–${b.endTime}`);
        const tasks2=sched.filter(t=>t.scheduledDate===dk2&&t.scheduledStart).map(t=>`${t.name} ${t.scheduledStart}–${t.scheduledEnd||toS(toM(t.scheduledStart)+(t.duration||30))}`);
        return `${dn} ${dk2}: ${[...fx,...tasks2].join(', ')||'(free)'}`;
      }).join('\n');
      const res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          model:'claude-sonnet-4-20250514',max_tokens:600,
          system:'You are a scheduling assistant. Respond ONLY with a valid JSON array — no markdown, no explanation, no preamble.',
          messages:[{role:'user',content:`Find the best 3 time slots for a ${aiDur}-minute group meeting this week.\n\nRules:\n- Work hours: 09:00–21:00\n- Avoid Deep Work window: 17:30–19:30\n- Prefer morning 09:00–12:00 or early afternoon 13:00–17:00\n- Do NOT overlap any busy block listed below\n\nSchedule:\n${fixedSummary}\n\nReturn exactly this JSON shape:\n[{"day":"Mon","date":"YYYY-MM-DD","startTime":"HH:MM","endTime":"HH:MM","score":0.9,"reason":"brief"}]`}]
        })});
      if(!res.ok) throw new Error(`API ${res.status}`);
      const data=await res.json();
      if(data.error) throw new Error(data.error.message||'API error');
      const text=data.content?.map(c=>c.text||'').join('')||'';
      const clean=text.replace(/```json\n?/g,'').replace(/```/g,'').trim();
      let parsed=JSON.parse(clean);
      if(!Array.isArray(parsed)) throw new Error('Not an array');
      // Post-filter: remove slots that clash with actual fixed blocks
      parsed=parsed.filter(slot=>{
        const slotS=toM(slot.startTime),slotE=toM(slot.endTime);
        const date=wkDates.find(d=>dK(d)===slot.date);
        if(!date) return true;
        const dn=dN(date);
        return !core.filter(b=>b.days.includes(dn)&&!b.optOut).some(b=>slotS<toM(b.endTime)&&slotE>toM(b.startTime));
      }).slice(0,3);
      if(!parsed.length) throw new Error('No conflict-free slots found — try a different duration.');
      setAiSlots(parsed);
    } catch(e){setAiError(`Could not find slots: ${e.message||'Try again.'}`);}
    setAiLoading(false);
  };

  return (
    <div className="sdbk" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="sd">
        <div className="sdttl">Settings<button onClick={onClose} style={{width:24,height:24,borderRadius:5,border:'none',background:'var(--s2)',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--t2)'}}><X size={11}/></button></div>

        {/* Appearance */}
        <div className="ss">
          <div className="ssttl">Appearance</div>
          <div className="srow"><span className="slbl">Dark mode</span><button className={`tog${theme==='dk'?' on':''}`} onClick={()=>setTheme(t=>t==='dk'?'lt':'dk')}><div className="togk"/></button></div>
        </div>

        {/* Shabbat */}
        <div className="ss">
          <div className="ssttl">Shabbat</div>
          <div className="srow">
            <div><div className="slbl">Enabled this week</div><div className="ssub">{shabTime} · opt out per week</div></div>
            <button className={`tog${!shab?.optOut?' on':''}`} onClick={()=>setCore(p=>p.map(b=>b.id==='shabbat'?{...b,optOut:!b.optOut}:b))}><div className="togk"/></button>
          </div>
        </div>

        {/* Core Schedule */}
        <div className="ss">
          <div className="ssttl" style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
            <span>Core Schedule</span>
            <button onClick={onAddClass} style={{display:'flex',alignItems:'center',gap:4,padding:'4px 9px',borderRadius:6,
              border:'1.5px solid var(--pr)',background:'var(--prl)',color:'var(--pr)',fontSize:11,cursor:'pointer',
              fontFamily:'var(--fb)',fontWeight:600}}>
              + Add Class
            </button>
          </div>
          {core.map(b=>(
            <CoreBlockEditor key={b.id} block={b} setCore={setCore} removeCoreBlock={removeCoreBlock}/>
          ))}
          <div style={{fontSize:10,color:'var(--t3)',marginTop:5}}>Tap any block to edit. Classes added via "Add Class" support multiple day/time groups and appear as individual slots.</div>
        </div>

        {/* Gym Schedule — now wired to prefs */}
        <div className="ss">
          <div className="ssttl">Gym Schedule</div>
          <div className="srow">
            <div><div className="slbl">Cutoff time</div><div className="ssub">No tasks auto-scheduled after this on gym days</div></div>
            <select className="finput" style={{width:80,padding:'3px 6px',fontSize:12}} value={prefs.gymCutoff} onChange={e=>setPref('gymCutoff',e.target.value)}>
              {['19:30','20:00','20:30','21:00','21:30','22:00'].map(t=><option key={t} value={t}>{fT(t)}</option>)}
            </select>
          </div>
          <div style={{marginTop:8}}>
            <div className="ssub" style={{marginBottom:6}}>Gym days</div>
            <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
              {DAYS.map(d=>{const on=prefs.gymDays.includes(d);return(
                <button key={d}
                  onClick={()=>setPref('gymDays',on?prefs.gymDays.filter(x=>x!==d):[...prefs.gymDays,d])}
                  style={{padding:'3px 8px',borderRadius:99,border:`1.5px solid ${on?'var(--pr)':'var(--bd)'}`,background:on?'var(--prl)':'transparent',color:on?'var(--pr)':'var(--t2)',fontSize:11,cursor:'pointer',fontFamily:'var(--fb)',transition:'all var(--t)'}}>{d}</button>
              );})}
            </div>
          </div>
        </div>

        {/* Evening task limit — decoupled from burnout mode */}
        <div className="ss">
          <div className="ssttl">Evening Task Limit</div>
          <div style={{fontSize:11,color:'var(--t2)',marginBottom:8,lineHeight:1.5}}>Max flexible tasks allowed after 7:30 PM per day. Burnout protection may reduce this further.</div>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <input type="range" min={1} max={4} step={1} value={prefs.eveningLimit}
              className="eve-slider"
              onChange={e=>setPref('eveningLimit',Number(e.target.value))}/>
            <div style={{fontSize:14,fontFamily:'var(--fd)',fontWeight:700,color:'var(--pr)',minWidth:18,textAlign:'center'}}>
              {prefs.eveningLimit}
            </div>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:9,color:'var(--t3)',marginTop:3}}>
            <span>Strict (1)</span><span>Relaxed (4)</span>
          </div>
        </div>

        {/* Burnout mode indicator */}
        {burnoutMode&&(
          <div className="ss">
            <div className="ssttl" style={{color:'var(--ac)'}}>⚠ Burnout Protection Active</div>
            <div className="ins-item" style={{borderLeftColor:'var(--ac)'}}>Evening task limit reduced to 1 after 3× low load ratings. Rest up — the scheduler will ease off automatically.</div>
          </div>
        )}

        {/* ── Find Best Time (simulateGaps sandbox) ── */}
        <div className="ss">
          <div className="ssttl" style={{display:'flex',alignItems:'center',gap:5}}><Search size={11}/>Find Best Time</div>
          <div style={{fontSize:11,color:'var(--t2)',marginBottom:10,lineHeight:1.5}}>
            Find your largest open blocks without adding a task. Uses your live schedule — no mutations.
          </div>
          <div style={{display:'flex',gap:7,marginBottom:8}}>
            <select className="finput" value={sgDur} onChange={e=>setSgDur(Number(e.target.value))} style={{flex:1,fontSize:12}}>
              {[15,30,45,60,90,120,180].map(d=><option key={d} value={d}>{d} min</option>)}
            </select>
            <button className="sub" onClick={findBestTime} style={{flex:1,margin:0,padding:'8px 10px',fontSize:12}}>
              Scan Week
            </button>
          </div>
          {sgSlots&&sgSlots.length===0&&(
            <div style={{fontSize:11,color:'var(--t3)',fontStyle:'italic'}}>No open blocks found for {sgDur} min this week.</div>
          )}
          {sgSlots&&sgSlots.map((slot,i)=>(
            <div key={i} className="sg-slot">
              <div className="sg-rank">{i+1}</div>
              <div style={{flex:1}}>
                <div className="sg-time">{slot.day} · {fT(slot.startTime)}–{fT(slot.endTime)}</div>
                <div className="sg-why">{slot.reason}</div>
                <div style={{fontSize:9,color:'var(--t3)',marginTop:2}}>{slot.dateStr}</div>
              </div>
              <div style={{fontSize:10,color:'var(--ok)',fontWeight:700,flexShrink:0}}>{Math.round(slot.score*100)}%</div>
            </div>
          ))}
        </div>

        {/* ── AI Group Scheduling ── */}
        <div className="ss">
          <div className="ssttl" style={{display:'flex',alignItems:'center',gap:5}}><Users size={11}/>Group Scheduling (AI)</div>
          <div style={{fontSize:11,color:'var(--t2)',marginBottom:10,lineHeight:1.5}}>Find the best open slot for a group meeting based on your week's schedule using AI.</div>
          <div style={{display:'flex',gap:7,marginBottom:8}}>
            <select className="finput" value={aiDur} onChange={e=>setAiDur(Number(e.target.value))} style={{flex:1,fontSize:12}}>
              {[30,45,60,90,120].map(d=><option key={d} value={d}>{d} min</option>)}
            </select>
            <button className="sub" onClick={findGroupSlots} disabled={aiLoading} style={{flex:1,margin:0,padding:'8px 10px',fontSize:12,opacity:aiLoading?.65:1}}>
              {aiLoading?'Searching…':'Find Slots'}
            </button>
          </div>
          {aiError&&<div style={{fontSize:11,color:'var(--er)',marginBottom:6}}>{aiError}</div>}
          {aiSlots&&aiSlots.map((slot,i)=>(
            <div key={i} className="ai-slot">
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                <div className="ai-slot-rank">{i+1}</div>
                <div className="ai-slot-time">{slot.day} · {fT(slot.startTime)}–{fT(slot.endTime)}</div>
                {slot.score&&<div style={{marginLeft:'auto',fontSize:10,color:'var(--ok)',fontWeight:600}}>{Math.round(slot.score*100)}%</div>}
              </div>
              <div className="ai-slot-why">{slot.reason}</div>
            </div>
          ))}
        </div>

        {/* Insights */}
        <div className="ss">
          <div className="ssttl">What I've Learned</div>
          {insights.map((ins,i)=><div key={i} className="ins-item">{ins}</div>)}
          {mlInsights.length>0&&(
            <>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:.6,color:'var(--t3)',margin:'10px 0 6px'}}>Duration Accuracy by Tag</div>
              {Object.entries(mlMults).map(([tag,mult])=>{
                const pct=Math.round((mult-1)*100);
                const barW=Math.min(100,Math.abs(pct)*2+10);
                const color=pct>10?'var(--er)':pct<-10?'var(--ok)':'var(--pr)';
                return(
                  <div key={tag} className="ml-row">
                    <div style={{width:80,color:tC(tag),fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flexShrink:0,fontSize:10}}>{tag}</div>
                    <div className="ml-bar"><div className="ml-fill" style={{width:`${barW}%`,background:color}}/></div>
                    <div style={{fontSize:10,color,width:40,textAlign:'right',flexShrink:0,fontWeight:600}}>{pct>0?'+':''}{pct}%</div>
                  </div>
                );
              })}
              {mlInsights.map((ins,i)=><div key={i} className="ins-item" style={{borderLeftColor:'var(--ok)'}}>{ins}</div>)}
            </>
          )}
          <div style={{fontSize:10,color:'var(--t3)',marginTop:6}}>{satHistory.length} day rating{satHistory.length!==1?'s':''} recorded · {mlLog.length} task completion{mlLog.length!==1?'s':''} tracked.</div>
        </div>

        {/* Export */}
        <div className="ss">
          <div className="ssttl">Export</div>
          <button onClick={onOpenICS} className="pob" style={{width:'100%',marginBottom:7}}><Calendar size={11}/>Export to Calendar (.ics)</button>
          <button onClick={exp} className="pob" style={{width:'100%',marginBottom:7}}><Download size={11}/>Export Backup (.json)</button>
          <button onClick={()=>{if(confirm('Reset all tasks? Core schedule, ratings, and preferences are kept.')){window.location.reload();}}} className="pob er" style={{width:'100%'}}><X size={11}/>Reset Tasks</button>
        </div>

        {/* Burnout Toggle */}
        <div className="ss">
          <div className="ssttl">Wellbeing</div>
          <div className="srow" style={{alignItems:'flex-start',gap:10}}>
            <div style={{flex:1}}>
              <div className="slbl">Starting to feel burnt out</div>
              <div className="ssub">
                {burningOutSince
                  ? `Toggled on ${Math.floor((Date.now()-burningOutSince)/86400000)}d ago · ${(Date.now()-burningOutSince)/86400000>=2?'auto-escalated to full burnout':'escalates to full burnout in '+Math.max(1,Math.ceil(2-(Date.now()-burningOutSince)/86400000))+'d'}`
                  : 'Auto-escalates to burnt out if left on for 2 days'}
              </div>
            </div>
            <button
              onClick={()=>setBurningOutSince(burningOutSince?null:Date.now())}
              style={{padding:'5px 14px',borderRadius:99,border:'1.5px solid',
                borderColor:burningOutSince?'#7c3aed':'var(--bd)',
                background:burningOutSince?'rgba(139,92,246,.12)':'transparent',
                color:burningOutSince?'#7c3aed':'var(--t2)',
                fontSize:11,cursor:'pointer',fontFamily:'var(--fb)',fontWeight:600,
                flexShrink:0,transition:'all var(--t)'}}>
              {burningOutSince?'✓ On':'Off'}
            </button>
          </div>
          <div style={{fontSize:10,color:'var(--t3)',marginTop:6}}>
            When on, the ⚡ What To Do page surfaces recovery suggestions. Visit it to clear when you feel better.
          </div>
        </div>

        <div style={{fontSize:10,color:'var(--t3)',lineHeight:1.6,paddingTop:16,borderTop:'1px solid var(--bd)'}}>
          TideFlow v4 · Tomorrow-by-Default · Deadline Fence · Recurring Tasks · Spread Scheduling · Overdue Detection.
        </div>
      </div>
    </div>
  );
}

// ─── Print Page ───────────────────────────────────────────────────────────────
// ─── Side Quest Database ──────────────────────────────────────────────────────
// Dimensions (0–1): social=interaction level, energy=effort/activation,
//   creativity=inventiveness required, physical=movement involved,
//   restore=how restorative it is
// needsPlanning: true = "the real task is inviting people / organising"
//                false = "the real task is finding/doing the thing yourself"
const SIDE_QUESTS_DB = [
  // ── Social-organising quests (needsPlanning: true) ──────────────────────
  {id:'sq_friendbarbie',   name:'Go thrifting and play barbie with a friend',
   social:.9, energy:.55, creativity:.8, physical:.4, restore:.5, needsPlanning:true},
  {id:'sq_gamenight',      name:'Host a nowhere-to-wear game night',
   social:1.0,energy:.55, creativity:.7, physical:.1, restore:.6, needsPlanning:true},
  {id:'sq_friendingredient',name:'Have a friend pick 5 random ingredients — cook the meal',
   social:.8, energy:.6,  creativity:.9, physical:.3, restore:.5, needsPlanning:true},
  {id:'sq_midnightpoetry', name:'Midnight outdoor poetry session with a friend',
   social:.85,energy:.35, creativity:1.0,physical:.2, restore:.8, needsPlanning:true},
  {id:'sq_trytag',         name:'Try to get a game of tag going',
   social:1.0,energy:.75, creativity:.5, physical:.9, restore:.4, needsPlanning:true},

  // ── Discovery / solo-doing quests (needsPlanning: false) ────────────────
  {id:'sq_farmersmarket',  name:'Go to a farmers market',
   social:.5, energy:.4,  creativity:.3, physical:.4, restore:.65,needsPlanning:false},
  {id:'sq_mallcritique',   name:'Walk to the mall to critique clothing',
   social:.4, energy:.45, creativity:.75,physical:.5, restore:.5, needsPlanning:false},
  {id:'sq_boutique',       name:'Visit boutique jewellery or fashion stores — ask questions',
   social:.65,energy:.45, creativity:.6, physical:.3, restore:.5, needsPlanning:false},
  {id:'sq_sunrise',        name:'Walk somewhere at least a mile away to watch the sunrise',
   social:.1, energy:.5,  creativity:.4, physical:.7, restore:.85,needsPlanning:false},
  {id:'sq_geocaching',     name:'Go geocaching',
   social:.25,energy:.6,  creativity:.5, physical:.7, restore:.6, needsPlanning:false},
  {id:'sq_ricemask',       name:'Try a rice face mask (consult the internet first)',
   social:.1, energy:.2,  creativity:.5, physical:.1, restore:.8, needsPlanning:false},
  {id:'sq_pajamarun',      name:'Go on a late-night pyjama food run',
   social:.4, energy:.35, creativity:.3, physical:.4, restore:.7, needsPlanning:false},
  {id:'sq_clubmeeting',    name:'Go to a random club meeting',
   social:.8, energy:.5,  creativity:.4, physical:.2, restore:.4, needsPlanning:false},
  {id:'sq_playlist',       name:'Make a new music playlist',
   social:.0, energy:.25, creativity:.8, physical:.0, restore:.7, needsPlanning:false},
  {id:'sq_openmic',        name:'Do an open mic',
   social:.75,energy:.7,  creativity:.95,physical:.2, restore:.35,needsPlanning:false},
  {id:'sq_strangerinter',  name:'Go up to a stranger and "interview them for class" — get to know them',
   social:.9, energy:.65, creativity:.6, physical:.2, restore:.3, needsPlanning:false},
  {id:'sq_campusmap',      name:'Draw a campus map on paper and sketch your favourite spots',
   social:.1, energy:.4,  creativity:.9, physical:.5, restore:.7, needsPlanning:false},
  {id:'sq_whittle',        name:'Whittle something',
   social:.0, energy:.4,  creativity:.85,physical:.4, restore:.75,needsPlanning:false},
  {id:'sq_stretch',        name:'Do a 15-minute internet stretch routine',
   social:.0, energy:.25, creativity:.1, physical:.6, restore:.8, needsPlanning:false},
  {id:'sq_fleamarket',     name:'Visit a flea market',
   social:.45,energy:.45, creativity:.5, physical:.4, restore:.55,needsPlanning:false},
  {id:'sq_museum',         name:'Visit a museum',
   social:.3, energy:.45, creativity:.6, physical:.3, restore:.65,needsPlanning:false},
  {id:'sq_pastletter',     name:'Write a letter to your past self',
   social:.0, energy:.35, creativity:.85,physical:.0, restore:.8, needsPlanning:false},
  {id:'sq_coldshower',     name:'Take a cold shower',
   social:.0, energy:.3,  creativity:.0, physical:.4, restore:.7, needsPlanning:false},
  {id:'sq_workoutclass',   name:'Sign up for a workout class',
   social:.5, energy:.7,  creativity:.2, physical:.9, restore:.4, needsPlanning:false},
  {id:'sq_fancyunfancy',   name:'Wear fancy clothes to an unfancy place',
   social:.5, energy:.4,  creativity:.7, physical:.3, restore:.5, needsPlanning:false},
  {id:'sq_reversemeal',    name:'Reverse meal: dessert → dinner → apps',
   social:.4, energy:.4,  creativity:.65,physical:.2, restore:.6, needsPlanning:false},
  {id:'sq_peoplewatch',    name:'People-watch at a random café',
   social:.3, energy:.2,  creativity:.5, physical:.2, restore:.75,needsPlanning:false},
  {id:'sq_gymstranger',    name:'Ask to work in with a stranger at the gym all day',
   social:.85,energy:.8,  creativity:.35,physical:1.0,restore:.3, needsPlanning:false},
  {id:'sq_newtrail',       name:'Hike a new trail outdoors',
   social:.2, energy:.65, creativity:.3, physical:.9, restore:.8, needsPlanning:false},
  {id:'sq_10strangers',    name:'Ask 10 strangers the best decision they\'ve ever made',
   social:.95,energy:.6,  creativity:.6, physical:.3, restore:.4, needsPlanning:false},
  {id:'sq_studycafe',      name:'Study at a café',
   social:.25,energy:.5,  creativity:.4, physical:.2, restore:.5, needsPlanning:false},
  {id:'sq_campusevent',    name:'Go to an on-campus event',
   social:.7, energy:.5,  creativity:.3, physical:.2, restore:.45,needsPlanning:false},
  {id:'sq_volunteer',      name:'Sign up to volunteer',
   social:.7, energy:.5,  creativity:.3, physical:.4, restore:.5, needsPlanning:false},
  {id:'sq_gosomewherenew', name:'Go somewhere new',
   social:.3, energy:.5,  creativity:.4, physical:.4, restore:.6, needsPlanning:false},
  {id:'sq_freeevent',      name:'Attend a free event',
   social:.65,energy:.45, creativity:.3, physical:.2, restore:.5, needsPlanning:false},
];

// ─── Activity Database ────────────────────────────────────────────────────────
const ACTIVITIES = [
  // FREE TIME ── have space, have energy
  {id:'gym',      name:'Go to the Gym',           emoji:'🏋️', cat:'free',
   dur:[60,90],   minFree:60,
   s:{energy:.85,social:.1, creativity:.1, physical:.9, restore:.35},
   why:'Physical activity is one of the strongest predictors of your high-rated days.'},

  {id:'sidequest',name:'Side Quest',              emoji:'🗺️', cat:'free',
   dur:[180,360], minFree:180,
   s:{energy:.65,social:.4, creativity:.65,physical:.25,restore:.25},
   why:'You have a long open window — use it for something memorable.',
   isSideQuest:true},

  {id:'portfolio',name:'Portfolio Work',          emoji:'🎨', cat:'free',
   dur:[60,180],  minFree:60,
   s:{energy:.6, social:.0, creativity:.95,physical:.0, restore:.15},
   why:'Your active creative project. No deadline pressure, high signal output.'},

  {id:'mealprep', name:'Meal Prep',              emoji:'🍱', cat:'free',
   dur:[300,360], minFree:300,
   s:{energy:.45,social:.15,creativity:.4, physical:.3, restore:.3},
   why:'A long free window is the perfect setup for the whole week.'},

  {id:'grocery',  name:'Grocery Shop',           emoji:'🛒', cat:'free',
   dur:[60,120],  minFree:60,
   s:{energy:.3, social:.25,creativity:.0, physical:.3, restore:.1},
   why:'Gets you out of the house with minimal cognitive load.'},

  {id:'cook',     name:'Cook a Meal',            emoji:'👨‍🍳', cat:'free',
   dur:[90,120],  minFree:90,
   s:{energy:.4, social:.2, creativity:.5, physical:.2, restore:.3},
   why:'Creative and satisfying without being cognitively draining.'},

  // LIGHT RECOVERY ── starting to burn out
  {id:'sports',   name:'Watch a Game',           emoji:'🏀', cat:'light',
   dur:[120,180], minFree:90,
   s:{energy:.1, social:.25,creativity:.0, physical:.0, restore:.7},
   why:"Low effort, high engagement — your brain gets a genuine break.",
   hasGameInput:true},

  {id:'movie',    name:'Watch a Movie',          emoji:'🎬', cat:'light',
   dur:[90,150],  minFree:90,
   s:{energy:.1, social:.1, creativity:.15,physical:.0, restore:.75},
   why:'Full mental disengagement. Let the narrative do the work.'},

  {id:'teatime',  name:'Tea Time',              emoji:'🍵', cat:'light',
   dur:[30,45],   minFree:30,
   s:{energy:.0, social:.1, creativity:.1, physical:.0, restore:.8},
   why:'A slow, deliberate wind-down ritual. No output required.',
   nightOnly:true},

  // DEEP RECOVERY ── burnt out
  {id:'teatime_l',name:'Long Tea Time',         emoji:'🫖', cat:'deep',
   dur:[90,120],  minFree:60,
   s:{energy:.0, social:.0, creativity:.2, physical:.0, restore:1.0},
   why:'Extended stillness. No agenda, no output — just exist for a while.'},

  {id:'phone_brk',name:'Phone Break',           emoji:'📵', cat:'deep',
   dur:[30,120],  minFree:20, scaledByBurnout:true,
   s:{energy:.0, social:.0, creativity:.0, physical:.0, restore:.9},
   why:'Full disconnection. Duration scales with how deep in the burnout you are.'},

  {id:'poetry',   name:'Write Poetry',          emoji:'✍️', cat:'deep',
   dur:[20,90],   minFree:20, scaledByBurnout:true,
   s:{energy:.2, social:.0, creativity:1.0,physical:.0, restore:.7},
   why:'Low-stakes expression. No deadline, no audience, no structure needed.'},

  {id:'nap_out',  name:'Take a Nap Outside',    emoji:'🌿', cat:'deep',
   dur:[20,45],   minFree:20,
   s:{energy:.0, social:.0, creativity:.0, physical:.1, restore:1.0},
   why:'Complete reset. Only surfaces when both social and energy are truly depleted.',
   requiresBothBurnouts:true},

  // SOCIAL ── social drought
  {id:'friends',  name:'Make Plans with Friends',emoji:'👥', cat:'social',
   dur:[60,240],  minFree:0,
   s:{energy:.5, social:1.0,creativity:.3, physical:.2, restore:.5},
   why:"It's been a while. Group Scheduler opens so you can find a time that works.",
   action:'openGroupSched'},

  {id:'campus_ev',name:'Find an On-Campus Event',emoji:'🎭', cat:'social',
   dur:[60,180],  minFree:60,
   s:{energy:.4, social:.8, creativity:.3, physical:.2, restore:.4},
   why:'Getting out to something genuinely new can break a satisfaction plateau.'},
];

// ─── Tag → Dimension mapping ──────────────────────────────────────────────────
// School/Class intentionally has NO energy contribution. Classes are a fixed
// baseline — attending them doesn't represent unusual cognitive load. A true
// variation-from-baseline system (only flag energy when class hours exceed the
// rolling weekly average) requires timestamped mlLog entries; timestamps are now
// written below so this becomes possible in a future pass.
const TAG_DIMS = {
  'Deep Work':    {energy:.9,  creativity:.5},
  'Social':       {social:1.0},
  'Personal':     {restore:.5},
  'School/Class': {creativity:.2},        // no energy — baseline activity
  'Admin/Email':  {energy:.3},
  'Gym':          {physical:1.0, energy:.4},
  'Reset':        {restore:1.0},
  'Study':        {energy:.7,  creativity:.4},
  'Health':       {restore:.7, physical:.4}, // restorative: reduces energy burnout
  'Side Quest':   {creativity:.6, social:.4, energy:.5},
};

// ─── Suggestion State Computation ─────────────────────────────────────────────
function computeSuggestionState(sched, satHistory, burningOutSince) {
  // Recent satisfaction — last 14 calendar days, use (load+exec)/2 as the mood proxy
  const cutoff14=Date.now()-14*86400000;
  const recentSat=(satHistory||[]).filter(d=>d.date&&new Date(d.date).getTime()>=cutoff14);
  const avgSat=recentSat.length
    ? recentSat.reduce((s,d)=>{
        // load: 1=overwhelmed…5=underloaded; exec: 1=useless…5=nailed
        // Invert load so 5=great (underloaded = not stressed), then average with exec
        const loadScore = d.load  ? (6-d.load)/4*4+1 : 3;  // maps 1→5, 5→1 then re-scales to 1–5
        const execScore = d.exec  ? d.exec : 3;
        return s+(loadScore+execScore)/2;
      },0)/recentSat.length
    : 3;

  // Completed tasks — last 14 days only (not all history)
  const recentDone=(sched||[]).filter(t=>{
    if(!t.isCompleted||!t.completedDate) return false;
    return new Date(t.completedDate).getTime()>=cutoff14;
  });
  const totalDone=Math.max(recentDone.length,1);

  const tagCount = {};
  recentDone.forEach(t=>{(t.tags||[]).forEach(tag=>{tagCount[tag]=(tagCount[tag]||0)+1;});});

  // Aggregate dimension loads
  const dimLoad={energy:0,social:0,creativity:0,physical:0,restore:0};
  Object.entries(tagCount).forEach(([tag,count])=>{
    const m=TAG_DIMS[tag]||{};
    const freq=Math.min(count/totalDone,1);
    Object.entries(m).forEach(([d,w])=>{dimLoad[d]=Math.min((dimLoad[d]||0)+freq*w,1);});
  });

  // Satisfaction drop factor
  const satDrop=Math.max(0,(3-avgSat)/2.5);

  // Per-dimension burnout = high load × low satisfaction
  // Restoration (Health, Reset tags) directly offsets energy burnout.
  // The more restorative activities completed, the lower the energy burnout signal.
  const restoreLoad   = dimLoad.restore || 0;
  const rawEnergy     = Math.max(0, dimLoad.energy - restoreLoad * 0.5);
  const energyBurnout = Math.min(rawEnergy * (1 + satDrop * 1.5), 1);
  const socialBurnout = Math.min(dimLoad.social * (1 + satDrop * 1.5), 1);
  const creativityDeficit=Math.max(0,0.4-(dimLoad.creativity||0));

  // Social drought: no Social-tagged completions recently
  const socialDrought=!recentDone.some(t=>(t.tags||[]).includes('Social'))&&totalDone>=5;

  // Manual burnout toggle escalation
  let manualLevel='none';
  if(burningOutSince){
    const days=(Date.now()-burningOutSince)/86400000;
    manualLevel=days>=2?'full':'starting';
  }

  // Overall burnout level
  const overall=Math.max(energyBurnout*.7,socialBurnout*.5,satDrop*.6);
  let burnoutLevel='none';
  if(manualLevel==='full'||overall>.65||avgSat<2.2) burnoutLevel='full';
  else if(manualLevel==='starting'||overall>.35||avgSat<2.8) burnoutLevel='starting';

  return {energyBurnout,socialBurnout,creativityDeficit,socialDrought,
          avgSat,satDrop,tagCount,burnoutLevel,overall,manualLevel};
}

// ─── Activity Scoring ─────────────────────────────────────────────────────────
function scoreActivity(act,state,freeMinutes,hourOfDay){
  const {energyBurnout,socialBurnout,creativityDeficit,burnoutLevel,socialDrought}=state;
  if(act.nightOnly&&hourOfDay<19) return -1;
  if(act.requiresBothBurnouts&&!(energyBurnout>.55&&socialBurnout>.55)) return -1;
  if(act.minFree>0&&freeMinutes<act.minFree) return -1;

  const catIdeal=socialDrought?'social':{none:'free',starting:'light',full:'deep'}[burnoutLevel]||'free';
  let catScore=act.cat===catIdeal?1.0
    :burnoutLevel==='starting'&&act.cat==='free'?0.45
    :burnoutLevel==='starting'&&act.cat==='deep'?0.5
    :burnoutLevel==='full'   &&act.cat==='light'?0.6
    :act.cat==='social'&&socialDrought?0.9
    :0.15;

  const s=act.s;
  let fit=0;
  if(burnoutLevel!=='none'){
    fit+=(1-s.energy)*energyBurnout*.35;
    fit+=(1-s.social)*socialBurnout*.25;
    fit+=s.restore*.25;
  } else {
    fit+=s.energy*.15+s.creativity*.15+s.physical*.10;
  }
  if(creativityDeficit>.2) fit+=s.creativity*creativityDeficit*.2;
  return catScore*.55+fit;
}

// ─── Free Time Estimator ──────────────────────────────────────────────────────
function getTodayFreeMinutes(sched,core){
  const todayDk=dK(new Date()), todayDn=dN(new Date());
  const nowM=new Date().getHours()*60+new Date().getMinutes();
  const endM=22*60;
  const occupied=[];
  core.filter(b=>b.days.includes(todayDn)&&!b.optOut)
    .forEach(b=>occupied.push({s:toM(b.startTime),e:toM(b.endTime)}));
  sched.filter(t=>t.scheduledDate===todayDk&&t.scheduledStart)
    .forEach(t=>occupied.push({s:toM(t.scheduledStart),e:toM(t.scheduledStart)+(t.duration||30)}));
  occupied.sort((a,b)=>a.s-b.s);
  let gaps=[],cursor=Math.max(nowM,9*60);
  for(const b of occupied){if(b.s>cursor)gaps.push(b.s-cursor);cursor=Math.max(cursor,b.e);}
  if(endM>cursor)gaps.push(endM-cursor);
  return gaps.length?Math.max(...gaps):0;
}

// ─── StateBar ─────────────────────────────────────────────────────────────────
function StateBar({state,freeMin}){
  const {energyBurnout,socialBurnout,creativityDeficit,burnoutLevel,avgSat}=state;
  const dims=[
    {label:'Energy Reserve', val:1-energyBurnout, col:energyBurnout>.6?'var(--er)':energyBurnout>.3?'#d97706':'#22c55e'},
    {label:'Social Reserve', val:1-socialBurnout,  col:socialBurnout>.6?'var(--er)':socialBurnout>.3?'#d97706':'#22c55e'},
    {label:'Creativity Need',val:creativityDeficit,col:creativityDeficit>.3?'var(--pr)':'var(--t3)'},
    {label:'7-day avg mood', val:(avgSat-1)/4,     col:avgSat<2.5?'var(--er)':avgSat<3.5?'#d97706':'#22c55e'},
  ];
  return(
    <div className="sug-state">
      <div className="sug-state-label">Current State · {
        burnoutLevel==='full'?'🔴 Burnt out'
        :burnoutLevel==='starting'?'🟡 Starting to feel it'
        :'🟢 Doing well'
      }</div>
      <div className="sug-dim-grid">
        {dims.map(d=>(
          <div key={d.label} className="sug-dim">
            <div className="sug-dim-name">{d.label}</div>
            <div className="sug-dim-bar">
              <div className="sug-dim-fill" style={{width:`${Math.round(d.val*100)}%`,background:d.col}}/>
            </div>
          </div>
        ))}
      </div>
      <div className="sug-free">
        <span>Free time today</span>
        <span style={{fontWeight:600,color:'var(--t1)'}}>{freeMin>=60?`${Math.floor(freeMin/60)}h ${freeMin%60?freeMin%60+'m':''}`:freeMin+'m'}</span>
      </div>
    </div>
  );
}

// ─── ActivityCard ─────────────────────────────────────────────────────────────
function ActivityCard({act,state,freeMin,sqRoll,onRerollSQ,onDismiss,onAdd,onOpenGroupSched}){
  const [gameStart,setGameStart]=useState('');
  const [gameEnd,  setGameEnd]  =useState('');
  const [showGame, setShowGame] =useState(false);
  const hourOfDay=new Date().getHours();

  // Compute scaled duration for burnout activities
  let [dMin,dMax]=act.dur||[30,60];
  if(act.scaledByBurnout){
    const factor=Math.max(state.energyBurnout,state.socialBurnout,.2);
    dMax=Math.round(dMin+(dMax-dMin)*factor);
  }
  const durLabel=dMin===dMax?`${dMin} min`:`${dMin}–${dMax} min`;

  const catLabel={free:'Free Time',light:'Recovery',deep:'Deep Rest',social:'Social'}[act.cat]||act.cat;
  const catClass=act.cat;

  return(
    <div className="sug-card">
      <div className="sug-card-hd">
        <div className="sug-emoji">{act.emoji}</div>
        <div className="sug-card-info">
          <div className="sug-card-name">{act.name}</div>
          <div className="sug-card-dur">{durLabel}</div>
        </div>
        <span className={`sug-badge ${catClass}`}>{catLabel}</span>
      </div>

      {/* Side quest: show today's quest */}
      {act.isSideQuest&&sqRoll&&(
        <div className="sug-sq-name">
          🗺 Today's quest: <em>{sqRoll.name}</em>
        </div>
      )}

      {/* Sports: game time input */}
      {act.hasGameInput&&showGame&&(
        <div className="sug-time-row">
          <span style={{fontSize:11,color:'var(--t2)'}}>Game time:</span>
          <input type="time" value={gameStart} onChange={e=>setGameStart(e.target.value)} placeholder="Start"/>
          <span style={{color:'var(--t3)',fontSize:11}}>–</span>
          <input type="time" value={gameEnd} onChange={e=>setGameEnd(e.target.value)} placeholder="End"/>
        </div>
      )}

      <div className="sug-why">{act.why}</div>

      <div className="sug-actions">
        {act.action==='openGroupSched'?(
          <button className="sug-add" onClick={onOpenGroupSched}>Open Group Scheduler</button>
        ):act.hasGameInput?(
          showGame?(
            <button className="sug-add" onClick={()=>{
              if(gameStart&&gameEnd) onAdd(act,gameStart,gameEnd);
              else setShowGame(false);
            }}>{gameStart&&gameEnd?'Add to Today':'Set time first'}</button>
          ):(
            <button className="sug-add" onClick={()=>setShowGame(true)}>Set Game Time</button>
          )
        ):(
          <button className="sug-add" onClick={()=>onAdd(act,null,null,dMax)}>Add to Today</button>
        )}
        {(act.isSideQuest||act.hasGameInput)&&(
          <button className="sug-reroll" onClick={act.isSideQuest?onRerollSQ:()=>{setShowGame(false);setGameStart('');setGameEnd('');}}>
            {act.hasGameInput?'No game tonight':'Reroll quest'}
          </button>
        )}
        <button className="sug-dismiss" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

// ─── What To Do Page ──────────────────────────────────────────────────────────
function WhatToDoPage({sched,core,satHistory,burningOutSince,dismissedSuggestions,onDismiss,onAddTask,onOpenGroupSched,setBurningOutSince}){
  const todayDk=dK(new Date());
  const hourOfDay=new Date().getHours();

  const state=useMemo(()=>computeSuggestionState(sched,satHistory,burningOutSince),[sched,satHistory,burningOutSince]);
  const freeMin=useMemo(()=>getTodayFreeMinutes(sched,core),[sched,core]);

  // Dismissed today
  const dismissedToday=useMemo(()=>
    (dismissedSuggestions||[]).filter(d=>d.date===todayDk).map(d=>d.id)
  ,[dismissedSuggestions,todayDk]);

  // Side quest roller — picks best-fit quest by state, reroll cycles to next best
  const [sqOffset, setSqOffset] = useState(0);
  const rankedQuests = useMemo(()=>{
    if(!SIDE_QUESTS_DB.length) return [];
    // Score each quest against current state
    return [...SIDE_QUESTS_DB].sort((a,b)=>{
      const scoreQ = q => {
        let s = 0;
        // If socially burnt out, prefer low-social quests
        if(state.socialBurnout > .5) s += (1 - q.social) * state.socialBurnout * .4;
        else s += q.social * (1 - state.socialBurnout) * .2;
        // Energy match
        if(state.energyBurnout > .5) s += (1 - q.energy) * state.energyBurnout * .3;
        else s += q.energy * (1 - state.energyBurnout) * .2;
        // Creativity deficit
        if(state.creativityDeficit > .2) s += q.creativity * state.creativityDeficit * .25;
        // needsPlanning bonus when social score is low (you want solo discovery)
        if(state.socialBurnout > .5 && !q.needsPlanning) s += .1;
        return s;
      };
      return scoreQ(b) - scoreQ(a);
    });
  },[state]);
  const sqRoll = rankedQuests.length > 0 ? rankedQuests[sqOffset % rankedQuests.length] : null;
  const rerollSQ = () => setSqOffset(o => o + 1);

  // Scored + filtered activities
  const scored=useMemo(()=>
    ACTIVITIES
      .filter(a=>!dismissedToday.includes(a.id))
      .map(a=>({...a,score:scoreActivity(a,state,freeMin,hourOfDay)}))
      .filter(a=>a.score>0)
      .sort((a,b)=>b.score-a.score)
      .slice(0,5)
  ,[state,freeMin,hourOfDay,dismissedToday]);

  // Past-7-days "do again" suggestions
  const recentSuggestions = useMemo(()=>getRecentTaskSuggestions(sched),[sched]);
  const [dismissedRecent, setDismissedRecent] = useState([]);
  const visibleRecent = recentSuggestions.filter(r=>!dismissedRecent.includes(r.name+'|'+(r.tag||'')));

  // Sat callout: social activities correlated with good days?
  const socialSatNote=useMemo(()=>{
    const socialDays=(satHistory||[]).filter(d=>d.socialCount>0);
    if(socialDays.length<3) return null;
    const avg=socialDays.reduce((s,d)=>s+(d.rating||3),0)/socialDays.length;
    if(avg>=3.8) return `On your last ${socialDays.length} social days, you averaged ${avg.toFixed(1)}/5 satisfaction.`;
    return null;
  },[satHistory]);

  const handleAdd=(act,gameStart,gameEnd,dur)=>{
    const today=new Date(); today.setHours(0,0,0,0);
    const sT=gameStart||null, eT=gameEnd||null;
    const d=eT&&sT?toM(eT)-toM(sT):dur||act.dur[1];
    onAddTask({
      id:'t'+Date.now(), name:act.name, type:'flexible', duration:d,
      priority:3, tags:[act.cat==='social'?'Social':act.cat==='free'?'Errands':'Rest'],
      notes:'', preferredTime:'any', deadline:null, target:'today',
      scheduledDate:dK(today),
      scheduledStart:sT, scheduledEnd:eT,
      isPinned:!!(sT&&eT), isFixed:false,
      isCompleted:false, completedDate:null, createdAt:Date.now(),
    });
    onDismiss(act.id);
  };

  return(
    <div className="sug-pg">
      <div className="sug-hdr">
        <div className="sug-title">What to Do?</div>
        <div className="sug-sub">Based on your recent activity patterns and schedule</div>
      </div>

      {/* Manual burnout toggle status */}
      {burningOutSince&&(
        <div className="sug-burnout-strip">
          <span>
            {state.manualLevel==='full'?'🔴 Burnt out mode active (2+ days)':'🟡 "Starting to feel it" — auto-escalates to burnt out in '+
              Math.max(0,Math.ceil(2-(Date.now()-burningOutSince)/86400000))+' day(s)'}
          </span>
          <button onClick={()=>setBurningOutSince(null)}
            style={{padding:'3px 10px',borderRadius:99,border:'1px solid var(--bd)',background:'var(--sf)',
              color:'var(--t2)',fontSize:11,cursor:'pointer',fontFamily:'var(--fb)'}}>
            I'm better now
          </button>
        </div>
      )}

      {/* Social-sat callout */}
      {state.socialDrought&&socialSatNote&&(
        <div className="sug-sat-callout">💡 {socialSatNote}</div>
      )}

      <StateBar state={state} freeMin={freeMin}/>

      {scored.length===0?(
        <div className="sug-empty">
          <div className="sug-empty-icon">✨</div>
          <div style={{fontWeight:600,fontSize:14,color:'var(--t1)',marginBottom:5}}>All caught up</div>
          <div style={{fontSize:12}}>No suggestions right now — you're in a good spot.</div>
        </div>
      ):scored.map(act=>(
        <ActivityCard
          key={act.id}
          act={act}
          state={state}
          freeMin={freeMin}
          sqRoll={sqRoll}
          onRerollSQ={rerollSQ}
          onDismiss={()=>onDismiss(act.id)}
          onAdd={handleAdd}
          onOpenGroupSched={onOpenGroupSched}
        />
      ))}

      {/* ── Past 7 days: "Do again?" suggestions ── */}
      {visibleRecent.length>0&&(
        <>
          <div className="sug-section-label">
            <Clock size={11}/>From your week
          </div>
          {visibleRecent.map(r=>{
            const key=r.name+'|'+(r.tag||'');
            const tc=tC(r.tag||'');
            const isAcademic=ACADEMIC_TAGS.has(r.tag);
            const daysSince=Math.round((Date.now()-new Date(r.lastDate).getTime())/86400000);
            return (
              <div key={key} className="sug-card" style={{borderLeft:`3px solid ${tc}`}}>
                <div className="sug-card-hd">
                  <div className="sug-emoji" style={{fontSize:17,marginTop:3}}>🔁</div>
                  <div className="sug-card-info">
                    <div className="sug-card-name">{r.name}</div>
                    <div className="sug-card-dur">{r.duration} min · {r.count>1?`done ${r.count}× this week`:`${daysSince===0?'today':daysSince===1?'yesterday':`${daysSince}d ago`}`}</div>
                  </div>
                  <div style={{display:'flex',flexDirection:'column',gap:3,alignItems:'flex-end'}}>
                    {isAcademic&&<span className="sug-badge academic">Academic</span>}
                    {r.tag&&<span className="sug-badge recent" style={{background:`rgba(${hRgb(tc)},.1)`,color:tc}}>{r.tag}</span>}
                  </div>
                </div>
                <div className="sug-actions">
                  <button className="sug-add" onClick={()=>{
                    const today=new Date(); today.setHours(0,0,0,0);
                    onAddTask({id:'t'+Date.now(),name:r.name,type:'flexible',duration:r.duration,
                      priority:3,tags:r.tags,notes:'',preferredTime:'any',deadline:null,target:'today',
                      scheduledDate:dK(today),scheduledStart:null,scheduledEnd:null,
                      isPinned:false,isFixed:false,isCompleted:false,completedDate:null,createdAt:Date.now(),trackable:true});
                    setDismissedRecent(p=>[...p,key]);
                  }}>Add to Today</button>
                  <button className="sug-dismiss" onClick={()=>setDismissedRecent(p=>[...p,key])}>Dismiss</button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ─── Print Preview Modal ──────────────────────────────────────────────────────
// Renders inline as a full-screen overlay so window.print() works inside iframes.
// @media print hides .app and shows only this overlay.
function PrintPreviewModal({onClose, sched, core}) {
  return (
    <>
      {/* This div is position:fixed normally but becomes the only visible element during print */}
      <div className="print-preview-overlay"
        style={{position:'fixed',inset:0,zIndex:2000,background:'rgba(0,0,0,.55)',overflowY:'auto',display:'flex',justifyContent:'center',padding:'32px 16px'}}>

        {/* Toolbar — hidden during actual print */}
        <div className="print-preview-no-print"
          style={{position:'fixed',top:0,left:0,right:0,zIndex:2001,background:'#111',color:'#fff',
            display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 20px',gap:12}}>
          <span style={{fontSize:13,fontWeight:600,letterSpacing:.3}}>🖨 Print Preview — Tomorrow's Schedule</span>
          <div style={{display:'flex',gap:10}}>
            <button onClick={()=>window.print()}
              style={{padding:'7px 18px',borderRadius:6,border:'none',background:'#fff',color:'#111',
                fontSize:13,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>
              Print / Save PDF
            </button>
            <button onClick={onClose}
              style={{padding:'7px 14px',borderRadius:6,border:'1px solid rgba(255,255,255,.3)',background:'transparent',
                color:'#fff',fontSize:13,cursor:'pointer',fontFamily:'inherit'}}>
              Close
            </button>
          </div>
        </div>

        {/* The actual printable sheet */}
        <div style={{marginTop:52,maxWidth:720,width:'100%',background:'#fff',borderRadius:4,overflow:'hidden',boxShadow:'0 8px 40px rgba(0,0,0,.4)'}}>
          <PrintPage sched={sched} core={core} forceShow/>
        </div>
      </div>
    </>
  );
}

// ─── Print Page (content) ─────────────────────────────────────────────────────
function PrintPage({sched, core, forceShow=false}) {
  const tomorrow=new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  const tk=dK(tomorrow), dn=dN(tomorrow);
  const dateStr=tomorrow.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  const fx=core.filter(b=>b.days.includes(dn)&&!b.optOut&&toM(b.endTime)>GS*60)
    .map(b=>({...b,isFixed:true,isCoreBlock:true,scheduledStart:b.startTime,scheduledEnd:b.endTime,tags:[b.tag]}));
  const flexTasks=sched.filter(t=>t.scheduledDate===tk&&!t.isCompleted);
  const all=[...fx,...flexTasks].sort((a,b)=>toM(a.scheduledStart||a.startTime)-toM(b.scheduledStart||b.startTime));
  const totalH=(all.reduce((a,e)=>a+(toM(e.scheduledEnd||e.endTime)-toM(e.scheduledStart||e.startTime)),0)/60).toFixed(1);
  const isSat=dn==='Sat';
  const unsch=sched.filter(t=>t.type==='flexible'&&!t.scheduledDate&&!t.isCompleted);
  return (
    <div className="print-pg" style={{padding:'32px 40px',fontFamily:'Georgia,serif',color:'#111',background:'#fff',maxWidth:680,display:forceShow?'block':undefined}}>
      <div style={{borderBottom:'2px solid #111',paddingBottom:12,marginBottom:20}}>
        <div style={{fontSize:26,fontWeight:700}}>{dateStr}</div>
        <div style={{fontSize:13,marginTop:3,color:'#555'}}>TideFlow · Tomorrow's Schedule · {totalH}h scheduled</div>
        {isSat&&<div style={{marginTop:8,fontSize:12,borderLeft:'3px solid #111',paddingLeft:10,color:'#333'}}>Saturday — high-capacity day. Lock in, reset, optional second block.</div>}
      </div>
      {isSat&&(
        <div style={{marginBottom:24,padding:'16px 18px',border:'2px solid #111',borderRadius:4,background:'#f9f7f2'}}>
          <div style={{fontSize:13,fontWeight:700,marginBottom:12,textTransform:'uppercase',letterSpacing:.5}}>Saturday Energy Architecture</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            {[
              ['🌅','Morning Block','9 – 11am','Highest cognitive capacity. Lock in your deepest work. No email, no context-switching.'],
              ['☀️','Light Transition','11am – 1pm','Admin, inbox, errands. Declutter mental tabs before the afternoon.'],
              ['🌤','Afternoon Option','1 – 4pm','Optional second deep work block OR social recharge. Decide at 12:45.'],
              ['🌙','Evening Unstructure','4pm+','No scheduling. Rest, movement, connections. Let the brain consolidate.'],
            ].map(([em,title,time,desc])=>(
              <div key={title} style={{padding:'10px 12px',background:'#fff',borderRadius:3,border:'1px solid #ddd'}}>
                <div style={{fontSize:18,marginBottom:4}}>{em}</div>
                <div style={{fontSize:12,fontWeight:700}}>{title}</div>
                <div style={{fontSize:11,color:'#888',marginBottom:4}}>{time}</div>
                <div style={{fontSize:11,color:'#555',lineHeight:1.4}}>{desc}</div>
              </div>
            ))}
          </div>
          {all.filter(e=>DW_TAGS.includes(e.tags?.[0]||e.tag||'')).length>0&&(
            <div style={{marginTop:10,fontSize:12,color:'#333'}}>
              <strong>Deep work candidate:</strong> {all.filter(e=>DW_TAGS.includes(e.tags?.[0]||e.tag||''))[0]?.name}
            </div>
          )}
          <div style={{marginTop:8,fontSize:11,color:'#777',fontStyle:'italic'}}>Saturday is your highest-leverage day — protect the morning block above everything.</div>
        </div>
      )}
      {all.map((ev,i)=>{
        const tag=ev.tags?.[0]||ev.tag||'';
        const dur=toM(ev.scheduledEnd||ev.endTime)-toM(ev.scheduledStart||ev.startTime);
        return (
          <div key={i} style={{display:'flex',gap:16,marginBottom:12,paddingBottom:12,borderBottom:'1px solid #ddd'}}>
            <div style={{width:72,flexShrink:0,fontSize:13,fontWeight:700}}>{fT(ev.scheduledStart||ev.startTime)}</div>
            <div>
              <div style={{fontSize:14,fontWeight:700}}>{ev.name}</div>
              <div style={{fontSize:11,color:'#777',marginTop:2}}>[{tag}] · {dur}min{ev.isCoreBlock?' · Core block':ev.isPinned?' · Pinned':''}</div>
              {ev.notes&&<div style={{fontSize:11,color:'#555',marginTop:2,fontStyle:'italic'}}>{ev.notes}</div>}
            </div>
          </div>
        );
      })}
      <div style={{marginTop:28,padding:'14px 18px',border:'2px solid #111',borderRadius:4}}>
        <div style={{fontSize:12,fontWeight:700,marginBottom:8,textTransform:'uppercase',letterSpacing:.5}}>Pre-commit — 2 tasks for tomorrow's work block</div>
        <div style={{fontSize:13,marginBottom:10,lineHeight:2}}>1. _______________________________________________</div>
        <div style={{fontSize:13,lineHeight:2}}>2. _______________________________________________</div>
      </div>
      {unsch.length>0&&<div style={{marginTop:18}}>
        <div style={{fontSize:11,fontWeight:700,marginBottom:6,textTransform:'uppercase',letterSpacing:.8}}>Also on your radar</div>
        {unsch.map(t=><div key={t.id} style={{fontSize:12,color:'#666',marginBottom:4}}>· {t.name} ({t.duration}min, P{t.priority})</div>)}
      </div>}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [tasks,      setTasks]      = useState(DEMO);
  const [core,       setCore]       = useState(CORE0);
  const [theme,      setTheme]      = useState('lt');
  // Unified prefs object — replaces individual gymDays/gymCutoff states
  const [prefs,      setPrefs]      = useState(DEFAULT_PREFS);
  const [view,       setView]       = useState('today');
  const [wkOff,      setWkOff]      = useState(0);
  const [selDate,    setSelDate]    = useState(new Date());
  const [addOpen,    setAddOpen]    = useState(false);
  const [selTask,    setSelTask]    = useState(null);
  const [selPos,     setSelPos]     = useState({x:300,y:200});
  const [setOpen,    setSetOpen]    = useState(false);
  const [satOpen,    setSatOpen]    = useState(false);
  const [icsOpen,    setIcsOpen]    = useState(false);
  const [satHistory, setSatHistory] = useState([]);
  const [skipped,    setSkipped]    = useState({});
  const [completedCoreInstances, setCompletedCoreInstances] = useState({});
  const [loaded,     setLoaded]     = useState(false);
  const [mlLog,      setMlLog]      = useState([]);
  const [dismissedSuggestions, setDismissedSuggestions] = useState([]);
  const [burningOutSince,      setBurningOutSince]      = useState(null);
  const schedRef=useRef([]);

  // ── Persist / load from storage ───────────────────────────────────────────
  useEffect(()=>{
       window.storage = {
      set: (key, value) => Promise.resolve(localStorage.setItem(key, value)),
      get: (key) => { const v = localStorage.getItem(key); return Promise.resolve(v !== null ? {value: v} : null); }
    };
    async function load(){
      try{
        const tr=await window.storage.get('tf2_tasks');   if(tr) setTasks(JSON.parse(tr.value));
        const cr=await window.storage.get('tf2_core');    if(cr) setCore(JSON.parse(cr.value));
        const thr=await window.storage.get('tf2_theme');  if(thr) setTheme(thr.value);
        const sr=await window.storage.get('tf2_sat');     if(sr) setSatHistory(JSON.parse(sr.value));
        const mr=await window.storage.get('tf2_mllog');   if(mr) setMlLog(JSON.parse(mr.value).slice(-500));
        const dr=await window.storage.get('tf2_dismissed'); if(dr) setDismissedSuggestions(JSON.parse(dr.value));
        const br=await window.storage.get('tf2_burnout');   if(br){ const v=JSON.parse(br.value); if(v) setBurningOutSince(v); }
        const ccr=await window.storage.get('tf2_core_done'); if(ccr) setCompletedCoreInstances(JSON.parse(ccr.value));
        const sk=await window.storage.get('tf2_skipped');   if(sk) setSkipped(JSON.parse(sk.value));
        // Prefs: try new unified key first, fall back to legacy tf2_gym for migration
        const pr=await window.storage.get('tf2_prefs');
        if(pr){ setPrefs(JSON.parse(pr.value)); }
        else {
          const gr=await window.storage.get('tf2_gym');
          if(gr){ const g=JSON.parse(gr.value); setPrefs(p=>({...p,gymDays:g.days,gymCutoff:g.cutoff})); }
        }
      }catch(e){ console.error('[TideFlow] Failed to load saved data:', e); }
      setLoaded(true);
    }
    load();
  },[]);

  useEffect(()=>{ if(!loaded) return; window.storage.set('tf2_tasks', JSON.stringify(tasks)).catch(()=>{}); },[tasks,loaded]);
  useEffect(()=>{ if(!loaded) return; window.storage.set('tf2_core',  JSON.stringify(core)).catch(()=>{}); },[core,loaded]);
  useEffect(()=>{ if(!loaded) return; window.storage.set('tf2_theme', theme).catch(()=>{}); },[theme,loaded]);
  useEffect(()=>{ if(!loaded) return; window.storage.set('tf2_sat',   JSON.stringify(satHistory)).catch(()=>{}); },[satHistory,loaded]);
  useEffect(()=>{ if(!loaded) return; window.storage.set('tf2_mllog', JSON.stringify(mlLog)).catch(()=>{}); },[mlLog,loaded]);
  useEffect(()=>{ if(!loaded) return; window.storage.set('tf2_prefs', JSON.stringify(prefs)).catch(()=>{}); },[prefs,loaded]);
  useEffect(()=>{ if(!loaded) return; window.storage.set('tf2_dismissed', JSON.stringify(dismissedSuggestions)).catch(()=>{}); },[dismissedSuggestions,loaded]);
  useEffect(()=>{ if(!loaded) return; window.storage.set('tf2_burnout', JSON.stringify(burningOutSince)).catch(()=>{}); },[burningOutSince,loaded]);
  useEffect(()=>{ if(!loaded) return; window.storage.set('tf2_core_done', JSON.stringify(completedCoreInstances)).catch(()=>{}); },[completedCoreInstances,loaded]);
  useEffect(()=>{ if(!loaded) return; window.storage.set('tf2_skipped',   JSON.stringify(skipped)).catch(()=>{}); },[skipped,loaded]);

  // ── Burnout detection: last 3 days all load ≤ 2 ──────────────────────────
  const burnoutMode=useMemo(()=>{
    const recent=satHistory.slice(-3);
    return recent.length>=3&&recent.every(r=>r.load<=2);
  },[satHistory]);
  const burnoutEveLimit=burnoutMode?1:prefs.eveningLimit;

  // Feature 14: ML multipliers
  const mlMultipliers=useMemo(()=>computeMlMultipliers(mlLog),[mlLog]);

  const wkDates=useMemo(()=>getWk(wkOff),[wkOff]);

  // ── Run scheduler ─────────────────────────────────────────────────────────
  const sched=useMemo(()=>{
    const c=tasks.map(t=>({...t}));
    const activeCore=core.map(b=>({
      ...b,
      days:b.days.filter((_,dayIdx)=>{
        const date=wkDates.find(d=>dN(d)===b.days[dayIdx]);
        return !date||!skipped[`${b.id}|${dK(date)}`];
      })
    }));
    const r=runSched(c, activeCore, wkDates, prefs, burnoutEveLimit, mlMultipliers);
    schedRef.current=r; return r;
  },[tasks,core,wkDates,prefs,burnoutEveLimit,mlMultipliers,skipped]);

  // ── Print: inline preview modal — window.open is blocked in iframe sandboxes ──
  const [printOpen, setPrintOpen] = useState(false);
  const handlePrint = useCallback(() => setPrintOpen(true), []);

  // ── Task actions ──────────────────────────────────────────────────────────
  const addTask  = t  => setTasks(p=>[...p,t]);
  const addTasks = ts => setTasks(p=>[...p,...ts]);
  const addCoreBlocks   = blocks => setCore(p=>[...p,...blocks]);
  const removeCoreBlock = id     => setCore(p=>p.filter(b=>b.id!==id));
  const [addClassOpen, setAddClassOpen] = useState(false);

  // Dismiss a suggestion for the rest of today
  const dismissSuggestion = id => {
    const todayDk = dK(new Date());
    setDismissedSuggestions(p=>[...p.filter(d=>d.date===todayDk), {id, date:todayDk}]);
  };

  const doneTask=id=>{
    const tk=dK(new Date()), st=schedRef.current.find(s=>s.id===id);
    if(st&&st.scheduledDate===tk&&st.scheduledStart&&!st.isCompleted){
      const nowM=new Date().getHours()*60+new Date().getMinutes();
      const scheduledM=toM(st.scheduledStart);
      const actualM=nowM-scheduledM;
      const tag=st.tags?.[0]||'';
      if(tag&&actualM>5&&actualM<(st.duration||60)*2.5){
        setMlLog(p=>[...p.slice(-500),{tag,estimated:st.duration||60,actual:actualM,date:tk,satisfaction:null}]);
      }
    }
    setTasks(p=>p.map(t=>{
      if(t.id!==id) return t;
      const c=!t.isCompleted;
      return {...t,isCompleted:c,completedDate:c?tk:null,
        scheduledDate:c?st?.scheduledDate||t.scheduledDate:t.scheduledDate,
        scheduledStart:c?st?.scheduledStart||t.scheduledStart:t.scheduledStart};
    }));
  };

  const updTask=u=>setTasks(p=>p.map(t=>t.id===u.id?{...t,...u}:t));
  const delTask=id=>setTasks(p=>p.filter(t=>t.id!==id));

  const doneCore=(blockId,date)=>setCompletedCoreInstances(p=>{
    const k=blockId+'|'+date;
    const n={...p};
    if(n[k]) delete n[k]; else n[k]=true;
    return n;
  });

  // ── Drag-reschedule with Collision Detection Matrix ───────────────────────
  // bumpedIds: all flexible tasks that were occupying the drop zone.
  //   → Their scheduling vars are cleared so runSched re-homes them automatically.
  //   → The dragged task is pinned at its new position.
  const rescheduleTask=useCallback((id,newDate,startTime,endTime,bumpedIds=[])=>{
    const bumpSet=new Set(Array.isArray(bumpedIds)?bumpedIds:[bumpedIds].filter(Boolean));
    setTasks(p=>p.map(t=>{
      if(t.id===id){
        // Dragged task: pin it at the new slot
        return {...t,scheduledDate:newDate,scheduledStart:startTime,scheduledEnd:endTime,isPinned:true};
      }
      if(bumpSet.has(t.id)){
        // Bumped task: wipe scheduling so runSched finds a new home
        return {...t,scheduledDate:null,scheduledStart:null,scheduledEnd:null,isPinned:false};
      }
      return t;
    }));
  },[]);

  const editCore=useCallback(({id,name,startTime,endTime})=>{
    setCore(p=>p.map(b=>b.id===id?{...b,name,startTime,endTime}:b));
  },[]);

  const saveSat=r=>{
    setSatHistory(p=>[...p,{...r,date:dK(new Date())}]);
    // Feed per-task actual times into ML log
    if(r.perTask&&r.perTask.length>0){
      const tk=dK(new Date());
      const newEntries=r.perTask
        .filter(t=>t.actual&&t.actual>0&&t.tag)
        .map(t=>({tag:t.tag,estimated:t.estimated,actual:t.actual,date:tk,satisfaction:t.satisfaction}));
      if(newEntries.length>0) setMlLog(p=>[...p.slice(-500),...newEntries]);
    }
  };
  const skipBlock=(blockId,date)=>setSkipped(p=>({...p,[`${blockId}|${date}`]:true}));
  const openSel=ev=>{setSelTask(ev);setSelPos({x:Math.min(window.innerWidth-320,280),y:180});};
  const changDay=(delta,exact)=>{ if(exact){setSelDate(exact);return;} const d=new Date(selDate);d.setDate(d.getDate()+delta);setSelDate(d); };
  const wkLbl=()=>{ const s=wkDates[0],e=wkDates[6]; if(s.getMonth()===e.getMonth()) return `${MONTHS[s.getMonth()]} ${s.getDate()}–${e.getDate()}, ${s.getFullYear()}`; if(s.getFullYear()!==e.getFullYear()) return `${MONTHS[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()} – ${MONTHS[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`; return `${MONTHS[s.getMonth()]} ${s.getDate()} – ${MONTHS[e.getMonth()]} ${e.getDate()}, ${s.getFullYear()}`; };

  return (
    <div className={`app ${theme}`}>
      <style>{CSS}</style>
      <div className="no-print" style={{display:'contents'}}>
        <div className="hdr">
          <div className="hi">
            <div className="logo">TideFlow <small>ADHD Scheduler</small></div>
            <div className="ntabs">
              <button className={`ntab${view==='today'?' on':''}`} onClick={()=>setView('today')}>Today</button>
              <button className={`ntab${view==='grid'?' on':''}`}  onClick={()=>setView('grid')}>Week</button>
              <button className={`ntab${view==='day'?' on':''}`}   onClick={()=>setView('day')}>Day</button>
              <button className={`ntab${view==='wtd'?' on':''}`}   onClick={()=>setView('wtd')} title="What to Do?">⚡</button>
            </div>
            <button className="abtn" onClick={()=>setAddOpen(true)}><Plus size={12}/>Add Task</button>
            <button className="hbtn" title="Print tomorrow" onClick={handlePrint}><Printer size={13}/></button>
            <button className="hbtn" onClick={()=>setTheme(t=>t==='dk'?'lt':'dk')} title="Toggle theme">{theme==='dk'?<Sun size={13}/>:<Moon size={13}/>}</button>
            <button className="hbtn" onClick={()=>setSetOpen(true)} title="Settings"><Settings size={13}/></button>
          </div>
          <svg className="hw" viewBox="0 0 1200 14" preserveAspectRatio="none">
            <path d="M0,7 C150,14 350,0 600,7 C850,14 1050,0 1200,7 L1200,14 L0,14 Z" fill="var(--bg)"/>
          </svg>
        </div>
        <div className="main">
          {view!=='today'&&view!=='wtd'&&<div className="wn">
            <button className="narr" onClick={()=>setWkOff(w=>w-1)}><ChevronLeft size={12}/></button>
            <div className="wnt">{wkLbl()}</div>
            <button className="tbtn" onClick={()=>setWkOff(0)}>This week</button>
            <button className="narr" onClick={()=>setWkOff(w=>w+1)}><ChevronRight size={12}/></button>
          </div>}
          {view==='today'&&<TodayView sched={sched} core={core} onDone={doneTask} onSel={openSel} onAdd={()=>setAddOpen(true)} onRate={()=>setSatOpen(true)} completedCoreInstances={completedCoreInstances} onDoneCore={doneCore}/>}
          {view==='grid' &&<GridView  wkDates={wkDates} sched={sched} core={core} onSel={openSel} onDayClick={d=>{setSelDate(d);setView('day');}} onReschedule={rescheduleTask}/>}
          {view==='day'  &&<DayView   selDate={selDate} wkDates={wkDates} sched={sched} core={core} onSel={openSel} onDone={doneTask} onDayChange={changDay} completedCoreInstances={completedCoreInstances} onDoneCore={doneCore}/>}
          {view==='wtd'  &&<WhatToDoPage
            sched={sched} core={core} satHistory={satHistory}
            burningOutSince={burningOutSince} setBurningOutSince={setBurningOutSince}
            dismissedSuggestions={dismissedSuggestions}
            onDismiss={dismissSuggestion}
            onAddTask={addTask}
            onOpenGroupSched={()=>setSetOpen(true)}
          />}
        </div>
        {addOpen&&<AddModal onClose={()=>setAddOpen(false)} onAdd={addTask} onAddMultiple={addTasks}/>}
        {addClassOpen&&<AddClassModal onClose={()=>setAddClassOpen(false)} onAddCore={addCoreBlocks}/>}
        {printOpen&&<PrintPreviewModal onClose={()=>setPrintOpen(false)} sched={sched} core={core}/>}
        {satOpen&&<SatModal onClose={()=>setSatOpen(false)} onSave={saveSat}
          todayTasks={sched.filter(t=>t.scheduledDate===dK(new Date())&&t.trackable!==false)}/>}
        {icsOpen&&<ICSModal sched={sched} core={core} wkDates={wkDates} onClose={()=>setIcsOpen(false)}/>}
        {selTask&&<Popover task={selTask} pos={selPos} onClose={()=>setSelTask(null)} onUpd={updTask} onDone={doneTask} onDel={delTask} onSkip={skipBlock} onEditCore={editCore}/>}
        {setOpen&&<SettingsPanel
          onClose={()=>setSetOpen(false)}
          theme={theme} setTheme={setTheme}
          core={core} setCore={setCore}
          tasks={tasks} satHistory={satHistory}
          onOpenICS={()=>{setSetOpen(false);setIcsOpen(true);}}
          prefs={prefs} setPrefs={setPrefs}
          mlLog={mlLog} burnoutMode={burnoutMode}
          wkDates={wkDates} sched={sched}
          onAddClass={()=>{setSetOpen(false);setAddClassOpen(true);}}
          removeCoreBlock={removeCoreBlock}
          burningOutSince={burningOutSince}
          setBurningOutSince={setBurningOutSince}
        />}
      </div>
    </div>
  );
}