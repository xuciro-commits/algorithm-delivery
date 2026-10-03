#!/usr/bin/env python3
"""
Download complete, pre-assembled large scenes into lab/design/assets/assembled-scenes/
Updates ASSET-CATALOG.json, README.md, and ASSET-REGISTER.md
"""

import os
import json
import urllib.request
import time
from concurrent.futures import ThreadPoolExecutor

# 路径相对于脚本位置，任何机器/CI 上都能复现（不再依赖个人目录结构）
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.path.normpath(os.path.join(HERE, '..', 'design', 'assets'))
TARGET_DIR = os.path.join(ASSETS_DIR, 'assembled-scenes')
CATALOG_PATH = os.path.join(ASSETS_DIR, 'ASSET-CATALOG.json')
os.makedirs(TARGET_DIR, exist_ok=True)

SCENES = [
    {
        'filename': 'warehouse-high-bay-aisles.glb',
        'title': '高位立体仓储与叉车巷道大场景 (Warehouse High-Bay Racking & Aisles)',
        'summary': '完整工业立体仓储沙盘：4m/6m 重型高位货架、托盘堆栈、叉车作业通道、地面黄黑安全划线、防撞护栏与装卸月台门。',
        'pack': 'hardware-store-and-diy-warehouse',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/23990/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [12.0, 6.0, 16.0],
        'triangles': 422284,
        'license': 'CC0 1.0 Universal',
        'theme': '智能仓储 / AGV 调度 / 库位优化'
    },
    {
        'filename': 'car-assembly-plant-production-line.glb',
        'title': '汽车总装与冲压焊接自动化产线大场景 (Automotive Assembly & Production Line)',
        'summary': '完整汽车工业制造总装线全流程沙盘：大型冲压机、六轴焊接机器人工作站、防尘喷涂房、滑橇连续输送机、安灯灯塔与空中滑轨。',
        'pack': 'car-factory-production-line',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/27866/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [24.0, 8.0, 36.0],
        'triangles': 345948,
        'license': 'CC0 1.0 Universal',
        'theme': 'APS 生产排程 / 复杂多工序装配 / 机器人协同'
    },
    {
        'filename': 'car-factory-welding-framing-cell.glb',
        'title': '机器人焊接定位与冲压进料单元场景 (Framing Cell & Press Feed)',
        'summary': '高密度工装装夹工作岛：含高精度焊接定位夹具、冲压料板架与多台点焊机械臂。',
        'pack': 'car-factory-production-line',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/27864/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [8.0, 4.5, 12.0],
        'triangles': 58240,
        'license': 'CC0 1.0 Universal',
        'theme': 'APS 关键瓶颈工位 / 机器人焊接'
    },
    {
        'filename': 'machine-shop-day-shift-hall.glb',
        'title': '机加工车间与龙门吊厂房大场景 (Day Shift Machine Shop & Crane Hall)',
        'summary': '重型机加工大厂房沙盘：顶部带轨道横梁行车（龙门吊）、立式/卧式 CNC 加工中心群、机床车床、工具柜、铁屑回收车与安全通道。',
        'pack': 'machine-shop-and-factory-hall',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/27790/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [36.0, 9.0, 24.0],
        'triangles': 435580,
        'license': 'CC0 1.0 Universal',
        'theme': 'APS 经典车间排程 (JSSP / FJSP) / 重型加工'
    },
    {
        'filename': 'machine-shop-welding-bay-stores.glb',
        'title': '焊接工段与备件备料库场景 (Welding Bay & Stores Corner)',
        'summary': '机加车间辅工位：配备移动防护屏的焊接工位、气瓶推车、型材料架与备件货架。',
        'pack': 'machine-shop-and-factory-hall',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/27788/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [12.0, 4.0, 8.0],
        'triangles': 24150,
        'license': 'CC0 1.0 Universal',
        'theme': 'APS 人工辅助工序 / 备件缓冲'
    },
    {
        'filename': 'parcel-sorting-hub-logistics-hall.glb',
        'title': '快递物流自动分拣中心大场景 (Parcel Depot & Sorting Logistics Hall)',
        'summary': '大型自动化物流中转枢纽：连续多段动力皮带输送机、倾斜爬坡机、高速扫码称重拱门、多方向分流滑槽、集装笼车与接驳月台。',
        'pack': 'parcel-depot-and-sorting-hall',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/34833/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [24.0, 5.0, 18.0],
        'triangles': 48976,
        'license': 'CC0 1.0 Universal',
        'theme': '物流自动分拣 / 动态路径规划 / 输送线网络'
    },
    {
        'filename': 'conveyor-network-production-floor.glb',
        'title': '自动化连续输送与质检一体化车间 (Conveyor Network Production Floor)',
        'summary': '柔性自动化流水线：闭环与支线输送带、条码识别门架、动态称重单元与机械加工设备的直连布局。',
        'pack': 'factory-conveyor-network',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/26476/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [12.0, 3.9, 12.6],
        'triangles': 2692,
        'license': 'CC0 1.0 Universal',
        'theme': '轻量化快速流水线沙盘 / 输送线调度'
    },
    {
        'filename': 'robotics-workshop-hangar.glb',
        'title': '机器人与无人机研发整备机库大场景 (Robotics Workshop & Drone Hangar)',
        'summary': '未来科技装备研发中心沙盘：地面各类移动机器人停靠位、无线充电桩、整备维修工作台、无人机立式货架与遥测工作站。',
        'pack': 'robots-and-drones-kit',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/39030/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [18.0, 6.0, 15.0],
        'triangles': 50192,
        'license': 'CC0 1.0 Universal',
        'theme': 'MAPF 智能体整备基地 / 多机调度与路径仿真'
    },
    {
        'filename': 'robot-drone-field-test-yard.glb',
        'title': '室外机器人与多机路径测试场场景 (Robot & Drone Field Test Yard)',
        'summary': '开阔空间计算与导航测试场：布置折叠起降坪、全向遥测天线、射灯塔架与地面障碍物标定区。',
        'pack': 'robots-and-drones-kit',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/39028/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [15.0, 4.0, 15.0],
        'triangles': 16800,
        'license': 'CC0 1.0 Universal',
        'theme': 'MAPF 开放网格地图 / 无人机起降航路'
    },
    {
        'filename': 'science-laboratory-cleanroom-floor.glb',
        'title': '科研实验台与洁净分析室完整沙盘 (Science Laboratory & Cleanroom Floor)',
        'summary': '开放式高精密实验大厅：连通式实验工作台群、通风橱系统、生物安全柜、超低温样品库、高速离心分离区与密封风淋通道。',
        'pack': 'science-laboratory-and-cleanroom',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/37185/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [18.0, 2.8, 12.0],
        'triangles': 97496,
        'license': 'CC0 1.0 Universal',
        'theme': '数字孪生实验室 / 科学仪器风格界面'
    },
    {
        'filename': 'data-center-server-operations-compound.glb',
        'title': '密集服务器数据中心与机房运维基地大场景 (Data Centre Server Operations Compound)',
        'summary': '高算力基础设施大场景：整齐排列的密集服务器机柜阵列、天花走线桥架、精密恒温空调制冷机组与电力监控控制室。',
        'pack': 'data-centre-infiltration-kit',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/29277/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [18.0, 3.7, 15.0],
        'triangles': 167268,
        'license': 'CC0 1.0 Universal',
        'theme': '算法算力中心 / 调度集群核心机房'
    },
    {
        'filename': 'nuclear-station-central-control-room-plant.glb',
        'title': '工业中控室大屏与动力车间剖切沙盘 (Central Control Room & Cutaway Plant Floor)',
        'summary': '超大 48×32m 电影级剖切工业沙盘：弧形主控制台群、密集仪表模拟屏、状态预警屏、中央配电盘与大型动力发电机组厂房。',
        'pack': 'nuclear-power-station-and-control-room',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/36945/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [48.3, 12.8, 32.0],
        'triangles': 401988,
        'license': 'CC0 1.0 Universal',
        'theme': '未来工业数字指挥中心 / 全局调度大屏'
    },
    {
        'filename': 'container-freight-inspection-yard.glb',
        'title': '智能集装箱堆场与货运过磅查验大场景 (Container Yard & Customs Inspection Freight)',
        'summary': '大型集装箱物流港区沙盘：大型龙门吊通道、标箱堆叠区、货车过磅台、查验棚区与通道进出卡口闸机。',
        'pack': 'container-inspection-and-customs-yard',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/29328/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [30.0, 8.0, 24.0],
        'triangles': 185600,
        'license': 'CC0 1.0 Universal',
        'theme': '堆场调度 / 集装箱配载 / 重型物流'
    },
    {
        'filename': 'vertical-farm-automated-storage-packhouse.glb',
        'title': '垂直立体密集仓储与穿梭车包装车间大场景 (Vertical Automated Storage & Packhouse)',
        'summary': '现代密集立体仓储与包装沙盘：多层密集式立库钢结构货架、穿梭车（Shuttle）导轨系统与下游自动输送打包线。',
        'pack': 'vertical-farm-and-hydroponics-tower',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/38401/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [16.0, 6.5, 14.0],
        'triangles': 216576,
        'license': 'CC0 1.0 Universal',
        'theme': '密集立库 (AS/RS) / 四向穿梭车调度'
    },
    {
        'filename': 'automated-food-processing-confectionery-line.glb',
        'title': '自动化连续食品流水线工厂大场景 (Automated Continuous Food Processing Line)',
        'summary': '连续制造工厂全流程沙盘：原料投料仓、反应混合釜、连续传送成型线、冷却风洞隧道与装箱打包码垛工段。',
        'pack': 'chocolate-and-confectionery-factory',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/36811/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [25.0, 4.5, 15.0],
        'triangles': 143510,
        'license': 'CC0 1.0 Universal',
        'theme': '流程型与混合型 APS 排程 / 管道连续流'
    },
    {
        'filename': 'trade-counter-and-paint-mixing.glb',
        'title': '物流发件服务台与工作站场景 (Trade Counter & Dispatch Workstation)',
        'summary': '分拣末端配套场景：包含接待服务柜台、手持终端充电台、小件料盒柜与操作工位。',
        'pack': 'hardware-store-and-diy-warehouse',
        'cdnUrl': 'https://cdn.3dassets.dev/assets/23988/v1/model.glb',
        'category': 'assembled-scenes',
        'sizeMeters': [8.0, 3.5, 6.0],
        'triangles': 18500,
        'license': 'CC0 1.0 Universal',
        'theme': '物流出入库台 / 人工交接站'
    }
]

