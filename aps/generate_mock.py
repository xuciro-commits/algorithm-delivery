#!/usr/bin/env python3
"""Generate deterministic APS v1 mock cases + constructive feasibility witness; no OR-Tools required."""
from pathlib import Path
import json, copy, datetime
from zoneinfo import ZoneInfo

OUT = Path(__file__).resolve().parent
TZ=ZoneInfo('America/Los_Angeles')
START=datetime.datetime(2026,10,5,8,tzinfo=TZ)
END=datetime.datetime(2026,10,9,17,tzinfo=TZ)

def stamp(day,hour,minute=0):
    return datetime.datetime(2026,10,day,hour,minute,tzinfo=TZ).isoformat()

def calendar(start_day=5,end_day=9):
    return [{'start':stamp(d,a),'end':stamp(d,b)} for d in range(start_day,end_day+1) for a,b in [(8,12),(13,17)]]

cal=calendar()
machines=[
 {'id':'CUT-01','capabilities':['cut'],'available':copy.deepcopy(cal),'blocked':[]},
 {'id':'CUT-02','capabilities':['cut'],'available':copy.deepcopy(cal),'blocked':[]},
 {'id':'WELD-01','capabilities':['weld'],'available':copy.deepcopy(cal),'blocked':[]},
 {'id':'WELD-02','capabilities':['weld'],'available':copy.deepcopy(cal),'blocked':[]},
 {'id':'PAINT-01','capabilities':['paint'],'available':copy.deepcopy(cal),'blocked':[]},
]
workers=[]
for i in range(1,4): workers.append({'id':f'EMP-C{i:02}', 'skills':['cut'], 'qualifications':[], 'available':copy.deepcopy(cal),'blocked':[]})
for i in range(1,4): workers.append({'id':f'EMP-W{i:02}', 'skills':['weld'], 'qualifications':['cert-weld'], 'available':copy.deepcopy(cal),'blocked':[]})
for i in range(1,3): workers.append({'id':f'EMP-P{i:02}', 'skills':['paint'], 'qualifications':['cert-paint'], 'available':copy.deepcopy(cal),'blocked':[]})
orders=[]
for i in range(1,9):
    oid=f'ORD-{i:03}'
    qty=[2,3,1,4,2,3,1,4][i-1]
    # All operation durations/materials apply to full unsplit order batches.
    cut=30+15*(qty>=3)
    weld=45+15*(qty>=3)
    paint=30+15*(qty>=3)
    orders.append({
      'id':oid,'quantity':qty,'priority':[3,1,2,4,1,3,2,4][i-1],
      'release_at':stamp(5,8 if i<=4 else 10),
      'due_at':stamp([6,6,7,7,8,8,9,9][i-1],16),
      'operations':[
        {'id':f'{oid}-CUT','predecessors':[],'skill':'cut','qualifications':[], 'worker_count':1,
         'alternatives':[{'machine_id':'CUT-01','duration_min':cut},{'machine_id':'CUT-02','duration_min':cut+15}],
         'tools':['DIE-SHARED-01'] if i<=4 else [],'materials':{'M-BLANK':qty}},
        {'id':f'{oid}-WELD','predecessors':[f'{oid}-CUT'],'skill':'weld','qualifications':['cert-weld'],'worker_count':1,
         'alternatives':[{'machine_id':'WELD-01','duration_min':weld},{'machine_id':'WELD-02','duration_min':weld+15}],
         'tools':[],'materials':{'M-ROD':1}},
        {'id':f'{oid}-PAINT','predecessors':[f'{oid}-WELD'],'skill':'paint','qualifications':['cert-paint'],'worker_count':1,
         'alternatives':[{'machine_id':'PAINT-01','duration_min':paint}],
         'tools':[],'materials':{'M-PAINT':2}},
      ]
    })
base={
 'meta':{'schema_version':'plan-problem/1.0','tenant_id':'mock-tenant-alpha','site_id':'mock-factory-one',
         'snapshot_id':'snapshot-baseline-v1','timezone':'America/Los_Angeles',
         'horizon_start':START.isoformat(),'horizon_end':END.isoformat(),'resolution_min':15},
 'machines':machines,'workers':workers,
 'tools':[{'id':'DIE-SHARED-01','capacity':1}],
 'materials':[
   {'id':'M-BLANK','initial_quantity':30,'receipts':[]},
   {'id':'M-ROD','initial_quantity':10,'receipts':[]},
   {'id':'M-PAINT','initial_quantity':8,'receipts':[{'at':stamp(6,8),'quantity':10}]}
 ],'orders':orders,
 'objective':{'strategy':'lexicographic','phases':['weighted_tardiness','makespan'], 'time_limit_ms':30000,'seed':42}
}

def write(name,obj):
    with (OUT/'mock'/name).open('w',encoding='utf-8') as f:json.dump(obj,f,ensure_ascii=False,indent=2);f.write('\n')
write('baseline.json',base)
fault=copy.deepcopy(base);fault['meta']['snapshot_id']='snapshot-machine-breakdown-v1'
next(x for x in fault['machines'] if x['id']=='WELD-02')['blocked']=[{'start':stamp(5,13),'end':stamp(5,17),'reason':'breakdown'}]
write('machine-breakdown.json',fault)
late=copy.deepcopy(base);late['meta']['snapshot_id']='snapshot-material-delay-v1'
next(x for x in late['materials'] if x['id']=='M-PAINT')['receipts']=[{'at':stamp(7,8),'quantity':10}]
write('material-delay.json',late)
infeasible=copy.deepcopy(base);infeasible['meta']['snapshot_id']='snapshot-infeasible-v1'
for person in infeasible['workers']:
 if 'weld' in person['skills']: person['qualifications']=[]
