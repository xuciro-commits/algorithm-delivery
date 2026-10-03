/**
 * 实例化环境件的**缓冲区预算**（不要把它和“渲染多少”混为一谈）。
 *
 * drei 的 `<Instances>` 在挂载时按 `limit` 一次性分配实例矩阵/颜色缓冲区
 * （`useState(() => new Float32Array(limit * 16))`），挂载之后只通过 `range`
 * 控制**可见实例数**，缓冲区大小不会跟着变。于是：
 *
 *   - 若把 `limit` 写成“当前实例数”，那么**任何一次增量编辑**（例如 AGV 里
 *     画一个新障碍）都会让 `count` 超过缓冲区容量：越界写入被 Float32Array
 *     静默丢弃，新实例拿到单位矩阵、旧实例按旧索引错位——现象就是
 *     “画一个障碍，其它障碍全乱/看不见了”；
 *   - 若整块地图换尺寸（换场景），旧缓冲区同样放不下新实例。
 *
 * 因此约定：`limit` 取一个**分桶稳定**的上限，并且在它变化时用
 * `key={limit}` 强制重建缓冲区；`range` 永远传当前实例数。
 * 这样编辑过程中只改可见数（廉价），换容量时才重建（正确）。
 */
export function instanceLimit(needed: number, floor = 64, step = 32): number {
  const n = Math.max(needed, floor);
  return Math.ceil(n / step) * step;
}
