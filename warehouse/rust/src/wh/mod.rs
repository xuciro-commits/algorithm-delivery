//! 仓储世界模型（Warehouse World）：拓扑、库位派生、通行/运动学、数据生成。
//!
//! 这一层是**两个算法域共享的物理真相**（SRS §1.3）：
//! * 库位优化用 [`routing::station_seconds`] 得到"这个库位到出库口要多久"；
//! * 立库调度用同一套运动学与距离模型判断"这台设备跑这一趟要多久"；
//!   两者因此不会出现"库位优化以为 10 秒、调度实跑 40 秒"的口径错位。
//!
//! 模块划分：
//! * [`topology`]：拓扑模板 → 区域/货架/巷道/节点/通道/站台/缓存/设备；库位由拓扑**推导**；
//! * [`routing`]：梯形速度曲线、巷道内解析时间、骨架最短路、站台成本表；
//! * [`catalog`]：商品目录 / 库存 / 订单流生成（长尾、ABC-XYZ、关联簇、促销与波动）。

pub mod catalog;
pub mod routing;
pub mod topology;

pub use routing::{travel_time, LocationCost, RouteModel};
pub use topology::{
    build_topology, derive_locations, LocationRecord, TopologyParams, TopologyTemplate,
};
