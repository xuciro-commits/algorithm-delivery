#!/usr/bin/env python3
"""Independent mock fixture/witness checker. Intended for source QA, not a production verifier."""
import copy,json,sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
P=Path(__file__).resolve().parents[1]
def read(f):return json.loads((P/f).read_text())
def dt(x):return datetime.fromisoformat(x)
def inside(start,end,entity):
 return any(dt(w['start'])<=start and end<=dt(w['end']) for w in entity['available']) and not any(start<dt(w['end']) and dt(w['start'])<end for w in entity['blocked'])
def overlaps(a,b):return a[0]<b[1] and b[0]<a[1]
def verify(p,sol):
 errs=[]
 orders={x['id']:x for x in p['orders']}
 operations={op['id']:(o,op) for o in p['orders'] for op in o['operations']}
 machines={x['id']:x for x in p['machines']};workers={x['id']:x for x in p['workers']}
 tools={x['id']:x for x in p['tools']};mat={x['id']:x for x in p['materials']}
 rows={};mx=defaultdict(list);wk=defaultdict(list);tl=defaultdict(list);events=defaultdict(list)
 if sol['snapshot_id']!=p['meta']['snapshot_id']:errs.append('SNAPSHOT_MISMATCH')
 for s in sol['operations']:
  oid=s['operation_id']
  if oid in rows:errs.append('DUPLICATE_OPERATION:'+oid);continue
  if oid not in operations:errs.append('UNKNOWN_OPERATION:'+oid);continue
  order,op=operations[oid];rows[oid]=s
  try:start,end=dt(s['start_at']),dt(s['end_at'])
  except Exception:errs.append('TIME_INVALID:'+oid);continue
  if s['order_id']!=order['id']:errs.append('ORDER_ID:'+oid)
  if start>=end or start<dt(p['meta']['horizon_start']) or end>dt(p['meta']['horizon_end']):errs.append('HORIZON:'+oid)
  if start<dt(order['release_at']):errs.append('RELEASE:'+oid)
  alt=next((a for a in op['alternatives'] if a['machine_id']==s['machine_id']),None)
  if not alt:errs.append('ALTERNATIVE:'+oid)
  elif (end-start).total_seconds()/60!=alt['duration_min']:errs.append('DURATION:'+oid)
  m=machines.get(s['machine_id']);w=workers.get(s['worker_id'])
  if m is None or not inside(start,end,m):errs.append('MACHINE_CALENDAR:'+oid)
  if w is None or not inside(start,end,w):errs.append('WORKER_CALENDAR:'+oid)
  if w is not None and (op['skill'] not in w['skills'] or not set(op['qualifications'])<=set(w['qualifications'])):errs.append('WORKER_SKILL:'+oid)
  if m is not None:mx[m['id']].append(((start,end),oid))
  if w is not None:wk[w['id']].append(((start,end),oid))
  if set(s['tool_ids'])!=set(op['tools']):errs.append('TOOLS_ASSIGNMENT:'+oid)
  for tool in s['tool_ids']:
   if tool not in tools:errs.append('UNKNOWN_TOOL:'+oid)
   else:tl[tool].append(((start,end),oid))
  for material,amount in op['materials'].items():
   if material not in mat:errs.append('UNKNOWN_MATERIAL:'+oid)
   else:events[material].append((start,1,-amount))
 for oid in operations:
  if oid not in rows:errs.append('MISSING_OPERATION:'+oid)
 for oid,(order,op) in operations.items():
  if oid in rows:
   for pred in op['predecessors']:
    if pred not in rows:errs.append('MISSING_PREDECESSOR:'+oid)
    elif dt(rows[oid]['start_at'])<dt(rows[pred]['end_at']):errs.append('PRECEDENCE:'+oid)
 for typ,data in [('MACHINE',mx),('WORKER',wk),('TOOL',tl)]:
  for r,assign in data.items():
   assign.sort()
   for i in range(1,len(assign)):
    if overlaps(assign[i-1][0],assign[i][0]):errs.append(f'{typ}_OVERLAP:{r}')
 for m in p['materials']:
  current=m['initial_quantity'];e=events[m['id']]+[(dt(r['at']),0,r['quantity']) for r in m['receipts']]
  # At same time receipts (0) precede consumption (1).
  for when,order,qty in sorted(e,key=lambda t:(t[0],t[1])):
   current+=qty
   if current<0:errs.append('STOCK_NEGATIVE:'+m['id']);break
 return sorted(set(errs))

