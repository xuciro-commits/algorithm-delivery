# 3D / HDR / visual-reference asset register

**Scope:** assets shipped by the current lab build. This register intentionally separates original in-repository work from candidate references that were investigated but not downloaded. No third-party model URL is used at runtime.

## Shipped assets

| Asset / use | Source / author | License and redistribution limits | Local path / format / size | Optimized / processing |
|---|---|---|---|---|
| Industrial warehouse image-based lighting (PBR reflections; not a background plate) | Original procedural panorama authored for Algorithm Delivery by `generate-warehouse-hdri.py`; no third-party pixels, scans, or textures | No external license or attribution dependency. The repository currently has no root `LICENSE`; redistribution of the project remains subject to the project owner's licensing decision. | `lab/src/assets/warehouse-studio.hdr` · Radiance RGBE, 512×256 · 191,915 bytes | RLE RGBE; low-resolution local asset; generated deterministically by `lab/scripts/generate-warehouse-hdri.py`; configured for local Drei/Three.js PMREM image-based lighting, not fetched from a third-party host (browser PMREM/render still awaits production acceptance) |
| Modular warehouse / racking / cargo / dock envelope | Original Three.js instanced geometry, authored in repository | Project source; no external model or texture license. The root project currently does not publish a license, so no broader distribution grant is implied. | `lab/src/components/sandbox/WarehouseEnvironment.tsx` · TypeScript/Three.js | Shared instanced box geometry/material families; detailed bays capped at 180 before still rendering remaining occupied cells as compact rack modules |
| APS factory hall / guard rail / roller conveyor | Original Three.js instanced geometry, authored in repository | Project source; no external model or texture license. Conveyor is static infrastructure; no workpiece behavior is fabricated. | `lab/src/components/sandbox/FactoryEnvironment.tsx` · TypeScript/Three.js | Reused instanced structural parts and rollers; no external textures |
| AGV mobile robot | Original parametric Three.js model, authored in repository | Project source; no external model or texture license. Payload appears only when the engine's real task phase reports a loaded vehicle. | `lab/src/components/sandbox/AgvUnit.tsx` · TypeScript/Three.js geometry/materials | Reuses materials per model instance; no downloaded mesh or texture |
| MAPF mobile robot | Original parametric Three.js model, authored in repository | Project source; no external model or texture license. Pose remains driven by the MAPF solution/time model. | `lab/src/components/sandbox/RobotUnit.tsx` · TypeScript/Three.js geometry/materials | Reuses materials; no downloaded mesh or texture |
| APS machining cell | Original parametric Three.js model, authored in repository | Project source; no external model or texture license. Active workpiece and status derive from the real APS schedule. | `lab/src/components/sandbox/MachineUnit.tsx` · TypeScript/Three.js geometry/materials | Reuses PBR materials; no downloaded mesh or texture |
| Industrial micro-warehouse preset | Algorithm problem data written for this project; not a mesh asset | Repository test/example data; no third-party scene content. Its routes are produced only by the AGV engine. | `agv/mock/warehouse-studio.json` · JSON · 2 vehicles / 3 tasks / 18×12 grid | `lab/scripts/test-agv-problem.mjs` asserts parse/precheck and a real `FEASIBLE` + verified 3-task result when synchronized WASM is available; the engine assertion has not yet run in this checkout |
| MAPF warehouse-aisle preset | Algorithm problem data written for this project; not a mesh asset | Repository test/example data; no third-party scene content. Its paths are produced only by the MAPF engine. | `mapf/mock/m00-warehouse-aisles.json` · JSON · 3 robots / 12×9 grid | `lab/scripts/test-mapf-scene.mjs` asserts roundtrip/precheck when synchronized mocks are available; real engine solving is covered by visual acceptance, not yet run in this checkout |

## Design references (reference-only; not production meshes)

The three concept images already exist in the repository and are copied into the visual-acceptance artifact. The production UI does not load them as scene textures.

| Reference | Existing path | Size | Creator / license metadata |
|---|---|---:|---|
| AGV warehouse concept | `lab/design/concepts/agv-lab-concept.png` | 2,176,658 bytes | Not recorded in the repository. Treat as a design reference only; its original creator and redistribution grant must be confirmed by the project owner before the image is republished outside this repository. |
| APS production-line concept | `lab/design/concepts/aps-lab-concept.png` | 1,847,254 bytes | Not recorded in the repository. Treat as a design reference only; its original creator and redistribution grant must be confirmed by the project owner before the image is republished outside this repository. |
| MAPF spatial-computing concept | `lab/design/concepts/mapf-lab-concept.png` | 1,861,459 bytes | Not recorded in the repository. Treat as a design reference only; its original creator and redistribution grant must be confirmed by the project owner before the image is republished outside this repository. |

## Investigated but not shipped

## Downloaded 3D model library (3dassets.dev / CC0 1.0 Universal)

A comprehensive set of **475 optimized low-poly GLB models and 16 pre-assembled large scenes** downloaded via the `3dassets` MCP tool and categorized under `lab/design/assets/` for AI 3D modeling and visual prototyping. All assets use the **CC0 1.0 Universal** dedication (free personal and commercial use without attribution). Complete machine-readable metadata is recorded in [`ASSET-CATALOG.json`](./ASSET-CATALOG.json) and browsable in [`README.md`](./README.md).

| Category | Path | Model count | Description & key assets |
|---|---|---:|---|
| **Pre-Assembled Large Scenes** | `lab/design/assets/assembled-scenes/` | **16** | 完整大场景沙盘：机加工龙门吊厂房、汽车总装流水线、高位立体仓库、物流自动分拣中心、机器人研发机库、数据中心机房、中控室大屏与密集立库等，可一键整体载入后按需增删 |
| **AGV & Smart Warehouse** | `lab/design/assets/agv-warehouse/` | 110 | Low-profile AGV loaders, movers, tuggers, forklifts, pallet trucks, pallet racking, cantilever racks, stillages, cargo pallets, safety barriers, charging stations |
| **APS Machining & Manufacturing** | `lab/design/assets/aps-machining/` | 112 | CNC machining centres, engine lathes, vertical mills, hydraulic presses, press brakes, 6-axis welding robots, andon light towers, gantry cranes, workpieces |
| **Conveyors & Sorting** | `lab/design/assets/conveyors-logistics/` | 123 | Powered belt conveyors, free roller conveyors, curve conveyors, 3-way splitters, 4-way junctions, barcode scanners, weighing conveyors, vertical pallet lifts |
| **Digital Lab & Cleanroom** | `lab/design/assets/lab-cleanroom/` | 63 | Modular lab benches, fume cupboards, biosafety cabinets, air showers, centrifuges, autoclaves, incubators, analytical balances, test tube racks |
| **MAPF Mobile Robots & Telemetry** | `lab/design/assets/mapf-robotics/` | 51 | Biped service robots, patrol bots, delivery bots, quadrupeds, 4WD/6WD rovers, tracked UGVs, robot arms, antenna trackers, round/square charging pads |

## Acceptance notes

- A project-level software license is not present in this checkout. The local original assets have no third-party redistribution restrictions, but downstream reuse should follow the license selected by the repository owner.
- The 459 GLB models in `lab/design/assets/` are under CC0 1.0 Universal. They can be safely loaded into Three.js/R3F scenes without remote network requests or attribution obligations.
- The concept PNG creator/license metadata is an open documentation gap. Their presence in the existing repository is confirmed; this register does **not** infer ownership from presence.
- No external GLB, JPG, EXR, HDR, font, or texture is loaded by the running app. The only environment map is bundled under `lab/src/assets`.

