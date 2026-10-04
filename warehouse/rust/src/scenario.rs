//! 标准场景库：S01–S24（库位）/ D01–D24（调度）/ E01–E14（事件与异常）/
//! J01–J12（联合）/ X01–X12（压力与边界），共 86 个场景。
//!
//! 每个场景都是**可执行的问题文档生成器**（不是文档里的表格）：`build(id)` 返回完整的问题 JSON，
//! `expectation(id)` 返回验收判据（期望状态、必须通过的验证、必须出现的现象）。
//! 这样"场景 → 验收"是一条可自动执行的链路，而不是靠人读需求文档。

use aps_engine::json::Json;

use crate::contract::{
    AsrsProblem, DemandProfile, DispatchConfig, InventoryUnit, SlottingProblem,
};
use crate::errors::{codes, Issues};
use crate::util::round;
use crate::wh::catalog::{default_hourly_factor, generate_catalog, generate_orders, preset, CatalogParams, OrderParams};
use crate::wh::topology::{build_topology, topology_to_json, TopologyParams, TopologyTemplate};

/// 场景族（对应 SRS 的五个分组）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Slotting,
    Dispatch,
    Event,
    Joint,
    Stress,
}

impl Family {
    pub fn as_str(self) -> &'static str {
        match self {
            Family::Slotting => "slotting",
            Family::Dispatch => "dispatch",
            Family::Event => "event",
            Family::Joint => "joint",
            Family::Stress => "stress",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Family::Slotting => "库位优化（S 系列）",
            Family::Dispatch => "立库调度（D 系列）",
            Family::Event => "事件与异常（E 系列）",
            Family::Joint => "联合优化（J 系列）",
            Family::Stress => "压力与边界（X 系列）",
        }
    }
}

/// 场景定义（数据表；生成器与验收器共用）。
#[derive(Debug, Clone)]
pub struct ScenarioSpec {
    pub id: &'static str,
    pub family: Family,
    pub name: &'static str,
    pub goal: &'static str,
    /// 拓扑模板
    pub template: TopologyTemplate,
    /// 目录形态（preset 名）
    pub catalog: &'static str,
    /// 算法（库位 / 调度）
    pub algorithm: &'static str,
    /// 规模键：tiny / small / medium / large / extreme
    pub scale: &'static str,
    /// 验收判据
    pub expect: &'static str,
    /// 需要强制出现的现象（验收器逐条核对）
    pub must_show: &'static [&'static str],
}

const fn spec(
    id: &'static str,
    family: Family,
    name: &'static str,
    goal: &'static str,
    template: TopologyTemplate,
    catalog: &'static str,
    algorithm: &'static str,
    scale: &'static str,
    expect: &'static str,
    must_show: &'static [&'static str],
) -> ScenarioSpec {
    ScenarioSpec {
        id,
        family,
        name,
        goal,
        template,
        catalog,
        algorithm,
        scale,
        expect,
        must_show,
    }
}

use TopologyTemplate as T;

