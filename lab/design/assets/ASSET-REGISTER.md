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

| Candidate | Source / author / license | Decision |
|---|---|---|
| Poly Haven `Machine Shop 01` indoor HDRI | [polyhaven.com/a/machine_shop_01](https://polyhaven.com/a/machine_shop_01) · page credits Sergej Majboroda · CC0 according to the source page | Not copied into the build. The sandbox's direct binary download attempt ended with a TLS connection failure; using a live third-party URL would violate the offline/local-asset requirement. The current environment uses the original local HDR panorama above instead. No author credit is required for the unshipped candidate. |
| Sketchfab / other downloadable industrial GLB candidates | No model with a verified redistribution grant and locally obtained source file was accepted for this iteration | Not shipped; no remote runtime dependency or unverifiable model is used. The rack, AGV, machine and conveyor are custom procedural geometry until a suitable model's exact author/license and redistribution conditions are reviewed. |

## Acceptance notes

- A project-level software license is not present in this checkout. The local original assets have no third-party redistribution restrictions, but downstream reuse should follow the license selected by the repository owner.
- The concept PNG creator/license metadata is an open documentation gap. Their presence in the existing repository is confirmed; this register does **not** infer ownership from presence.
- No external GLB, JPG, EXR, HDR, font, or texture is loaded by the running app. The only environment map is bundled under `lab/src/assets`.
