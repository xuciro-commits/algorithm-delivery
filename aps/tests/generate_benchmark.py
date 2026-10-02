#!/usr/bin/env python3
"""Create separable scale fixtures of N operations (N multiple of 24).
These isolate model size/serialization overhead and are NOT a hard coupled APS benchmark.
"""
import argparse,copy,json,sys
from pathlib import Path
P=Path(__file__).resolve().parents[1]
def build(n):
 if n%24: raise ValueError('operation count must be a multiple of 24')
 base=json.loads((P/'mock'/'baseline.json').read_text())
 z=copy.deepcopy(base);z['meta']['snapshot_id']=f'benchmark-{n}-separable-seed42'
 z['machines']=[];z['workers']=[];z['tools']=[];z['materials']=[];z['orders']=[]
 for idx in range(n//24):
  pref=f'CELL{idx+1:03d}'
  def nid(k):return f'{pref}__{k}'
  for field in ['machines','workers','tools','materials']:
   for obj in base[field]:
    obj=copy.deepcopy(obj);obj['id']=nid(obj['id']);z[field].append(obj)
  for o in base['orders']:
   o=copy.deepcopy(o);o['id']=nid(o['id'])
   for op in o['operations']:
    op['id']=nid(op['id']);op['predecessors']=[nid(k) for k in op['predecessors']]
    for a in op['alternatives']:a['machine_id']=nid(a['machine_id'])
    op['tools']=[nid(k) for k in op['tools']]
    op['materials']={nid(k):v for k,v in op['materials'].items()}
   z['orders'].append(o)
 return z
if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--operations',type=int,choices=[24,240,2400],required=True)
 ap.add_argument('--out',type=Path,required=True);args=ap.parse_args()
 p=build(args.operations);args.out.parent.mkdir(parents=True,exist_ok=True)
 args.out.write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n')
 print('wrote',args.out,'orders',len(p['orders']),'operations',sum(len(o['operations']) for o in p['orders']))
