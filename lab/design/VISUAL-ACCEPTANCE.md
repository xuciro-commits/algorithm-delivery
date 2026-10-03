# APS / MAPF / AGV 真实三维视觉验收

## 当前 M0 状态（不代表已通过）

- 仓库中的 `VISUAL-DIRECTION-V2.md` 将三实验室视觉方向记录为 2026-10 已确认；原始概念图已存在于 `design/concepts/`。
- 本分支现有 AGV 仓库原型、HDRI 与 Three.js 场景改造尚未取得 production build 的浏览器截图，也尚未进行真实桌面 GPU 审查。因此 **AGV M0 视觉实现验收仍未通过 / 待验收**。
- APS 新增的求解前工厂舞台只是小型静态预览，不能视作 APS 实现完成。AGV M0 的真实浏览器验收和人工方向确认前，暂停继续扩大 APS / MAPF 的视觉重构范围。
- 当前沙箱没有 Rust/Cargo 工具链，也没有已同步的引擎 WASM。这里的 `npm run build` 因缺少 `aps/rust/dist/aps_engine.wasm` 在同步阶段停止；未生成 production `dist`、浏览器截图或报告。不要把下方流程描述成已实际通过。
- 单独验证了 HDR 文件可被 Three.js `RGBELoader` 解码为 512×256 RGBA 浮点样本，且生成脚本可复现相同 SHA-256；这**不等于**浏览器 PMREM、WebGL 场景或 PBR 画质验收通过。

## CI 真实构建浏览器验收

`.github/workflows/lab.yml` 中独立的 `visual-acceptance` job 调用 `.github/workflows/lab-visual-acceptance.yml`，依赖本次 `build-lab` 并下载同一次运行的真实 production `lab-preview` 后再运行 Playwright。该可复用工作流在 Ubuntu Runner 上运行，不会生成替代画面或算法结果。

Ubuntu runner 的浏览器安装命令固定为：

```sh
npx playwright install --with-deps chromium
```

随后运行：

```sh
npm run test:visual
```

本地手动执行需要先准备由实际 APS / MAPF / AGV 引擎构建产生的同步资产，并完成生产构建；禁止用 stub、fixture 路径或预制图片替代该流程。

### 检查和证据

每个模块均访问真实的 hash route，并检查：

1. Three.js `WebGLRenderer` 创建的 canvas 可见，且 WebGL context 存在、未丢失；
2. R3F 场景具有可见 mesh、三角形与 draw calls，本地 `.hdr` 环境贴图已初始化，canvas 与 drawing buffer 尺寸合理；
3. 对真实 canvas 截图做亮度、背景差异像素统计，拒绝全黑或近乎空白场景；
4. 点击原有运行控件，由真实引擎完成求解，页面中的 solution status 与操作 / agent / vehicle 数量发生真实变化且达到 `FEASIBLE` 或 `OPTIMAL`；
5. 通过真实滚轮操作缩放相机，检查镜头数据确实改变后再采集模型细节；
6. 记录页面异常、浏览器 console error、失败网络请求与 HTTP 错误。任一严重错误使模块失败，但仍尽量保留失败截图。

每个模块目标三张图，共九张：

- `*-01-full-scene.png`：求解前已加载的完整场景；
- `*-02-model-detail.png`：由 OrbitControls 缩放后的细节（非裁切放大、非替代图）；
- `*-03-running-state.png`：实际引擎返回可行方案后的页面状态。

报告将已有的 `design/concepts/{aps,mapf,agv}-lab-concept.png` 与运行截图并排展示，供人工审查，不会伪造数值相似度或自动宣称美术通过。

### GitHub Actions Artifact

成功或失败都尝试上传 `lab/artifacts/visual/`（30 天）：

```text
visual-comparison.html
visual-summary.json
runner-error.txt                    # runner / build / browser 层失败时可能存在
references/*.png                    # 仓库内三张真实概念图
APS/{aps-01-full-scene.png, aps-02-model-detail.png, aps-03-running-state.png, aps-console.json, ...}
MAPF/{mapf-01-full-scene.png, mapf-02-model-detail.png, mapf-03-running-state.png, mapf-console.json, ...}
AGV/{agv-01-full-scene.png, agv-02-model-detail.png, agv-03-running-state.png, agv-console.json, ...}
```

成功截图、报告和控制台日志目前均尚未生成。`lab/artifacts/` 已加入 `.gitignore`，避免把构建截图写进源码提交。

## 对照参考图的人工审查清单

对每组实际截图与概念图逐项记录“符合 / 偏差 / 阻塞”，不要把画面主题相似误判为实体模型通过：

- 机械比例、AGV 底盘 / 轮子 / 传感器、货架梁柱 / 载荷、APS 设备工作空间和工厂空间关系是否可信；
- 实际货架、通道、工位和算法栅格 / 路径 / 停靠位置之间的比例与对齐；
- PBR 金属、涂层、橡胶、纸箱等是否能在真实环境贴图和灯光下区分，是否产生错误的高光、穿插或阴影伪影；
- 相机取景是否能同时读出空间布局和设备细节；窄屏、放大与超大场景是否被裁切；
- 运行前后是否仅出现引擎真实返回的数据，没有静态伪造路径 / 工件 / 状态。

**不要**用软件 GPU CI 的截图代替实体桌面 GPU 的画质或帧率结论。M0 需要在实际桌面 Chromium（并适当覆盖 Firefox / Safari）上由人工确认场景外观与交互；性能记录必须附 OS、浏览器版本、GPU / 驱动、分辨率、DPR、场景规模及测量方法。

## 桌面验收仍需完成

- 取得 CI Artifact 后，先由用户确认 AGV 视觉方向，再决定是否扩展 APS / MAPF；
- 用实际硬件加速浏览器检查材质反射、阴影、密度、加载稳定性及 60 秒连续播放表现；记录场景规模和帧率，不从 CI 推断；
- 回归编辑、求解、核验、回放、缩放、2D / 3D 切换与窗口尺寸变化；确认路径、车辆姿态、工序区间仍受真实引擎输出驱动；
- 补齐三张已提交概念图的创作者 / 发布许可记录（见 `assets/ASSET-REGISTER.md`），再决定视觉验收 Artifact 的外部再分发范围。