/// 86 个标准场景（S01–S24 / D01–D24 / E01–E14 / J01–J12 / X01–X12）。
pub const SCENARIOS: &[ScenarioSpec] = &[
    // ---------------- S 系列：库位优化（24） ----------------
    spec("S01", Family::Slotting, "随机储位 vs 优化储位（小规模）", "建立基线：同一问题下随机/固定/最近可用/ABC/周转率/COI 与 ALNS 的对比", T::AsrsSingleDeep, "abc-mixed", "alns", "small", "FEASIBLE_WITH_BOUND + 验证通过 + 至少优于 random 与 fixed 基线", &["comparison", "explanation"]),
    spec("S02", Family::Slotting, "ABC 分区与周转率排序对照", "验证经典做法在该仓型下的实际收益", T::AsrsSingleDeep, "abc-mixed", "abc-class", "small", "FEASIBLE 且给出与 turnover/coi 的差值", &["comparison"]),
    spec("S03", Family::Slotting, "关联性储位（共同出库）", "关联簇必须被压到相邻库位，减少跨巷道往返", T::AsrsSingleDeep, "affinity-clusters", "alns", "medium", "关联一致性优于随机基线（affinityCoherence 更小）", &["explanation"]),
    spec("S04", Family::Slotting, "尺寸与容积匹配", "大件/小件必须落到容积匹配的库位，禁止溢出", T::AsrsSingleDeep, "oversized-mix", "alns", "small", "无 LOCATION_VOLUME_LIMIT 违规", &[]),
    spec("S05", Family::Slotting, "承载限制（重货不上高层）", "重货必须避开承重不足的库位", T::AsrsSingleDeep, "heavy-oversized", "alns", "small", "无 LOCATION_WEIGHT_LIMIT 违规", &[]),
    spec("S06", Family::Slotting, "温控与危险品分区", "分区兼容约束必须生效（冷链/危化独立区）", T::AsrsHybridMultiArea, "chilled-mix", "alns", "small", "无 ZONE_COMPATIBILITY 违规", &[]),
    spec("S07", Family::Slotting, "COI 立方体-周转率排序", "COI 作为经典规则的对照", T::AsrsSingleDeep, "abc-mixed", "coi", "small", "FEASIBLE 且给出 COI 与 ALNS 的差距", &["comparison"]),
    spec("S08", Family::Slotting, "分区容量分级", "分区容量上限被突破时必须外溢而非报错", T::AsrsSingleDeep, "abc-mixed", "class-based", "small", "FEASIBLE 且外溢数量被如实报告", &[]),
    spec("S09", Family::Slotting, "同 SKU 分散抗故障", "同一 SKU 不许全压在同一巷道", T::AsrsSingleDeep, "abc-mixed", "dispersion", "small", "分散度指标被报告", &[]),
    spec("S10", Family::Slotting, "多深位前排优先", "A 类商品不许放深位（front-only 策略）", T::AsrsMultiDeep, "abc-mixed", "alns", "small", "front-only 下无 DEEP_LANE_BLOCKING", &[]),
    spec("S11", Family::Slotting, "双深位倒垛代价敏感", "深位方案的搬迁代价必须包含倒垛", T::AsrsDoubleDeep, "abc-mixed", "alns", "medium", "relocationDeviceSeconds > 0 且被计入目标", &[]),
    spec("S12", Family::Slotting, "动态需求（季节性）", "需求变化后库位方案被增量调整", T::AsrsSingleDeep, "seasonal-promo", "dynamic", "medium", "事件被留痕且搬迁在预算内", &["explanation"]),
    spec("S13", Family::Slotting, "多目标 Pareto（时间 vs 搬迁）", "输出 Pareto 前沿而非单一解", T::AsrsSingleDeep, "abc-mixed", "nsga2", "small", "pareto 非空且每个点带证据", &["pareto"]),
    spec("S14", Family::Slotting, "鲁棒优化（需求不确定）", "最坏情景与 CVaR 被显式优化", T::AsrsSingleDeep, "bimodal-peak", "robust", "medium", "robust 报告含 mean/worst/cvar", &["explanation"]),
    spec("S15", Family::Slotting, "长尾需求", "长尾商品不应占据近端库位", T::AsrsSingleDeep, "oversized-mix", "alns", "medium", "长尾商品的库位代价高于头部", &[]),
    spec("S16", Family::Slotting, "容量紧张（97% 占用）", "接近占满时仍给出可行解或明确的不可行证明", T::AsrsSingleDeep, "abc-mixed", "alns", "small", "状态为 FEASIBLE/带界，或 INFEASIBLE_PROVEN 并给出容量证明", &[]),
    spec("S17", Family::Slotting, "库存大于库位（不可行证明）", "容量下界证明必须能给出", T::AsrsSingleDeep, "abc-mixed", "alns", "small", "INFEASIBLE_PROVEN 且给出\"库位<货\"的证明", &[]),
    spec("S18", Family::Slotting, "库位冻结", "冻结库位不参与优化，且原货物被搬出", T::AsrsSingleDeep, "abc-mixed", "alns", "small", "无 LOCATION_FROZEN 违规且冻结数被报告", &[]),
    spec("S19", Family::Slotting, "预算耗尽但有解", "超时返回当前最好可行解，状态为 BUDGET_EXCEEDED", T::AsrsSingleDeep, "abc-mixed", "alns", "small", "budgetExceeded=true 且解仍然可行", &[]),
    spec("S20", Family::Slotting, "预算耗尽且无解", "无解 ≠ 不可行：必须区分 NO_SOLUTION_FOUND 与 INFEASIBLE_PROVEN", T::AsrsSingleDeep, "abc-mixed", "alns", "small", "状态语义与 issue 说明一致", &[]),
    spec("S21", Family::Slotting, "精确解可证明（小规模）", "小规模上线性分派的最优性被证明", T::AsrsSingleDeep, "uniform-small", "alns", "tiny", "OPTIMAL_PROVEN + 下界=目标值", &["bound"]),
    spec("S22", Family::Slotting, "多随机种子稳定性", "不同种子结果波动被如实报告", T::AsrsSingleDeep, "abc-mixed", "alns", "small", "stability 与多种子目标被报告", &["stability"]),
    spec("S23", Family::Slotting, "人工拣选区混合（无自动化）", "人工区容量与自动化区分别处理", T::ManualHybrid, "abc-mixed", "alns", "small", "无设备可用时仍能给出库位方案", &[]),
    spec("S24", Family::Slotting, "搬迁预算受限", "搬迁件数/设备秒数不超预算", T::AsrsSingleDeep, "abc-mixed", "alns", "medium", "task 数 ≤ 预算，其余降级为 suggestion", &["migrationBudget"]),

    // ---------------- D 系列：立库调度（24） ----------------
    spec("D01", Family::Dispatch, "单巷道单层（基线）", "最小可运行调度：一条巷道一台车", T::AsrsSingleDeep, "abc-mixed", "fifo", "tiny", "全部任务完成 + 验证通过", &["timeline"]),
    spec("D02", Family::Dispatch, "单巷道多层（提升机瓶颈）", "提升机成为瓶颈时的时间分布", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "提升机利用率被报告", &["deviceUtilization"]),
    spec("D03", Family::Dispatch, "多巷道并行", "多巷道之间的负载均衡", T::AsrsSingleDeep, "abc-mixed", "nearest-device", "small", "巷道间负载差异被报告", &[]),
    spec("D04", Family::Dispatch, "双深位倒垛", "目标深位被挡时先倒垛", T::AsrsDoubleDeep, "abc-mixed", "priority-edd", "small", "relocationTasks > 0 且时间线含 relocate 步骤", &["relocation"]),
    spec("D05", Family::Dispatch, "多深位连续倒垛", "连续倒垛的连锁代价", T::AsrsMultiDeep, "abc-mixed", "priority-edd", "small", "blockedMoves > 0", &["relocation"]),
    spec("D06", Family::Dispatch, "四向穿梭车网格", "横巷交叉口的单车道互斥", T::AsrsFourWay, "abc-mixed", "joint-alns", "small", "无 LANE_MUTUAL_EXCLUSION 违规", &[]),
    spec("D07", Family::Dispatch, "双货架块共享提升机", "共享提升机不得互相穿越", T::AsrsTwoBlock, "abc-mixed", "priority-edd", "small", "无 LIFT_SHAFT_CAPACITY 违规", &[]),
    spec("D08", Family::Dispatch, "单指令 vs 双指令", "双指令复合作业减少空驶", T::AsrsSingleDeep, "abc-mixed", "dual-command", "small", "dualCommandPairs > 0 且空驶距离下降", &["dualCommand"]),
    spec("D09", Family::Dispatch, "任务优先级抢占", "高优先级任务先做", T::AsrsSingleDeep, "abc-mixed", "priority", "small", "高优先级任务完成时间早于低优先级", &[]),
    spec("D10", Family::Dispatch, "交期约束（EDD）", "逾期任务数量被最小化", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "lateTasks 被报告", &[]),
    spec("D11", Family::Dispatch, "交接站并发", "站台容量限制下的交接排队", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "stationPeak ≤ 容量", &[]),
    spec("D12", Family::Dispatch, "缓冲位容量约束", "缓冲位满载时上游必须等待", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "无 BUFFER_CAPACITY 违规", &[]),
    spec("D13", Family::Dispatch, "输送线拥塞", "输送段容量与排队时间", T::AsrsHybridMultiArea, "abc-mixed", "priority-edd", "small", "冲突次数被报告", &[]),
    spec("D14", Family::Dispatch, "跨层转层（多提升机）", "多次跨层的时间叠加", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "每层跨层次数被报告", &[]),
    spec("D15", Family::Dispatch, "设备能力差异（车型混编）", "不同车型可服务范围不同", T::AsrsFourWay, "abc-mixed", "nearest-device", "small", "无 DEVICE_CAPABILITY 违规", &[]),
    spec("D16", Family::Dispatch, "大规模任务流（5000）", "规模下的调度时间与质量", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "large", "报告实际完成数、用时、利用率", &["scale"]),
    spec("D17", Family::Dispatch, "超大规模任务流（20000）", "极端规模下诚实报告资源占用", T::AsrsFourWay, "abc-mixed", "priority-edd", "extreme", "报告实际完成数与内存占用；不得裁剪后声称全量", &["scale"]),
    spec("D18", Family::Dispatch, "紧急插单", "运行中插入紧急任务的抢占效果", T::AsrsSingleDeep, "abc-mixed", "joint-alns", "small", "紧急任务被提前完成", &["dynamic"]),
    spec("D19", Family::Dispatch, "任务取消", "取消后的重排与资源释放", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "取消任务不出现在时间线", &["dynamic"]),
    spec("D20", Family::Dispatch, "设备故障重排", "故障窗口内不得有动作", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "无 DEVICE_UNAVAILABLE 违规且故障留痕", &["dynamic"]),
    spec("D21", Family::Dispatch, "巷道封闭", "封闭巷道任务改派或标记未服务", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "封闭巷道无动作", &["dynamic"]),
    spec("D22", Family::Dispatch, "降速运行", "降速后完工时间上升但约束仍满足", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "完工时间 ≥ 正常情形", &["dynamic"]),
    spec("D23", Family::Dispatch, "库位冻结与重排", "冻结库位的任务被改派", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "无 LOCATION_FROZEN 违规", &["dynamic"]),
    spec("D24", Family::Dispatch, "空地混合（人工 + 自动化）", "人工区的任务不占用自动化设备", T::ManualHybrid, "abc-mixed", "priority-edd", "small", "人工任务不出现自动化设备步骤", &[]),

    // ---------------- E 系列：事件与异常（14） ----------------
    spec("E01", Family::Event, "高峰冲击", "需求峰值下的排队与延迟", T::AsrsSingleDeep, "bimodal-peak", "priority-edd", "small", "峰值时段等待被报告", &["dynamic"]),
    spec("E02", Family::Event, "需求突变（+40%）", "需求突变后库位与调度同时承压", T::AsrsSingleDeep, "bimodal-peak", "dynamic", "medium", "突变被留痕且方案可行", &["dynamic"]),
    spec("E03", Family::Event, "促销活动（关联簇热卖）", "促销簇的集中流量", T::AsrsSingleDeep, "affinity-clusters", "dynamic", "medium", "促销簇库位相邻性提升", &["dynamic"]),
    spec("E04", Family::Event, "紧急插单抢占", "插单对已完成计划的扰动", T::AsrsSingleDeep, "abc-mixed", "joint-alns", "small", "插单任务完成时间早于同优先级任务", &["dynamic"]),
    spec("E05", Family::Event, "取消风暴", "大量取消后的资源释放", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "取消率被报告", &["dynamic"]),
    spec("E06", Family::Event, "设备故障（提升机）", "提升机故障的替代路径", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "故障窗口内提升机无动作", &["dynamic"]),
    spec("E07", Family::Event, "设备故障（穿梭车）", "穿梭车故障后的任务改派", T::AsrsSingleDeep, "abc-mixed", "joint-alns", "small", "改派被留痕且无时间重叠", &["dynamic"]),
    spec("E08", Family::Event, "恢复（故障恢复后回补）", "恢复后的补做与优先级", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "恢复后任务被继续服务", &["dynamic"]),
    spec("E09", Family::Event, "巷道封闭 + 任务改派", "封闭巷道后任务改派或明确未服务", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "未服务任务被如实报告", &["dynamic"]),
    spec("E10", Family::Event, "库位冻结（临时占用）", "临时冻结后退让", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "冻结库位无动作", &["dynamic"]),
    spec("E11", Family::Event, "缓冲位丢失", "缓冲容量下降后的排队", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "无 BUFFER_CAPACITY 违规", &["dynamic"]),
    spec("E12", Family::Event, "降速 70%", "降速下的吞吐折损被量化", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "small", "吞吐下降被报告", &["dynamic"]),
    spec("E13", Family::Event, "订单取消 + 库存回收", "取消订单的库存回架", T::AsrsSingleDeep, "abc-mixed", "dynamic", "small", "库存台账守恒（INVENTORY_CONSERVATION）", &["dynamic"]),
    spec("E14", Family::Event, "多重事件叠加", "多个事件同时发生时的稳定性", T::AsrsFourWay, "bimodal-peak", "joint-alns", "small", "所有事件被留痕且验证通过", &["dynamic"]),

    // ---------------- J 系列：联合优化（12） ----------------
    spec("J01", Family::Joint, "联合优化基线", "库位 × 调度闭环的第一条证据", T::AsrsSingleDeep, "abc-mixed", "joint-alns", "small", "comparison 三行齐备且验证通过", &["comparison"]),
    spec("J02", Family::Joint, "热点集中 vs 分散", "把热点打散对拥塞的改善", T::AsrsSingleDeep, "zipf-hot", "joint-alns", "small", "冲突次数低于随机储位", &["comparison"]),
    spec("J03", Family::Joint, "关联簇 × 双指令", "关联簇相邻 + 双指令的时间收益", T::AsrsSingleDeep, "affinity-clusters", "joint-alns", "small", "空驶距离下降", &["comparison"]),
    spec("J04", Family::Joint, "多深位 × 倒垛代价", "深位方案的倒垛代价必须进入库位目标", T::AsrsMultiDeep, "abc-mixed", "joint-alns", "small", "relocationTasks 被计入联合目标", &["comparison"]),
    spec("J05", Family::Joint, "提升机瓶颈 × 高层库位", "高层库位与提升机负载的耦合", T::AsrsSingleDeep, "abc-mixed", "joint-alns", "medium", "提升机负载差异被报告", &["comparison"]),
    spec("J06", Family::Joint, "抗拥堵库位方案", "拥堵惩罚下库位分布更均衡", T::AsrsFourWay, "zipf-hot", "joint-alns", "small", "aisleLoadGini 降低", &["comparison"]),
    spec("J07", Family::Joint, "短期 vs 长期权衡", "搬迁代价 vs 长期收益", T::AsrsSingleDeep, "abc-mixed", "joint-alns", "small", "rounds 记录每轮权衡", &["comparison"]),
    spec("J08", Family::Joint, "鲁棒库位 × 故障调度", "鲁棒方案在故障情景下的表现", T::AsrsSingleDeep, "bimodal-peak", "joint-alns", "medium", "故障情景下仍可行", &["comparison"]),
    spec("J09", Family::Joint, "多目标联合", "Pareto 前沿上的联合决策", T::AsrsSingleDeep, "abc-mixed", "joint-alns", "small", "pareto 与 comparison 同时存在", &["pareto"]),
    spec("J10", Family::Joint, "跨巷道协同", "跨巷道任务的指派协同", T::AsrsFourWay, "abc-mixed", "joint-alns", "small", "跨巷道任务有明确指派理由", &["comparison"]),
    spec("J11", Family::Joint, "全流程仿真（收货→上架→拣选→出库）", "端到端流程的时间线", T::AsrsHybridMultiArea, "abc-mixed", "joint-alns", "medium", "时间线含各阶段步骤", &["timeline"]),
    spec("J12", Family::Joint, "对比矩阵（随机/经典/联合）", "三种方案在同一调度口径下的对比", T::AsrsSingleDeep, "abc-mixed", "joint-alns", "medium", "comparison 三行数字完整", &["comparison"]),

    // ---------------- X 系列：压力与边界（12） ----------------
    spec("X01", Family::Stress, "超大 SKU 目录（150k）", "SKU 规模压力", T::AsrsSingleDeep, "zipf-hot", "alns", "extreme", "如实报告实际求解规模与用时", &["scale"]),
    spec("X02", Family::Stress, "超大库位（2M）", "库位规模压力（只做拓扑与派生）", T::AsrsMultiDeep, "abc-mixed", "alns", "extreme", "报告派生库位数与内存占用", &["scale"]),
    spec("X03", Family::Stress, "库存爆满", "占用率 99% 的可行性", T::AsrsSingleDeep, "abc-mixed", "alns", "large", "给出可行解或不可行证明", &["scale"]),
    spec("X04", Family::Stress, "零库存", "空仓边界（不应崩溃）", T::AsrsSingleDeep, "abc-mixed", "alns", "tiny", "状态为 FEASIBLE 且解为空", &[]),
    spec("X05", Family::Stress, "单库位单货", "最小实例", T::AsrsSingleDeep, "uniform-small", "alns", "tiny", "OPTIMAL_PROVEN", &["bound"]),
    spec("X06", Family::Stress, "全库位冻结", "无可放置位置时的证明", T::AsrsSingleDeep, "abc-mixed", "alns", "tiny", "INFEASIBLE_PROVEN 且给出证明", &[]),
    spec("X07", Family::Stress, "零设备", "没有可用设备时的调度降级", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "tiny", "任务全部未服务且被如实报告（不是崩溃）", &[]),
    spec("X08", Family::Stress, "零任务", "空任务集", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "tiny", "完成数为 0，验证通过", &[]),
    spec("X09", Family::Stress, "拓扑退化（1 巷道 1 层 1 列）", "退化拓扑不应产生非法动作", T::AsrsSingleDeep, "uniform-small", "priority-edd", "tiny", "无动作冲突", &[]),
    spec("X10", Family::Stress, "重复 ID（契约错误）", "重复 ID 必须报 INVALID_INPUT 并定位", T::AsrsSingleDeep, "abc-mixed", "alns", "tiny", "INVALID_INPUT + 字段路径", &["issues"]),
    spec("X11", Family::Stress, "非法参数（负预算/负权重）", "参数越界必须拒绝并定位", T::AsrsSingleDeep, "abc-mixed", "alns", "tiny", "INVALID_INPUT + 字段路径", &["issues"]),
    spec("X12", Family::Stress, "验证器对抗（篡改方案）", "人为破坏方案后验证器必须报错", T::AsrsSingleDeep, "abc-mixed", "priority-edd", "tiny", "验证器报出具体违规（不是通过）", &["violation"]),
];

