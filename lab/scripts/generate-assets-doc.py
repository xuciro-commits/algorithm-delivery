#!/usr/bin/env python3
"""
Regenerate README.md for lab/design/assets/ from ASSET-CATALOG.json.
Supports assembled-scenes as a primary category.

路径相对于本脚本，可在任何机器上运行：
    python3 lab/scripts/generate-assets-doc.py

若目录里的 GLB 与清单不一致（清单里有、磁盘上没有），脚本会在结尾列出差异并附带
"未随仓库提供"提示，避免生成出指向空文件的链接。
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.path.normpath(os.path.join(HERE, '..', 'design', 'assets'))
CATALOG_FILE = os.path.join(ASSETS_DIR, 'ASSET-CATALOG.json')
README_FILE = os.path.join(ASSETS_DIR, 'README.md')
REGISTER_FILE = os.path.join(ASSETS_DIR, 'ASSET-REGISTER.md')

def on_disk(category, filename):
    return os.path.exists(os.path.join(ASSETS_DIR, category, filename))

with open(CATALOG_FILE, 'r', encoding='utf-8') as f:
    catalog = json.load(f)

assets_by_cat = {}
for a in catalog['assets']:
    c = a['category']
    if c not in assets_by_cat:
        assets_by_cat[c] = []
    assets_by_cat[c].append(a)

# 只有磁盘上真实存在的文件才进表格，避免生成指向空文件的链接
missing_files = [
    f"{a['category']}/{a['filename']}"
    for a in catalog['assets']
    if not on_disk(a['category'], a['filename'])
]
present_by_cat = {
    c: [a for a in items if on_disk(c, a['filename'])] for c, items in assets_by_cat.items()
}
total_present = sum(len(v) for v in present_by_cat.values())
scene_count = len(present_by_cat.get('assembled-scenes', []))
meta_count = total_present - scene_count

cat_titles = {
    'assembled-scenes': '成套完整大场景 / 沙盘基座 (Pre-Assembled Large Scenes & Environments)',
    'agv-warehouse': 'AGV 智能仓储与物流沙盘 (AGV & Smart Warehouse)',
    'aps-machining': 'APS 智能制造与机加工单元 (APS Machining & Manufacturing)',
    'mapf-robotics': 'MAPF 多智能体移动机器人与空间基建 (MAPF Mobile Robots & Telemetry)',
    'conveyors-logistics': '连续输送与智能分拣网络 (Conveyors & Sorting Network)',
    'lab-cleanroom': '数字孪生实验室与洁净室仪器 (Digital Lab & Scientific Cleanroom)'
}

cat_descriptions = {
    'assembled-scenes': '开箱即用的完整大场景沙盘（涵盖重工业机加工厂房、汽车总装流水线、高位立体仓库、物流分拣枢纽、机器人研发机库、数据中心、中控室大屏及密集立库等），可直接一键载入作为基座场景，按需删减或增补个体模型！',
    'agv-warehouse': '包含低趴搬运 AGV、潜伏式顶升 AGV、牵引车、平衡重叉车、手动液压托盘车、高位托盘货架、悬臂式货架、仓储笼、料箱托盘、地面导引线、安全防护栏、装卸货平台及叉车充电桩等。',
    'aps-machining': '包含 CNC 数控加工中心、精密车床、立式铣床、重型冲压机、数控折弯机、六轴焊接机器人、工装夹具、安灯状态指示塔、高空行车轨道及机加工件工序零件等。',
    'mapf-robotics': '包含双足服务机器人、巡检机器人、配送机器人、四足机器狗、四驱/六驱探索车、履带式 UGV、台面/落地机械臂、无线遥测基站、无人机起降坪及圆形/方形无线充电底座等。',
    'conveyors-logistics': '包含直段动力输送带、无动力滚筒输送线、90度弯道机、三向分流器、四向分拣交叉口、条码扫描拱门、动态称重输送机、垂直升降机及包裹滑槽等。',
    'lab-cleanroom': '包含模块化实验室工作台、洁净室气淋室、生物安全柜、通风橱、高速离心机、高压灭菌锅、超低温冷冻柜、分析天平、分光光度计、试管架及移液器等。'
}

md = []
md.append('# Algorithm Lab 3D 资产与完整场景库 (3D Assets & Assembled Scenes Catalog)\n')
md.append(f'> 本目录收录了专为 **Algorithm Lab（算法实验室）** 3D 数字沙盘与数字孪生建模定制的 **{total_present} 个高质量 low-poly GLB 模型与 {scene_count} 套开箱即用完整大场景**。')
md.append('> 所有资产均遵循 **CC0 1.0 Universal** 协议（公共领域，免版税，可商用，支持无署名再分发）。\n')

md.append('## 🌟 推荐建模工作流：大场景基座 + 细分组件增删\n')
md.append('为了避免从零手工搭建场景的繁琐工作，我们特别准备了 **`assembled-scenes/`** 目录：')
md.append('1. **直接拖入大场景**：例如直接加载 `warehouse-high-bay-aisles.glb`（立体高位仓库）或 `car-assembly-plant-production-line.glb`（汽车产线流水线）。')
md.append('2. **按需删减**：在 Three.js / Blender 中根据需求隐藏或移除不需要的节点（所有场景均为分层清晰命名的 node hierarchy）。')
md.append('3. **补充微观元素**：从 `agv-warehouse/`、`aps-machining/`、`mapf-robotics/` 等分类中引入对应的 AGV、机械臂、传感器或工序件，实现高效率、高质量的沙盘构建。\n')

md.append('## 1. 资产分类总览\n')
md.append('| 目录 / 分类 | 模型数量 | 适用场景 / 核心内容 | 格式与技术规格 |')
md.append('|---|---:|---|---|')

for cat in ['assembled-scenes', 'agv-warehouse', 'aps-machining', 'mapf-robotics', 'conveyors-logistics', 'lab-cleanroom']:
    items = present_by_cat.get(cat, [])
    size_mb = sum(i.get('stats', {}).get('fileSize', 0) for i in items) / (1024 * 1024)
    md.append(f"| [`{cat}/`](./{cat}) · {cat_titles[cat]} | **{len(items)}** | {cat_descriptions[cat][:30]}... | GLB · 合计 {size_mb:.2f} MB |")

total_mb = sum(a.get('stats', {}).get('fileSize', 0) for a in catalog['assets'] if on_disk(a['category'], a['filename'])) / (1024 * 1024)
md.append(f"| **合计** | **{total_present}** | **全场景覆盖 ({scene_count} 套完整大场景 + {meta_count} 个细分元模型)** | **合计 ~{total_mb:.2f} MB (极速加载)** |")
if missing_files:
    md.append(f"\n> 注：清单（`ASSET-CATALOG.json`）中共有 {len(catalog['assets'])} 条记录，"
              f"其中 **{len(missing_files)} 个文件当前不在仓库中**（未列出，避免死链）："
              + '、'.join(f'`{m}`' for m in missing_files)
              + "。补齐下载或更新清单后重跑 `python3 lab/scripts/generate-assets-doc.py`。")
md.append('')

md.append(f'## 2. {scene_count} 套成套完整大场景速查 (`assembled-scenes/`)\n')
md.append('| 文件名 | 场景名称 | 尺寸 (X×Y×Z 米) | 面数 | 推荐算法与沙盘用途 |')
md.append('|---|---|---|---:|---|')

for s in present_by_cat.get('assembled-scenes', []):
    dim = s.get('sizeMeters', [0, 0, 0])
    dim_str = f"{dim[0]:.1f} × {dim[1]:.1f} × {dim[2]:.1f}"
    tri = s.get('stats', {}).get('triangles', 0)
    theme = s.get('theme', '沙盘场景')
    md.append(f"| [`{s['filename']}`](./assembled-scenes/{s['filename']}) | **{s['title']}** | {dim_str} | {tri:,} | {theme} |")

md.append('\n## 3. 使用方法 (Three.js & React Three Fiber)\n')
md.append('### React Three Fiber 加载大场景基座\n')
md.append('```tsx')
md.append('import { useGLTF } from "@react-three/drei";\n')
md.append('export function WarehouseScene() {')
md.append('  // 1. 载入立体仓库大场景基座')
md.append('  const { scene } = useGLTF("./assembled-scenes/warehouse-high-bay-aisles.glb");\n')
md.append('  return (')
md.append('    <group>')
md.append('      <primitive object={scene} />')
md.append('      {/* 2. 在大场景上叠加自定义动态 AGV 单元 */}')
md.append('      <DynamicAgvRobot position={[2, 0, 4]} />')
md.append('    </group>')
md.append('  );')
md.append('}')
md.append('useGLTF.preload("./assembled-scenes/warehouse-high-bay-aisles.glb");')
md.append('```\n')

md.append('## 4. 各细分分类元模型清单 (元模型库)\n')

for cat in ['agv-warehouse', 'aps-machining', 'mapf-robotics', 'conveyors-logistics', 'lab-cleanroom']:
    items = present_by_cat.get(cat, [])
    md.append(f"### {cat_titles[cat]} (`{cat}/`, 共 {len(items)} 个)\n")
    md.append(f"{cat_descriptions[cat]}\n")
    md.append('| 文件名 | 名称 / 说明 | 尺寸 (X×Y×Z 米) | 面数 (Triangles) | 是否带动画 |')
    md.append('|---|---|---|---:|:---:|')
    
    for item in items[:20]:
        dim = item.get('sizeMeters') or [0, 0, 0]
        dim_str = f"{dim[0]:.2f} × {dim[1]:.2f} × {dim[2]:.2f}"
        tri = item.get('stats', {}).get('triangles', 0)
        anim = '✓' if item.get('animated') else '—'
        md.append(f"| [`{item['filename']}`](./{cat}/{item['filename']}) | {item['title']} | {dim_str} | {tri:,} | {anim} |")
    
    if len(items) > 20:
        md.append(f"| *(其余 {len(items)-20} 个模型)* | *(见 `ASSET-CATALOG.json` 或对应目录)* | — | — | — |")
    md.append('')

with open(README_FILE, 'w', encoding='utf-8') as f:
    f.write('\n'.join(md) + '\n')

print(f"README.md regenerated successfully to {README_FILE}")

if missing_files:
    print(f"\n[warn] 清单中有 {len(missing_files)} 个文件不在磁盘上（已从表格中排除，未生成死链）：")
    for m in missing_files:
        print(f"  - {m}")
    print("  处理方式：重新运行对应的下载脚本补齐，或更新 ASSET-CATALOG.json 后重跑本脚本。")
else:
    print(f"清单与磁盘一致（{len(catalog['assets'])} 个文件）")

