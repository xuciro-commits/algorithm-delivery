/**
 * 断言脚本的共享外壳（纯 Node，零依赖）。
 *
 * 仓库里有二十多个 `scripts/*.mjs` 检查脚本，它们本来各自手写一份
 * 「failures 数组 + check 函数 + 结尾打印汇总 + process.exit(1)」。
 * 那份样板重复了二十多遍，输出格式和退出码还容易写歪，于是收到这里：
 *
 *   import { createHarness } from './lib/harness.mjs';
 *   const { check, note, warn, finish } = createHarness('MAPF 回放测试');
 *   check('步进不越界', clock.t <= steps);
 *   finish('MAPF 回放测试全部通过');   // 有失败时自动非零退出
 *
 * 约定：
 *   - `check(name, ok, detail?)` 失败即计入失败集合，结尾统一汇总；
 *   - `warn(...)` 只打印提示，不影响退出码（例如“素材清单与磁盘有差异”）；
 *   - `note(...)` 打印补充信息（`·` 前缀），不参与判定；
 *   - `finish(message)` 是唯一出口，成功时打印 `✓ message`。
 *
 * 需要直接往失败集合里塞自定义信息时，用 `h.failures.push(...)`。
 */

/**
 * @param {string} title 失败汇总里显示的名字（例如「性能红线审计」）
 */
export function createHarness(title) {
  const failures = [];

  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    // 失败条目带上 detail，便于 CI 日志直接定位（成功时不进集合）
    if (!ok) failures.push(detail ? `${name}（${detail}）` : name);
    return Boolean(ok);
  };

  const note = (message) => console.log(`· ${message}`);

  const warn = (name, detail = '') => {
    console.log(`⚠ ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const section = (name) => console.log(`\n— ${name} —`);

  const finish = (successMessage) => {
    console.log('');
    if (failures.length > 0) {
      console.error(`✗ ${title}失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
      process.exit(1);
    }
    console.log(`✓ ${successMessage.trim().replace(/^\n+/, '').replace(/^✓\s*/, '')}`);
  };

  return { check, note, warn, section, finish, failures };
}
