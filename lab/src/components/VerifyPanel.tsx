/**
 * 约束验证面板：展示**独立校验器**（`aps_verify` → `src/verify.rs`）的报告。
 *
 * 重要边界：这里显示的每一条结论都来自引擎的 verifier，而不是前端自己判断的。
 * 前端不做“重新校验”，只做分组与呈现；这样实验室展示的违约/通过结论和 CLI、平台层一致。
 */

import type { VerifyReport } from '../core/types';
import { digestVerify } from '../core/aps/transform';

export interface VerifyPanelProps {
  report: VerifyReport | null;
  strict: boolean;
  loading?: boolean;
  unavailableReason?: string | null;
  fingerprint?: string | null;
}

export function VerifyPanel({ report, strict, loading, unavailableReason, fingerprint }: VerifyPanelProps) {
  if (loading) return <p className="muted">正在执行独立核验…</p>;
  if (unavailableReason) return <p className="warn-text">核验不可用：{unavailableReason}</p>;
  if (!report) return <p className="muted">本次运行未产生核验报告。</p>;

  const digest = digestVerify(report);
  const mode = report.mode ?? (strict ? 'strict' : 'permissive');

  return (
    <div className="verify-panel">
      <div className={`verify-head ${digest.ok ? 'ok' : 'bad'}`}>
        {digest.ok ? '✓ 独立核验通过：未发现违约' : `✗ 独立核验发现问题（errors=${digest.errors}）`}
        <span className="muted small"> · 模式 {mode}</span>
      </div>
      <div className="verify-counts muted small">
        violations {report.counts?.violations ?? 0} · errors {digest.errors} · warnings{' '}
        {digest.warnings} · issues {digest.issues}
        {fingerprint && <> · 方案指纹 <code>{fingerprint.slice(0, 22)}…</code></>}
        {report.parsed === false && ' · 输入未通过契约解析'}
      </div>
      {digest.byCode.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>代码</th>
              <th>级别</th>
              <th>数量</th>
              <th>示例</th>
            </tr>
          </thead>
          <tbody>
            {digest.byCode.map((row) => (
              <tr key={`${row.severity}:${row.code}`}>
                <td>
                  <code>{row.code}</code>
                </td>
                <td className={row.severity === 'error' ? 'bad-text' : 'warn-text'}>{row.severity}</td>
                <td>{row.count}</td>
                <td className="small">{row.sample}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {mode === 'permissive' && (
        <p className="muted small">
          当前为宽松模式：不要求方案绑定 <code>tenant_id</code> / <code>problem_hash</code>。
          勾选“严格模式”可复现服务端边界的绑定校验。
        </p>
      )}
    </div>
  );
}