def structural(p):
 errs=[]
 if len({x['id'] for x in p['orders']})!=len(p['orders']):errs.append('DUP_ORDER')
 for name in ['machines','workers','tools','materials']:
  if len({x['id'] for x in p[name]})!=len(p[name]):errs.append('DUP_'+name.upper())
 machine_ids={x['id'] for x in p['machines']};mat_ids={x['id'] for x in p['materials']};tool_ids={x['id'] for x in p['tools']}
 for o in p['orders']:
  op_ids={x['id'] for x in o['operations']}
  if len(op_ids)!=len(o['operations']):errs.append('DUP_OP')
  for op in o['operations']:
   if any(pred not in op_ids for pred in op['predecessors']):errs.append('UNKNOWN_PRED')
   if any(x['machine_id'] not in machine_ids for x in op['alternatives']):errs.append('UNKNOWN_MACHINE')
   if any(x not in tool_ids for x in op['tools']):errs.append('UNKNOWN_TOOL')
   if any(x not in mat_ids for x in op['materials']):errs.append('UNKNOWN_MAT')
   if any(x['duration_min']%p['meta']['resolution_min'] for x in op['alternatives']):errs.append('RESOLUTION')
 return errs

if __name__=='__main__':
 fixtures=['baseline','machine-breakdown','material-delay','infeasible-no-welder']
 for x in fixtures:
  p=read(f'mock/{x}.json');assert not structural(p),(x,structural(p))
 base=read('mock/baseline.json');wit=read('tests/baseline-feasible-witness.json')
 assert len(wit['operations'])==24
 assert not verify(base,wit),verify(base,wit)
 print('PASS: 4 scenario fixtures structurally valid')
 print('PASS: baseline witness complete and independently verified (24 operations)')
 # Mutations deliberately break exactly one safety property and should be detected.
 altered=copy.deepcopy(wit);altered['operations'][0]['end_at']=altered['operations'][0]['start_at'];assert any(x.startswith('DURATION:') for x in verify(base,altered))
 altered=copy.deepcopy(wit);altered['operations'][0]['worker_id']='EMP-P01';assert any(x.startswith('WORKER_SKILL:') for x in verify(base,altered))
 altered=copy.deepcopy(wit);altered['operations'][0]['tool_ids']=[];assert any(x.startswith('TOOLS_ASSIGNMENT:') for x in verify(base,altered))
 altered=copy.deepcopy(wit);altered['operations'][1]['start_at']=altered['operations'][0]['start_at'];assert any(x.startswith('PRECEDENCE:') for x in verify(base,altered))
 altered=copy.deepcopy(wit);altered['operations'][0]['start_at']='2026-10-05T12:00:00-07:00';altered['operations'][0]['end_at']='2026-10-05T12:30:00-07:00';assert any(x.startswith('MACHINE_CALENDAR:') for x in verify(base,altered))
 altered=copy.deepcopy(wit);altered['operations'][1]['start_at']=wit['operations'][0]['start_at'];altered['operations'][1]['end_at']=wit['operations'][0]['end_at'];altered['operations'][1]['machine_id']=wit['operations'][0]['machine_id'];assert any(x.startswith('MACHINE_OVERLAP:') for x in verify(base,altered))
 altered=copy.deepcopy(base);next(x for x in altered['materials'] if x['id']=='M-BLANK')['initial_quantity']=0;assert any(x.startswith('STOCK_NEGATIVE:') for x in verify(altered,wit))
 print('PASS: 7 negative mutations independently detected')
 try:
  import jsonschema
  for x in fixtures:jsonschema.validate(read(f'mock/{x}.json'),read('contracts/plan-problem.schema.json'),format_checker=jsonschema.FormatChecker())
  jsonschema.validate(wit,read('contracts/plan-solution.schema.json'),format_checker=jsonschema.FormatChecker())
  print('PASS: 4 fixtures and baseline witness satisfy JSON Schemas')
 except ImportError: print('SKIP: jsonschema package unavailable; structural/witness tests still passed')