write('infeasible-no-welder.json',infeasible)

# Construct a trivial serial, resource-safe feasibility witness for baseline.
# This is intentionally not an optimization solver or an optimality claim.
def parse(ts):return datetime.datetime.fromisoformat(ts)
def minus(start,end):return int((parse(end)-parse(start)).total_seconds()/60)
windows=[(minus(START.isoformat(),s['start']),minus(START.isoformat(),s['end'])) for s in cal]
now=0;stock={m['id']:m['initial_quantity'] for m in base['materials']}
receipts=[]
for m in base['materials']:
 for r in m['receipts']:receipts.append((minus(START.isoformat(),r['at']),m['id'],r['quantity']))
receipts.sort(); ri=0;items=[]
for order in orders:
    now=max(now,minus(START.isoformat(),order['release_at']))
    for op in order['operations']:
        alt=op['alternatives'][0]; dur=alt['duration_min']
        while True:
            slot=next(((a,b) for a,b in windows if b>=now+dur and max(now,a)+dur<=b),None)
            if slot is None:raise RuntimeError('horizon exhausted, invalid fixture')
            t=max(slot[0],now)
            if t+dur>slot[1]:now=slot[1];continue
            available=stock.copy()
            for tt,mat,qty in receipts[ri:]:
                if tt<=t:available[mat]=available.get(mat,0)+qty
            if all(available[k]>=v for k,v in op['materials'].items()):break
            possible=[tt for tt,m,q in receipts[ri:] if m in op['materials'] and tt>t]
            if not possible:raise RuntimeError('stock cannot fulfill mock witness')
            now=min(possible)
        while ri<len(receipts) and receipts[ri][0]<=t:
            _,m,q=receipts[ri];stock[m]+=q;ri+=1
        for m,q in op['materials'].items():stock[m]-=q
        worker=next(p['id'] for p in workers if op['skill'] in p['skills'] and set(op['qualifications'])<=set(p['qualifications']))
        real_start=START+datetime.timedelta(minutes=t)
        real_end=START+datetime.timedelta(minutes=t+dur)
        items.append({'order_id':order['id'],'operation_id':op['id'],'machine_id':alt['machine_id'],'worker_id':worker,
                      'tool_ids':op['tools'],'start_at':real_start.isoformat(),'end_at':real_end.isoformat()})
        now=t+dur
witness={'schema_version':'plan-solution/1.0','snapshot_id':base['meta']['snapshot_id'],
         'status':'FEASIBLE','optimality_proven':False,'operations':items}
with (OUT/'tests'/'baseline-feasible-witness.json').open('w',encoding='utf-8') as f:json.dump(witness,f,indent=2);f.write('\n')
contract={'schema_version':'plan-solution/1.0','id':'reference-serial-feasible-0001','tenant_id':base['meta']['tenant_id'],
          'snapshot_id':base['meta']['snapshot_id'],'problem_hash':'mock:NOT_CANONICAL_HASH',
          'engine':'constructive-reference','engine_version':'mock-generator-1.0','compiler_version':'plan-compiler-1.0',
          'options':{'time_limit_ms':30000,'seed':42},'status':'FEASIBLE','optimality_proven':False,
          'objective':{'strategy':'lexicographic','weighted_tardiness_minutes':None,'makespan_minutes':None,'best_bound':None,'relative_gap':None},
          'metrics':{'compile_ms':None,'first_feasible_ms':None,'solve_ms':None,'verify_ms':None,'peak_memory_bytes':None},
          'verified':False,'violations':[], 'operations':items}
with (OUT/'contracts'/'plan-result.example.json').open('w',encoding='utf-8') as f:json.dump(contract,f,indent=2);f.write('\n')
acceptance={
  'schema_version':'aps-acceptance/1.0',
  'cases':[
   {'id':'S01','fixture':'mock/baseline.json','must':'native solver returns valid complete solution, independent verifier reports zero violations'},
   {'id':'S02','fixture':'mock/machine-breakdown.json','must':'no operation overlaps WELD-02 blocked range'},
   {'id':'S03','fixture':'mock/material-delay.json','must':'event-ordered material ledger never negative'},
   {'id':'S04','fixture':'mock/infeasible-no-welder.json','must':'complete native CP-SAT model proves INFEASIBLE; no silent constraint drops'},
   {'id':'S05','fixture':'mock/baseline.json','must':'after separate simulated snapshot change, stale candidate publish fails with STALE_SNAPSHOT'},
   {'id':'S06','fixture':'tests/baseline-feasible-witness.json','must':'mutate witness: each H02–H07 violation is detected independently'},
   {'id':'S07','fixture':'mock/baseline.json','must':'tenant B cannot read or publish tenant A problem or solution'},
   {'id':'S08','fixture':'mock/baseline.json','must':'unsupported WASM constraint yields UNSUPPORTED_CONSTRAINT, never silently ignores constraints'},
  ],
  'benchmark_seeds':[42,73,2026], 'benchmark_operation_counts':[24,240,2400],
  'note':'performance targets established after reproducible baseline on contracted hardware'
}
with (OUT/'tests'/'acceptance.json').open('w',encoding='utf-8') as f:json.dump(acceptance,f,indent=2);f.write('\n')
print('Created files; orders=',len(orders),'operations=',sum(len(x['operations']) for x in orders),
      'baseline witness operations=',len(items),'last completion=',items[-1]['end_at'])
