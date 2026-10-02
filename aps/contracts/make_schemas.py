#!/usr/bin/env python3
import json
from pathlib import Path
P=Path(__file__).parent
refid={'type':'string','minLength':1}
nonneg={'type':'integer','minimum':0}
pos={'type':'integer','minimum':1}
ts={'type':'string','format':'date-time'}
interval={'type':'object','additionalProperties':False,'required':['start','end'],'properties':{'start':ts,'end':ts,'reason':{'type':'string'}}}
cal={'type':'array','items':interval}
alternative={'type':'object','required':['machine_id','duration_min'],'additionalProperties':False,'properties':{'machine_id':refid,'duration_min':pos}}
operation={'type':'object','additionalProperties':False,'required':['id','predecessors','skill','qualifications','worker_count','alternatives','tools','materials'],
 'properties':{'id':refid,'predecessors':{'type':'array','uniqueItems':True,'items':refid},'skill':refid,
 'qualifications':{'type':'array','uniqueItems':True,'items':refid},'worker_count':{'const':1},
 'alternatives':{'type':'array','minItems':1,'items':alternative},'tools':{'type':'array','uniqueItems':True,'items':refid},
 'materials':{'type':'object','additionalProperties':pos}}}
base={'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'https://example.invalid/aps/plan-problem.schema.json',
 'title':'PlanProblem v1','type':'object','additionalProperties':False,
 'required':['meta','machines','workers','tools','materials','orders','objective'],
 'properties':{
  'meta':{'type':'object','additionalProperties':False,'required':['schema_version','tenant_id','site_id','snapshot_id','timezone','horizon_start','horizon_end','resolution_min'],
   'properties':{'schema_version':{'const':'plan-problem/1.0'},'tenant_id':refid,'site_id':refid,'snapshot_id':refid,'timezone':refid,
                 'horizon_start':ts,'horizon_end':ts,'resolution_min':pos}},
  'machines':{'type':'array','minItems':1,'items':{'type':'object','additionalProperties':False,
   'required':['id','capabilities','available','blocked'],'properties':{'id':refid,'capabilities':{'type':'array','minItems':1,'items':refid},'available':cal,'blocked':cal}}},
  'workers':{'type':'array','minItems':1,'items':{'type':'object','additionalProperties':False,
   'required':['id','skills','qualifications','available','blocked'],'properties':{'id':refid,'skills':{'type':'array','items':refid},'qualifications':{'type':'array','items':refid},'available':cal,'blocked':cal}}},
  'tools':{'type':'array','items':{'type':'object','additionalProperties':False,'required':['id','capacity'],'properties':{'id':refid,'capacity':{'const':1}}}},
  'materials':{'type':'array','items':{'type':'object','additionalProperties':False,'required':['id','initial_quantity','receipts'],
   'properties':{'id':refid,'initial_quantity':nonneg,'receipts':{'type':'array','items':{'type':'object','additionalProperties':False,'required':['at','quantity'],'properties':{'at':ts,'quantity':pos}}}}}},
  'orders':{'type':'array','minItems':1,'items':{'type':'object','additionalProperties':False,
    'required':['id','quantity','priority','release_at','due_at','operations'],
    'properties':{'id':refid,'quantity':pos,'priority':pos,'release_at':ts,'due_at':ts,
     'operations':{'type':'array','minItems':1,'items':operation}}}},
  'objective':{'type':'object','additionalProperties':False,'required':['strategy','phases','time_limit_ms','seed'],
    'properties':{'strategy':{'enum':['lexicographic','makespan']},'phases':{'type':'array','items':{'enum':['weighted_tardiness','makespan']}},
      'time_limit_ms':pos,'seed':nonneg}}
 }}
result={'$schema':base['$schema'],'$id':'https://example.invalid/aps/plan-solution.schema.json','title':'PlanSolution v1',
 'type':'object','required':['schema_version','snapshot_id','status','optimality_proven','operations'],
 'properties':{'schema_version':{'const':'plan-solution/1.0'},'id':refid,'tenant_id':refid,'snapshot_id':refid,'problem_hash':refid,
   'engine':refid,'engine_version':refid,'compiler_version':refid,'options':{'type':'object'},
   'status':{'enum':['OPTIMAL','FEASIBLE','INFEASIBLE','UNKNOWN','MODEL_INVALID','NO_SOLUTION_FOUND','UNSUPPORTED_CONSTRAINT','CANCELLED']},
   'optimality_proven':{'type':'boolean'},'verified':{'type':'boolean'},'violations':{'type':'array','items':{'type':'object'}},
   'objective':{'type':'object'},'metrics':{'type':'object'},
   'operations':{'type':'array','items':{'type':'object','additionalProperties':False,
    'required':['order_id','operation_id','machine_id','worker_id','tool_ids','start_at','end_at'],
    'properties':{'order_id':refid,'operation_id':refid,'machine_id':refid,'worker_id':refid,
      'tool_ids':{'type':'array','items':refid},'start_at':ts,'end_at':ts}}}},
 'additionalProperties':False}
capability={'$schema':base['$schema'],'$id':'https://example.invalid/aps/solver-capabilities.schema.json','title':'SolverCapabilities v1',
 'type':'object','additionalProperties':False,'required':['engine','version','constraints','max_operations','can_prove_optimal','can_prove_infeasible','supports_cancel'],
 'properties':{'engine':refid,'version':refid,'constraints':{'type':'array','uniqueItems':True,'items':{'enum':[f'H{i:02}' for i in range(1,9)]}},
    'max_operations':pos,'can_prove_optimal':{'type':'boolean'},'can_prove_infeasible':{'type':'boolean'},'supports_cancel':{'type':'boolean'}}}
for name,obj in [('plan-problem.schema.json',base),('plan-solution.schema.json',result),('solver-capabilities.schema.json',capability)]:
 with (P/name).open('w') as f:json.dump(obj,f,indent=2);f.write('\n')
print('Generated 3 schemas')