def download_scene(item):
    filename = item['filename']
    dest = os.path.join(TARGET_DIR, filename)
    url = item['cdnUrl']
    
    if os.path.exists(dest) and os.path.getsize(dest) > 100:
        with open(dest, 'rb') as f:
            if f.read(4) == b'glTF':
                return True, filename, os.path.getsize(dest)
                
    tmp = dest + '.tmp'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'})
    
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, 'wb') as out_f:
                chunk = resp.read(65536)
                while chunk:
                    out_f.write(chunk)
                    chunk = resp.read(65536)
            with open(tmp, 'rb') as f:
                if f.read(4) != b'glTF':
                    raise ValueError('Invalid glTF header')
            os.replace(tmp, dest)
            return True, filename, os.path.getsize(dest)
        except Exception as e:
            if os.path.exists(tmp):
                os.remove(tmp)
            if attempt == 2:
                return False, filename, str(e)
            time.sleep(2)

def main():
    print(f"Downloading {len(SCENES)} large assembled scenes to {TARGET_DIR}...")
    start = time.time()
    total_bytes = 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = [ex.submit(download_scene, s) for s in SCENES]
        for f in futures:
            ok, name, info = f.result()
            if ok:
                total_bytes += info
                print(f"  ✓ {name} ({info/(1024*1024):.2f} MB)")
            else:
                print(f"  ✗ {name}: {info}")
                
    print(f"Finished in {time.time()-start:.1f}s. Total: {total_bytes/(1024*1024):.2f} MB")
    
    # Update ASSET-CATALOG.json
    if os.path.exists(CATALOG_PATH):
        with open(CATALOG_PATH, 'r', encoding='utf-8') as f:
            cat = json.load(f)
            
        # Add or update assembled-scenes in catalog
        cat['categories']['assembled-scenes'] = len(SCENES)
        
        # Remove any existing assembled-scenes entries
        existing_assets = [a for a in cat.get('assets', []) if a.get('category') != 'assembled-scenes']
        
        for s in SCENES:
            local_file = os.path.join(TARGET_DIR, s['filename'])
            fsize = os.path.getsize(local_file) if os.path.exists(local_file) else 0
            entry = {
                'id': s['filename'].replace('.glb', ''),
                'slug': s['filename'].replace('.glb', ''),
                'title': s['title'],
                'summary': s['summary'],
                'category': 'assembled-scenes',
                'pack': s['pack'],
                'filename': s['filename'],
                'rel_path': f"assembled-scenes/{s['filename']}",
                'cdnUrl': s['cdnUrl'],
                'stats': {
                    'fileSize': fsize,
                    'triangles': s['triangles']
                },
                'sizeMeters': s['sizeMeters'],
                'theme': s['theme'],
                'license': s['license']
            }
            existing_assets.append(entry)
            
        cat['assets'] = existing_assets
        cat['totalAssets'] = len(existing_assets)
        
        with open(CATALOG_PATH, 'w', encoding='utf-8') as f:
            json.dump(cat, f, indent=2, ensure_ascii=False)
            
        print(f"Updated {CATALOG_PATH} with {len(SCENES)} assembled scenes!")

if __name__ == '__main__':
    main()