/// 规模档位（显式写清每档的规模，避免"声称的规模"与"实际规模"不一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScaleSpec {
    pub key: &'static str,
    pub skus: usize,
    pub aisles: i32,
    pub levels: i32,
    pub bays: i32,
    pub depths: i32,
    pub shuttles_per_aisle: i32,
    pub tasks: usize,
    pub orders: usize,
}

pub const SCALES: &[ScaleSpec] = &[
    ScaleSpec { key: "tiny", skus: 8, aisles: 1, levels: 2, bays: 6, depths: 1, shuttles_per_aisle: 1, tasks: 12, orders: 60 },
    ScaleSpec { key: "small", skus: 60, aisles: 2, levels: 3, bays: 14, depths: 1, shuttles_per_aisle: 1, tasks: 120, orders: 800 },
    ScaleSpec { key: "medium", skus: 400, aisles: 6, levels: 5, bays: 40, depths: 2, shuttles_per_aisle: 1, tasks: 900, orders: 6_000 },
    ScaleSpec { key: "large", skus: 8_000, aisles: 24, levels: 8, bays: 90, depths: 2, shuttles_per_aisle: 1, tasks: 6_000, orders: 60_000 },
    ScaleSpec { key: "extreme", skus: 60_000, aisles: 60, levels: 10, bays: 220, depths: 3, shuttles_per_aisle: 1, tasks: 20_000, orders: 120_000 },
];

