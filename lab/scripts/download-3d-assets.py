#!/usr/bin/env python3
"""
Download and categorize 3D assets from 3dassets.dev for Algorithm Lab.
Organizes GLB assets into categorized subdirectories under lab/design/assets/:
 - agv-warehouse/
 - aps-machining/
 - mapf-robotics/
 - conveyors-logistics/
 - lab-cleanroom/
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict

PACK_FILES = [
    'steps/52/output.txt', # robots-and-drones-kit
    'steps/58/output.txt', # car-factory-production-line
    'steps/62/output.txt', # machine-shop-and-factory-hall
    'steps/66/output.txt', # factory-conveyor-network
    'steps/70/output.txt', # hardware-store-and-diy-warehouse
    'steps/98/output.txt', # parcel-depot-and-sorting-hall
    'steps/99/output.txt'  # science-laboratory-and-cleanroom
]

# 路径全部相对于仓库，避免把个人机器的绝对路径写进共享脚本。
# 素材包清单（PACK_FILES）来自 3dassets.dev 的导出快照，可用环境变量指向别处的副本：
#   LAB_ASSET_PACK_DIR=/path/to/.system_generated python3 lab/scripts/download-3d-assets.py
HERE = os.path.dirname(os.path.abspath(__file__))
TARGET_BASE = os.path.normpath(os.path.join(HERE, '..', 'design', 'assets'))
BRAIN_DIR = os.environ.get(
    'LAB_ASSET_PACK_DIR',
    os.path.join(HERE, '.asset-packs'),  # 默认放在 scripts/.asset-packs（已在 .gitignore 之外，仅本地缓存）
)
if BRAIN_DIR and not BRAIN_DIR.endswith(os.sep):
    BRAIN_DIR += os.sep

def classify_asset(a, pack_slug):
    slug = a['slug']
    title = a.get('title', '')
    desc = (title + ' ' + a.get('summary', '') + ' ' + a.get('description', '')).lower()
    
    if 'starter-scene' in slug:
        return None
        
    if pack_slug == 'science-laboratory-and-cleanroom':
        return 'lab-cleanroom'
        
    if pack_slug == 'factory-conveyor-network':
        if any(m in desc for m in ['lathe', 'drill', 'press', 'milling', 'furnace', 'crusher', 'saw', 'grinder', 'vessel']):
            return 'aps-machining'
        return 'conveyors-logistics'
        
    if pack_slug == 'robots-and-drones-kit':
        if 'agv' in slug:
            return 'agv-warehouse'
        return 'mapf-robotics'
        
    if pack_slug == 'machine-shop-and-factory-hall':
        if any(k in desc for k in ['forklift', 'pallet truck', 'pallet racking', 'concrete floor tile', 'safety bollard']):
            return 'agv-warehouse'
        return 'aps-machining'
        
    if pack_slug == 'car-factory-production-line':
        if any(k in desc for k in ['agv', 'forklift', 'tugger', 'pallet', 'stillage', 'kitting cart', 'empty pallet']):
            return 'agv-warehouse'
        elif any(k in desc for k in ['conveyor', 'rail']):
            return 'conveyors-logistics'
        elif any(k in desc for k in ['worker', 'inspector', 'supervisor', 'driver', 'hatchback']):
            return None
        return 'aps-machining'
        
    if pack_slug == 'parcel-depot-and-sorting-hall':
        if any(k in desc for k in ['conveyor', 'chute', 'diverter', 'scanner', 'weigh']):
            return 'conveyors-logistics'
        elif any(k in desc for k in ['forklift', 'pallet', 'cage', 'dock', 'door', 'truck', 'trolley']):
            return 'agv-warehouse'
        return None
        
    if pack_slug == 'hardware-store-and-diy-warehouse':
        if any(k in desc for k in ['rack', 'pallet', 'forklift', 'barrier', 'dock', 'door', 'marking', 'trolley', 'cage', 'column', 'fastener bin', 'stillage']):
            return 'agv-warehouse'
        return None
        
    return None

def download_one(asset):
    cdn_url = asset['cdnUrl']
    dest_path = asset['local_path']
    
    # If already downloaded and valid gltf, skip
    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 100:
        with open(dest_path, 'rb') as f:
            if f.read(4) == b'glTF':
                return True, dest_path, 0
                
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    tmp_path = dest_path + '.tmp'
    
    req = urllib.request.Request(
        cdn_url,
        headers={'User-Agent': 'Mozilla/5.0 (compatible; AlgorithmLabAssetFetcher/1.0)'}
    )
    
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp, open(tmp_path, 'wb') as out_f:
                chunk = resp.read(65536)
                while chunk:
                    out_f.write(chunk)
                    chunk = resp.read(65536)
            
            # Verify glTF header
            with open(tmp_path, 'rb') as f:
                header = f.read(4)
                if header != b'glTF':
                    raise ValueError(f"Invalid glTF header: {header}")
                    
            os.replace(tmp_path, dest_path)
            return True, dest_path, os.path.getsize(dest_path)
        except Exception as e:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            if attempt == 2:
                return False, dest_path, str(e)
            time.sleep(1)

def main():
    seen_slugs = set()
    classified_assets = []
    
    for pf in PACK_FILES:
        filepath = os.path.join(BRAIN_DIR, pf)
        if not os.path.exists(filepath):
            print(f"Warning: {filepath} does not exist")
            continue
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
            pack_slug = data.get('slug')
            for a in data.get('assets', []):
                slug = a['slug']
                if slug in seen_slugs:
                    continue
                seen_slugs.add(slug)
                
                cat = classify_asset(a, pack_slug)
                if not cat:
                    continue
                    
                sub_slug = slug.replace(pack_slug + '-', '')
                filename = f"{sub_slug}.glb"
                local_path = os.path.join(TARGET_BASE, cat, filename)
                
                item = {
                    'id': a.get('id'),
                    'slug': slug,
                    'title': a.get('title'),
                    'summary': a.get('summary'),
                    'category': cat,
                    'pack': pack_slug,
                    'filename': filename,
                    'local_path': local_path,
                    'rel_path': f"{cat}/{filename}",
                    'cdnUrl': a.get('cdnUrl'),
                    'downloadUrl': a.get('downloadUrl'),
                    'stats': a.get('stats', {}),
                    'sizeMeters': a.get('sizeMeters', a.get('stats', {}).get('sizeMeters')),
                    'animated': a.get('animated', False),
                    'animations': a.get('stats', {}).get('animations', []),
                    'license': a.get('license', {}).get('name', 'CC0 1.0 Universal'),
                    'aiGenerated': a.get('aiGenerated', True),
                    'aiModel': a.get('aiModel')
                }
                classified_assets.append(item)

    print(f"Total categorized assets to download: {len(classified_assets)}")
    by_cat = defaultdict(int)
    for a in classified_assets:
        by_cat[a['category']] += 1
    for cat, cnt in sorted(by_cat.items()):
        print(f" - {cat}: {cnt} assets")
        
    start_time = time.time()
    success_count = 0
    fail_count = 0
    total_bytes = 0
    
    print("\nStarting concurrent download (16 workers)...")
    with ThreadPoolExecutor(max_workers=16) as executor:
        futures = {executor.submit(download_one, a): a for a in classified_assets}
        for i, fut in enumerate(as_completed(futures), 1):
            success, path, info = fut.result()
            if success:
                success_count += 1
                total_bytes += info
            else:
                fail_count += 1
                print(f"FAILED: {path}: {info}")
            if i % 50 == 0 or i == len(classified_assets):
                elapsed = time.time() - start_time
                print(f"Progress: {i}/{len(classified_assets)} ({success_count} ok, {fail_count} failed) in {elapsed:.1f}s")
                
    elapsed = time.time() - start_time
    print(f"\nDownload finished in {elapsed:.1f}s. Total size: {total_bytes / (1024*1024):.2f} MB")
    
    # Save ASSET-CATALOG.json
    catalog_path = os.path.join(TARGET_BASE, 'ASSET-CATALOG.json')
    # strip absolute local_path for portability
    catalog_data = []
    for a in classified_assets:
        entry = dict(a)
        del entry['local_path']
        catalog_data.append(entry)
        
    with open(catalog_path, 'w', encoding='utf-8') as f:
        json.dump({
            'version': '1.0.0',
            'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'totalAssets': len(catalog_data),
            'categories': dict(by_cat),
            'assets': catalog_data
        }, f, indent=2, ensure_ascii=False)
        
    print(f"Catalog saved to {catalog_path}")

if __name__ == '__main__':
    main()