pub fn scale_of(key: &str) -> ScaleSpec {
    SCALES
        .iter()
        .copied()
        .find(|scale| scale.key == key)
        .unwrap_or(SCALES[1])
}

pub fn list() -> Vec<&'static ScenarioSpec> {
    SCENARIOS.iter().collect()
}

pub fn find(id: &str) -> Option<&'static ScenarioSpec> {
    SCENARIOS
        .iter()
        .find(|scenario| scenario.id.eq_ignore_ascii_case(id))
}

/// 场景清单 → JSON（`scenarios` 子命令与实验室"场景选择"共用）。
pub fn catalog_json() -> Json {
    let families: Vec<Json> = [Family::Slotting, Family::Dispatch, Family::Event, Family::Joint, Family::Stress]
        .iter()
        .map(|family| {
            Json::obj(vec![
                ("family", Json::str(family.as_str())),
                ("label", Json::str(family.label())),
                (
                    "scenarios",
                    Json::Arr(
                        SCENARIOS
                            .iter()
                            .filter(|scenario| scenario.family == *family)
                            .map(|scenario| {
                                Json::obj(vec![
                                    ("id", Json::str(scenario.id)),
                                    ("name", Json::str(scenario.name)),
                                    ("goal", Json::str(scenario.goal)),
                                    ("topology", Json::str(scenario.template.as_str())),
                                    ("catalog", Json::str(scenario.catalog)),
                                    ("algorithm", Json::str(scenario.algorithm)),
                                    ("scale", Json::str(scenario.scale)),
                                    ("expect", Json::str(scenario.expect)),
                                    ("mustShow", Json::strings(scenario.must_show.iter().copied())),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ])
        })
        .collect();
    Json::obj(vec![
        ("count", Json::int(SCENARIOS.len() as i64)),
        (
            "scales",
            Json::Arr(
                SCALES
                    .iter()
                    .map(|scale| {
                        Json::obj(vec![
                            ("key", Json::str(scale.key)),
                            ("skus", Json::int(scale.skus as i64)),
                            ("aisles", Json::int(scale.aisles as i64)),
                            ("levels", Json::int(scale.levels as i64)),
                            ("bays", Json::int(scale.bays as i64)),
                            ("depths", Json::int(scale.depths as i64)),
                            ("tasks", Json::int(scale.tasks as i64)),
                            ("orders", Json::int(scale.orders as i64)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("families", Json::Arr(families)),
    ])
}

/// 生成场景对应的**完整问题文档**（库位优化 / 立库调度 / 联合）。
pub fn build(id: &str, scale_override: Option<&str>, seed_override: Option<u64>, issues: &mut Issues) -> Json {
    let Some(scenario) = find(id) else {
        issues.error(
            codes::VALUE_RANGE,
            "scenario",
            format!("未知场景 {id}（用 `scenarios` 子命令查看全部 86 个场景）"),
        );
        return Json::Null;
    };
    let scale = scale_of(scale_override.unwrap_or(scenario.scale));
    let seed = seed_override.unwrap_or(7);
    let mut topology_params = TopologyParams {
        template: scenario.template,
        aisles: scale.aisles,
        levels: scale.levels,
        bays: scale.bays,
        depths: scale.depths,
        shuttles_per_aisle: scale.shuttles_per_aisle,
        ..TopologyParams::default()
    };
    // 场景相关的拓扑细节
    match id {
        "S16" | "X03" => {
            topology_params.bays = (scale.bays as f64 * 0.35).round() as i32;
        }
        "S17" => {
            topology_params.bays = 2;
        }
        "S18" | "E10" | "D23" => {
            topology_params.frozen_share = 0.12;
        }
        "X06" => {
            topology_params.frozen_share = 1.0;
        }
        "D07" => {
            topology_params.lifts_per_block = 1;
        }
        "X07" => {
            topology_params.shuttles_per_aisle = 0;
        }
        _ => {}
    }
    if matches!(scenario.family, Family::Event | Family::Joint) {
        topology_params.buffer_capacity = 4;
    }
    let bundle = build_topology(&topology_params.normalized());
    let location_count = bundle.stats.locations;

    // 目录与库存
    let mut catalog_params: CatalogParams = preset(scenario.catalog);
    catalog_params.skus = scale.skus;
    catalog_params.locations = location_count;
    catalog_params.seed = seed;
    catalog_params.target_occupancy = match id {
        "S16" => 0.97,
        "X03" => 0.99,
        "X04" => 0.0,
        "S17" => 1.0,
        _ => 0.82,
    };
    let mut catalog = generate_catalog(&catalog_params);
    // 库存单元必须真的在库位上：否则"当前布局"就是空的，遮挡/倒垛/搬迁全都无从谈起。
    assign_initial_locations(
        &mut catalog.inventory,
        &bundle.topology,
        seed,
        catalog_params.target_occupancy,
    );

    // 订单
    let order_params = OrderParams {
        orders: scale.orders,
        seed: seed + 1,
        ..OrderParams::default()
    };
    let orders = generate_orders(&order_params, &catalog.skus, &catalog.demand);

    let objectives = default_objectives(scenario.family);
    let tasks = build_tasks(&bundle.topology, &catalog.inventory, &orders.orders, scale.tasks, seed, id);
    let events = build_events(id, &tasks, seed);
    let slotting_problem = SlottingProblem {
        id: format!("{id}-SLOTTING"),
        scenario_id: Some(id.to_string()),
        dataset_version: format!("{id}/scale={}/{}/seed={seed}", scale.key, catalog_params.skus),
        topology: bundle.topology.clone(),
        skus: catalog.skus.clone(),
        inventory: catalog.inventory.clone(),
        history: orders.orders.clone(),
        demand: catalog.demand.clone(),
        current_assignment: initial_assignment(&catalog.inventory),
        objectives,
        constraints: crate::contract::SlottingConstraints::default(),
        algorithm: crate::contract::SlottingAlgorithmConfig {
            algorithm: if scenario.family == Family::Joint {
                "alns".to_string()
            } else {
                scenario.algorithm.to_string()
            },
            seed,
            budget_ms: match scale.key {
                "tiny" => 800.0,
                "small" => 2_500.0,
                "medium" => 8_000.0,
                "large" => 25_000.0,
                _ => 60_000.0,
            },
            ..crate::contract::SlottingAlgorithmConfig::default()
        },
        cost_model: Default::default(),
        events: events.clone(),
        hard_constraints: vec![
            "LOCATION_CAPACITY".to_string(),
            "LOCATION_WEIGHT_LIMIT".to_string(),
            "LOCATION_VOLUME_LIMIT".to_string(),
            "ZONE_COMPATIBILITY".to_string(),
            "LOCATION_FROZEN".to_string(),
            "INVENTORY_CONSERVATION".to_string(),
        ],
    };

    let asrs_problem = AsrsProblem {
        id: format!("{id}-ASRS"),
        scenario_id: Some(id.to_string()),
        dataset_version: format!("{id}/scale={}/tasks={}/seed={seed}", scale.key, tasks.len()),
        topology: bundle.topology.clone(),
        tasks,
        load_units: catalog.inventory.clone(),
        skus: catalog.skus.clone(),
        dispatch: DispatchConfig {
            algorithm: if scenario.family == Family::Joint {
                "joint-alns".to_string()
            } else {
                scenario.algorithm.to_string()
            },
            seed,
            budget_ms: match scale.key {
                "tiny" => 800.0,
                "small" => 3_000.0,
                "medium" => 10_000.0,
                "large" => 30_000.0,
                _ => 60_000.0,
            },
            dual_command: !matches!(id, "D08" | "D01"),
            simulation_horizon_s: 0.0,
            ..DispatchConfig::default()
        },
        events: events.clone(),
        hard_constraints: vec![
            "DEVICE_MUTUAL_EXCLUSION".to_string(),
            "LANE_MUTUAL_EXCLUSION".to_string(),
            "LIFT_SHAFT_CAPACITY".to_string(),
            "BUFFER_CAPACITY".to_string(),
            "STATION_CAPACITY".to_string(),
            "TASK_PRECEDENCE".to_string(),
            "DEVICE_CAPABILITY".to_string(),
        ],
        slotting_plan: None,
    };

    let topology_json = topology_to_json(&bundle);
    let slotting_json = slotting_problem_to_json(&slotting_problem, &topology_json, &events);
    let asrs_json = asrs_problem_to_json(&asrs_problem, &topology_json, &events);

    let kind = match scenario.family {
        Family::Slotting => "slotting",
        Family::Dispatch | Family::Event => "asrs",
        Family::Joint => "joint",
        Family::Stress => "stress",
    };
    let mut root = Json::obj(vec![
        ("kind", Json::str(kind)),
        ("scenarioId", Json::str(id)),
        ("name", Json::str(scenario.name)),
        ("goal", Json::str(scenario.goal)),
        ("expect", Json::str(scenario.expect)),
        ("scale", Json::str(scale.key)),
        ("seed", Json::int(seed as i64)),
        ("topology", topology_json),
        (
            "stats",
            Json::obj(vec![
                ("locations", Json::int(bundle.stats.locations as i64)),
                ("availableLocations", Json::int(bundle.stats.available_locations as i64)),
                ("aisles", Json::int(bundle.stats.aisles as i64)),
                ("devices", Json::int(bundle.stats.devices as i64)),
                ("stations", Json::int(bundle.stats.stations as i64)),
                ("skus", Json::int(catalog.stats.skus as i64)),
                ("loadUnits", Json::int(catalog.stats.load_units as i64)),
                ("orders", Json::int(orders.stats.orders as i64)),
                ("tasks", Json::int(asrs_problem.tasks.len() as i64)),
                ("footprintM2", Json::Float(round(bundle.stats.footprint_m2, 2))),
            ]),
        ),
    ]);
    match scenario.family {
        Family::Slotting | Family::Stress => {
            root.set("problem", slotting_json);
        }
        Family::Dispatch | Family::Event => {
            root.set("problem", asrs_json);
        }
        Family::Joint => {
            root.set("slotting", slotting_json);
            root.set("asrs", asrs_json);
        }
    }
    root
}

fn default_objectives(family: Family) -> Vec<crate::contract::ObjectiveSpec> {
    let mut objectives = vec![
        crate::contract::ObjectiveSpec {
            id: "expected-travel-time".to_string(),
            direction: "min".to_string(),
            weight: 1.0,
            unit: "秒/天".to_string(),
            normalizer: None,
            note: "按出入库流量加权的日运行时间（设备运动学计算）".to_string(),
        },
        crate::contract::ObjectiveSpec {
            id: "congestion".to_string(),
            direction: "min".to_string(),
            weight: 0.35,
            unit: "秒/天".to_string(),
            normalizer: None,
            note: "巷道/提升机排队代理延误".to_string(),
        },
        crate::contract::ObjectiveSpec {
            id: "load-balance".to_string(),
            direction: "min".to_string(),
            weight: 0.15,
            unit: "基尼系数".to_string(),
            normalizer: None,
            note: "巷道负载分布的基尼系数".to_string(),
        },
        crate::contract::ObjectiveSpec {
            id: "relocation-cost".to_string(),
            direction: "min".to_string(),
            weight: 0.2,
            unit: "秒".to_string(),
            normalizer: None,
            note: "相对当前布局的搬迁设备时间".to_string(),
        },
    ];
    if family == Family::Joint {
        objectives.push(crate::contract::ObjectiveSpec {
            id: "delivery-timeliness".to_string(),
            direction: "max".to_string(),
            weight: 0.3,
            unit: "比例".to_string(),
            normalizer: None,
            note: "时限内可完成的流量占比".to_string(),
        });
    }
    objectives
}


/// 初始在库位置的确定性分配：**每列从最深位开始填**（真实密集立库的入位顺序），
/// 因此"深层有货、前排也常有货"，遮挡与连锁倒垛是数据本身带来的，不是脚本安排的。
fn assign_initial_locations(
    inventory: &mut [InventoryUnit],
    topology: &crate::contract::Topology,
    seed: u64,
    target_occupancy: f64,
) {
    if inventory.is_empty() {
        return;
    }
    let records = crate::wh::topology::derive_locations(topology);
    let mut columns: std::collections::BTreeMap<(String, i32, i32), Vec<usize>> =
        std::collections::BTreeMap::new();
    for (index, record) in records.iter().enumerate() {
        if !record.availability.placeable() {
            continue;
        }
        columns
            .entry((record.rack_id.clone(), record.bay, record.level))
            .or_default()
            .push(index);
    }
    // 每列内按深度降序（深位优先入位）
    let mut column_list: Vec<Vec<usize>> = Vec::new();
    for column in columns.values_mut() {
        column.sort_by_key(|index| std::cmp::Reverse(records[*index].depth));
        column_list.push(column.clone());
    }
    column_list.sort_by_key(|column| column.first().copied().unwrap_or(0));
    let max_len = column_list.iter().map(|column| column.len()).max().unwrap_or(0);
    let mut pool: Vec<usize> = Vec::new();
    for step in 0..max_len {
        for column in &column_list {
            if let Some(index) = column.get(step) {
                pool.push(*index);
            }
        }
    }
    let limit = ((pool.len() as f64) * target_occupancy.clamp(0.0, 1.0)).round() as usize;
    let limit = limit.min(pool.len());
    let _ = seed;
    for (slot, unit) in inventory.iter_mut().enumerate() {
        if slot >= limit {
            unit.location_id = None;
            unit.status = "staged".to_string();
            continue;
        }
        unit.location_id = Some(records[pool[slot]].id.clone());
        unit.status = "stored".to_string();
    }
}

fn initial_assignment(inventory: &[InventoryUnit]) -> std::collections::BTreeMap<String, String> {
    inventory
        .iter()
        .filter_map(|unit| Some((unit.id.clone(), unit.location_id.clone()?)))
        .collect()
}

fn build_tasks(
    topology: &crate::contract::Topology,
    inventory: &[InventoryUnit],
    orders: &[crate::contract::CustomerOrder],
    count: usize,
    seed: u64,
    id: &str,
) -> Vec<crate::contract::WarehouseTask> {
    use crate::contract::WarehouseTask;
    use crate::util::{seed_from, Rng};
    let mut rng = Rng::new(seed_from(&["tasks", id, &seed.to_string()]));
    let locations = crate::wh::topology::derive_locations(topology);
    let outbound_station = topology
        .stations
        .iter()
        .find(|station| station.direction.outbound())
        .or_else(|| topology.stations.first());
    let inbound_station = topology
        .stations
        .iter()
        .find(|station| station.direction.inbound())
        .or_else(|| topology.stations.first());
    let mut tasks = Vec::with_capacity(count);
    let unit_of_location: std::collections::BTreeMap<&str, &InventoryUnit> = inventory
        .iter()
        .filter_map(|unit| Some((unit.location_id.as_deref()?, unit)))
        .collect();
    // 任务目标必须尊重库位现状：出库只能针对"有货的库位"，入库只能针对"空库位"。
    // 多深位场景还要刻意安排深位任务，否则倒垛永远不会发生（场景就名不副实）。
    let occupied: Vec<usize> = locations
        .iter()
        .enumerate()
        .filter(|(_, location)| unit_of_location.contains_key(location.id.as_str()))
        .map(|(index, _)| index)
        .collect();
    let deep_occupied: Vec<usize> = occupied
        .iter()
        .copied()
        .filter(|index| locations[*index].depth >= 2)
        .collect();
    let mut free_pool: Vec<usize> = locations
        .iter()
        .enumerate()
        .filter(|(_, location)| !unit_of_location.contains_key(location.id.as_str()))
        .map(|(index, _)| index)
        .collect();
    let mut free_cursor = 0usize;
    for index in 0..count {
        let is_outbound = rng.next_f64() < 0.62;
        let location_index = if is_outbound {
            if !deep_occupied.is_empty() && rng.next_f64() < 0.45 {
                deep_occupied[rng.below(deep_occupied.len())]
            } else if !occupied.is_empty() {
                occupied[rng.below(occupied.len())]
            } else {
                rng.below(locations.len())
            }
        } else {
            // 入库：从"空库位池"里按确定顺序取（不重复占用同一个库位），并保证一定比例的深位入库
            let deep_free: Vec<usize> = free_pool
                .iter()
                .copied()
                .filter(|index| locations[*index].depth >= 2)
                .collect();
            let pick = if !deep_free.is_empty() && rng.next_f64() < 0.4 {
                let candidate = deep_free[rng.below(deep_free.len())];
                free_pool.retain(|index| *index != candidate);
                candidate
            } else if free_cursor < free_pool.len() {
                let candidate = free_pool[free_cursor];
                free_cursor += 1;
                candidate
            } else if !free_pool.is_empty() {
                free_pool[rng.below(free_pool.len())]
            } else {
                rng.below(locations.len())
            };
            pick
        };
        let location = locations[location_index].clone();
        let unit = unit_of_location.get(location.id.as_str()).copied();
        let release = rng.next_f64() * 3_600.0 * (1.0 + (index % 24) as f64 * 0.05);
        let priority = if rng.next_f64() < 0.12 { 3 } else if rng.next_f64() < 0.4 { 2 } else { 1 };
        let deadline = if rng.next_f64() < 0.7 {
            Some(release + 900.0 + rng.next_f64() * 3_600.0)
        } else {
            None
        };
        let order = orders.get(rng.below(orders.len().max(1)));
        tasks.push(WarehouseTask {
            id: format!("{id}-T{:05}", index + 1),
            kind: if is_outbound { "outbound" } else { "inbound" }.to_string(),
            priority,
            release_s: round(release, 2),
            deadline_s: deadline.map(|value| round(value, 2)),
            from_location_id: if is_outbound {
                Some(location.id.clone())
            } else {
                inbound_station.map(|station| station.id.clone())
            },
            from_node_id: if is_outbound {
                None
            } else {
                inbound_station.map(|station| station.node_id.clone())
            },
            to_location_id: if is_outbound {
                outbound_station.map(|station| station.id.clone())
            } else {
                Some(location.id.clone())
            },
            to_node_id: if is_outbound {
                outbound_station.map(|station| station.node_id.clone())
            } else {
                None
            },
            load_unit_id: unit
                .map(|unit| unit.id.clone())
                .unwrap_or_else(|| format!("LU-TASK-{}", index + 1)),
            sku_id: unit.map(|unit| unit.sku_id.clone()).unwrap_or_default(),
            depends_on: Vec::new(),
            order_id: order.map(|order| order.id.clone()),
            dual_command_eligible: is_outbound && rng.next_f64() < 0.35,
            cancellable: true,
        });
    }
    // 多深位场景：把一部分任务指向深位，强制触发倒垛
    if topology.racks.iter().any(|rack| rack.depths > 1) {
        let deep: Vec<_> = locations.iter().filter(|record| record.depth > 1).cloned().collect();
        if !deep.is_empty() {
            for (index, task) in tasks.iter_mut().enumerate() {
                if index % 5 == 0 {
                    let location = &deep[(index / 5) % deep.len()];
                    if task.kind == "outbound" {
                        task.from_location_id = Some(location.id.clone());
                    } else {
                        task.to_location_id = Some(location.id.clone());
                    }
                }
            }
        }
    }
    tasks
}

fn build_events(id: &str, tasks: &[crate::contract::WarehouseTask], _seed: u64) -> Vec<crate::contract::DynamicEvent> {
    use crate::contract::DynamicEvent;
    let mut events: Vec<DynamicEvent> = Vec::new();
    let blank = Json::Null;
    let make = |kind: &str, at_s: f64, value: f64, device_ids: Vec<String>, task_ids: Vec<String>, location_ids: Vec<String>| DynamicEvent {
        kind: kind.to_string(),
        at_s,
        payload: blank.clone(),
        device_ids,
        task_ids,
        location_ids,
        link_ids: Vec::new(),
        tasks: Vec::new(),
        value,
    };
    let device = |index: usize| -> Vec<String> {
        vec![format!("DEV-{index}")]
    };
    match id {
        "S12" | "E02" | "E03" => events.push(make("demand-shift", 0.0, 1.4, vec![], vec![], vec![])),
        "D18" | "E04" => {
            if let Some(task) = tasks.first() {
                let mut inserted = task.clone();
                inserted.id = format!("{}-URGENT", task.id);
                inserted.priority = 5;
                inserted.release_s = 600.0;
                let mut event = make("urgent-insert", 600.0, 5.0, vec![], vec![], vec![]);
                event.tasks = vec![inserted];
                events.push(event);
            }
        }
        "D19" | "E05" => {
            let cancelled: Vec<String> = tasks.iter().take(5).map(|task| task.id.clone()).collect();
            events.push(make("task-cancel", 900.0, 0.0, vec![], cancelled, vec![]));
        }
        "D20" | "E06" => events.push(make("device-breakdown", 1_200.0, 900.0, device(0), vec![], vec![])),
        "E07" => events.push(make("device-breakdown", 1_800.0, 1_200.0, device(1), vec![], vec![])),
        "E08" => {
            events.push(make("device-breakdown", 1_200.0, 900.0, device(0), vec![], vec![]));
            events.push(make("device-recovered", 2_100.0, 0.0, device(0), vec![], vec![]));
        }
        "D21" | "E09" => {
            let mut event = make("aisle-closure", 1_500.0, 0.0, vec![], vec![], vec![]);
            event.link_ids = vec!["A-1".to_string()];
            events.push(event);
        }
        "D23" | "E10" => {
            let frozen: Vec<String> = tasks
                .iter()
                .take(3)
                .filter_map(|task| task.from_location_id.clone().or_else(|| task.to_location_id.clone()))
                .collect();
            events.push(make("location-freeze", 600.0, 0.0, vec![], vec![], frozen));
        }
        "E11" => {
            let mut event = make("buffer-loss", 900.0, 0.0, vec![], vec![], vec![]);
            event.link_ids = vec!["BUF-1".to_string()];
            events.push(event);
        }
        "D22" | "E12" => events.push(make("speed-degradation", 300.0, 0.3, device(0), vec![], vec![])),
        "E13" => {
            let cancelled: Vec<String> = tasks.iter().take(4).map(|task| task.id.clone()).collect();
            events.push(make("order-cancel", 1_200.0, 0.0, vec![], cancelled, vec![]));
        }
        "E14" => {
            events.push(make("demand-shift", 0.0, 1.3, vec![], vec![], vec![]));
            events.push(make("device-breakdown", 1_200.0, 600.0, device(0), vec![], vec![]));
            events.push(make("speed-degradation", 1_800.0, 0.4, device(1), vec![], vec![]));
            let cancelled: Vec<String> = tasks.iter().take(3).map(|task| task.id.clone()).collect();
            events.push(make("task-cancel", 2_400.0, 0.0, vec![], cancelled, vec![]));
        }
        _ => {}
    }
    events
}

/* ------------------------------------------------------------------ *
 * 问题 → JSON（契约序列化，供 CLI / 实验室 / wasm 共用）
 * ------------------------------------------------------------------ */

fn slotting_problem_to_json(
    problem: &SlottingProblem,
    topology_json: &Json,
    events: &[crate::contract::DynamicEvent],
) -> Json {
    Json::obj(vec![
        ("id", Json::str(problem.id.clone())),
        ("scenarioId", Json::opt_str(problem.scenario_id.clone())),
        ("datasetVersion", Json::str(problem.dataset_version.clone())),
        ("topology", topology_json.clone()),
        (
            "skus",
            Json::Arr(
                problem
                    .skus
                    .iter()
                    .map(|sku| {
                        Json::obj(vec![
                            ("id", Json::str(sku.id.clone())),
                            ("name", Json::str(sku.name.clone())),
                            ("category", Json::str(sku.category.clone())),
                            ("unitWeightKg", Json::Float(sku.unit_weight_kg)),
                            ("unitVolumeM3", Json::Float(sku.unit_volume_m3)),
                            ("abc", Json::str(sku.abc.to_string())),
                            ("xyz", Json::str(sku.xyz.to_string())),
                            ("meanDailyDemand", Json::Float(sku.mean_daily_demand)),
                            ("demandCv", Json::Float(sku.demand_cv)),
                            ("allowedZones", Json::strings(sku.allowed_zones.clone())),
                            ("temperature", Json::str(sku.temperature.clone())),
                            ("batchPolicy", Json::str(sku.batch_policy.clone())),
                            ("affinityCluster", Json::opt_str(sku.affinity_cluster.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "inventory",
            Json::Arr(
                problem
                    .inventory
                    .iter()
                    .map(inventory_unit_json)
                    .collect(),
            ),
        ),
        (
            "orders",
            Json::Arr(
                problem
                    .history
                    .iter()
                    .map(|order| {
                        Json::obj(vec![
                            ("id", Json::str(order.id.clone())),
                            ("release_s", Json::Float(order.release_s)),
                            ("due_s", Json::Float(order.due_s)),
                            ("priority", Json::int(order.priority)),
                            ("channel", Json::str(order.channel.clone())),
                            (
                                "lines",
                                Json::Arr(
                                    order
                                        .lines
                                        .iter()
                                        .map(|line| {
                                            Json::obj(vec![
                                                ("skuId", Json::str(line.sku_id.clone())),
                                                ("quantity", Json::Float(line.quantity)),
                                            ])
                                        })
                                        .collect(),
                                ),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "demand",
            Json::obj(vec![
                ("shape", Json::str(problem.demand.shape.clone())),
                ("horizonDays", Json::int(problem.demand.horizon_days)),
                ("promoFactor", Json::Float(problem.demand.promo_factor)),
                ("linesPerOrder", Json::Float(problem.demand.lines_per_order)),
                (
                    "hourlyFactor",
                    Json::Arr(
                        problem
                            .demand
                            .hourly_factor
                            .iter()
                            .map(|value| Json::Float(*value))
                            .collect(),
                    ),
                ),
            ]),
        ),
        (
            "currentAssignment",
            Json::Arr(
                problem
                    .current_assignment
                    .iter()
                    .map(|(unit, location)| {
                        Json::obj(vec![
                            ("loadUnitId", Json::str(unit.clone())),
                            ("locationId", Json::str(location.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "objectives",
            Json::Arr(
                problem
                    .objectives
                    .iter()
                    .map(|objective| {
                        Json::obj(vec![
                            ("id", Json::str(objective.id.clone())),
                            ("direction", Json::str(objective.direction.clone())),
                            ("weight", Json::Float(objective.weight)),
                            ("unit", Json::str(objective.unit.clone())),
                            ("note", Json::str(objective.note.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "constraints",
            Json::obj(vec![
                (
                    "maxLocationsPerSku",
                    Json::int(problem.constraints.max_locations_per_sku as i64),
                ),
                (
                    "minLocationsPerSku",
                    Json::int(problem.constraints.min_locations_per_sku as i64),
                ),
                (
                    "maxAisleSharePerSku",
                    Json::Float(problem.constraints.max_aisle_share_per_sku),
                ),
                ("deepLanePolicy", Json::str(problem.constraints.deep_lane_policy.clone())),
                ("batchPolicy", Json::str(problem.constraints.batch_policy.clone())),
                (
                    "maxUnassignedShare",
                    Json::Float(problem.constraints.max_unassigned_share),
                ),
            ]),
        ),
        (
            "algorithm",
            Json::obj(vec![
                ("algorithm", Json::str(problem.algorithm.algorithm.clone())),
                ("seed", Json::int(problem.algorithm.seed as i64)),
                ("budget_ms", Json::Float(problem.algorithm.budget_ms)),
                ("maxIterations", Json::int(problem.algorithm.max_iterations as i64)),
                ("temperature", Json::Float(problem.algorithm.temperature)),
                ("seeds", Json::strings(problem.algorithm.seeds.iter().map(|s| s.to_string()))),
                (
                    "migrationBudget",
                    Json::obj(vec![
                        ("maxMoves", Json::int(problem.algorithm.migration_max_moves as i64)),
                        ("maxDeviceSeconds", Json::Float(problem.algorithm.migration_max_seconds)),
                    ]),
                ),
                (
                    "pareto",
                    Json::obj(vec![
                        ("populationSize", Json::int(problem.algorithm.pareto_population as i64)),
                        ("generations", Json::int(problem.algorithm.pareto_generations as i64)),
                    ]),
                ),
                (
                    "robust",
                    Json::obj(vec![
                        ("scenarios", Json::int(problem.algorithm.robust_scenarios as i64)),
                        ("measure", Json::str(problem.algorithm.robust_measure.clone())),
                        ("cvarAlpha", Json::Float(problem.algorithm.robust_cvar_alpha)),
                    ]),
                ),
                ("exactWhenSmall", Json::Bool(problem.algorithm.exact_when_small)),
                ("exactMaxUnits", Json::int(problem.algorithm.exact_max_units as i64)),
            ]),
        ),
        ("hardConstraints", Json::strings(problem.hard_constraints.clone())),
        (
            "events",
            Json::Arr(
                events
                    .iter()
                    .map(|event| {
                        Json::obj(vec![
                            ("kind", Json::str(event.kind.clone())),
                            ("at_s", Json::Float(event.at_s)),
                            ("deviceIds", Json::strings(event.device_ids.clone())),
                            ("taskIds", Json::strings(event.task_ids.clone())),
                            ("locationIds", Json::strings(event.location_ids.clone())),
                            ("linkIds", Json::strings(event.link_ids.clone())),
                            ("priority", Json::Float(event.value)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}

pub fn inventory_unit_json(unit: &InventoryUnit) -> Json {
    Json::obj(vec![
        ("id", Json::str(unit.id.clone())),
        ("skuId", Json::str(unit.sku_id.clone())),
        ("quantity", Json::Float(unit.quantity)),
        ("batch", Json::str(unit.batch.clone())),
        ("inbound_at_s", Json::Float(unit.inbound_at_s)),
        (
            "expires_at_s",
            match unit.expires_at_s {
                Some(value) => Json::Float(value),
                None => Json::Null,
            },
        ),
        ("locationId", Json::opt_str(unit.location_id.clone())),
        ("status", Json::str(unit.status.clone())),
    ])
}

fn asrs_problem_to_json(
    problem: &AsrsProblem,
    topology_json: &Json,
    events: &[crate::contract::DynamicEvent],
) -> Json {
    let mut root = Json::obj(vec![
        ("id", Json::str(problem.id.clone())),
        ("scenarioId", Json::opt_str(problem.scenario_id.clone())),
        ("datasetVersion", Json::str(problem.dataset_version.clone())),
        ("topology", topology_json.clone()),
        (
            "tasks",
            Json::Arr(
                problem
                    .tasks
                    .iter()
                    .map(|task| {
                        Json::obj(vec![
                            ("id", Json::str(task.id.clone())),
                            ("kind", Json::str(task.kind.clone())),
                            ("priority", Json::int(task.priority)),
                            ("release_s", Json::Float(task.release_s)),
                            (
                                "deadline_s",
                                match task.deadline_s {
                                    Some(value) => Json::Float(value),
                                    None => Json::Null,
                                },
                            ),
                            ("fromLocationId", Json::opt_str(task.from_location_id.clone())),
                            ("fromNodeId", Json::opt_str(task.from_node_id.clone())),
                            ("toLocationId", Json::opt_str(task.to_location_id.clone())),
                            ("toNodeId", Json::opt_str(task.to_node_id.clone())),
                            ("loadUnitId", Json::str(task.load_unit_id.clone())),
                            ("skuId", Json::str(task.sku_id.clone())),
                            ("dependsOn", Json::strings(task.depends_on.clone())),
                            ("orderId", Json::opt_str(task.order_id.clone())),
                            ("dualCommandEligible", Json::Bool(task.dual_command_eligible)),
                            ("cancellable", Json::Bool(task.cancellable)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "loadUnits",
            Json::Arr(problem.load_units.iter().map(inventory_unit_json).collect()),
        ),
        (
            "dispatch",
            Json::obj(vec![
                ("algorithm", Json::str(problem.dispatch.algorithm.clone())),
                ("seed", Json::int(problem.dispatch.seed as i64)),
                ("budget_ms", Json::Float(problem.dispatch.budget_ms)),
                ("rollingHorizon_s", Json::Float(problem.dispatch.rolling_horizon_s)),
                ("dualCommand", Json::Bool(problem.dispatch.dual_command)),
                ("conflictPolicy", Json::str(problem.dispatch.conflict_policy.clone())),
                ("allowYield", Json::Bool(problem.dispatch.allow_yield)),
            ]),
        ),
        ("hardConstraints", Json::strings(problem.hard_constraints.clone())),
    ]);
    // 事件按契约序列化（payload 直接展开为顶层字段，便于宿主与验证器解析）
    let mut event_list: Vec<Json> = events
        .iter()
        .map(|event| {
            Json::obj(vec![
                ("kind", Json::str(event.kind.clone())),
                ("at_s", Json::Float(event.at_s)),
                ("deviceIds", Json::strings(event.device_ids.clone())),
                ("taskIds", Json::strings(event.task_ids.clone())),
                ("locationIds", Json::strings(event.location_ids.clone())),
                ("linkIds", Json::strings(event.link_ids.clone())),
                ("priority", Json::Float(event.value)),
                (
                    "tasks",
                    Json::Arr(
                        event
                            .tasks
                            .iter()
                            .map(|task| {
                                Json::obj(vec![
                                    ("id", Json::str(task.id.clone())),
                                    ("kind", Json::str(task.kind.clone())),
                                    ("priority", Json::int(task.priority)),
                                    ("release_s", Json::Float(task.release_s)),
                                    ("fromLocationId", Json::opt_str(task.from_location_id.clone())),
                                    ("toLocationId", Json::opt_str(task.to_location_id.clone())),
                                    ("loadUnitId", Json::str(task.load_unit_id.clone())),
                                    ("skuId", Json::str(task.sku_id.clone())),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ])
        })
        .collect();
    if event_list.is_empty() {
        event_list = Vec::new();
    }
    root.set("events", Json::Arr(event_list));
    root
}

/// 场景的默认小时曲线（面板画图用；与目录生成同源）。
pub fn hourly_curve() -> Vec<f64> {
    default_hourly_factor()
}

/// 场景期望 → 机器可读判据（acceptance 使用）。
pub fn expectations_json() -> Json {
    Json::Arr(
        SCENARIOS
            .iter()
            .map(|scenario| {
                Json::obj(vec![
                    ("id", Json::str(scenario.id)),
                    ("expect", Json::str(scenario.expect)),
                    ("mustShow", Json::strings(scenario.must_show.iter().copied())),
                ])
            })
            .collect(),
    )
}

/// 未使用参数的显式占位（保持签名稳定，避免调用方因小改动而返工）。
pub fn demand_profile_of(shape: &str) -> DemandProfile {
    let mut demand = DemandProfile {
        shape: shape.to_string(),
        hourly_factor: default_hourly_factor(),
        ..DemandProfile::default()
    };
    if shape == "seasonal" {
        demand.promo_factor = demand.promo_factor.max(1.6);
    }
    demand
}
