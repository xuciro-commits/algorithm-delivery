import type { PlanProblemLike } from '../types';

/**
 * Public benchmark adapters used by the browser-side APS data picker.
 *
 * Supported inputs:
 * - Brandimarte / FJSPLib single-instance FJSP text (`.fjs`, `.fjsp`, or `.txt`):
 *   `jobs machines [average-flexibility]`, followed by one job record per job.
 *   Machine IDs in this format are 1-based; each operation stores `count, machine, time...`.
 * - OR-Library `jobshop1` JSSP text (`.jsp`, `.jssp`, or `.txt`):
 *   one or more `instance NAME` blocks, each with `jobs machines` and one row of
 *   0-based `machine, processing-time` pairs per job.
 *
 * The conversion deliberately models only the classic shop constraints. APS needs a
 * worker resource, so we create one generic worker per machine and give all resources
 * a continuous calendar; tools, materials, worker qualifications and shifts are not
 * inferred from a benchmark that does not contain those concepts.
 */

export interface StandardBenchmarkEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  expect: string;
  operations: number;
  orders: number;
  machines: number;
  problem: PlanProblemLike;
}

export interface StandardBenchmarkImportResult {
  handled: boolean;
  entries?: StandardBenchmarkEntry[];
  error?: string;
}

interface ShopOperation {
  alternatives: Array<{ machine: number; duration: number }>;
}

interface ShopInstance {
  family: 'FJSP' | 'JSP';
  instanceName: string;
  jobs: ShopOperation[][];
  machines: number;
}

interface NumericLine {
  lineNumber: number;
  values: number[];
}

const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_INSTANCES = 100;
const MAX_JOBS = 300;
const MAX_MACHINES = 128;
const MAX_OPERATIONS_PER_INSTANCE = 600;
const MAX_OPERATIONS_PER_IMPORT = 50_000;
const MAX_DURATION_MIN = 10_000_000;
const HORIZON_START_MS = Date.UTC(2026, 9, 5, 8, 0, 0);
const GENERIC_SKILL = 'benchmark-process';

const INSTANCE_MARKER = /^\s*instance\s+([a-z0-9_.-]+)\s*$/gim;

function extensionOf(fileName: string): string {
  return fileName.toLowerCase().split('.').pop() ?? '';
}

function safeName(fileName: string): string {
  return fileName.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') || 'instance';
}

function safeSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'instance';
}

function numericLines(text: string): NumericLine[] {
  const out: NumericLine[] = [];
  for (const [index, original] of text.split(/\r?\n/).entries()) {
    const line = original.replace(/(?:#|;|\/\/).*$/, '').trim();
    if (!line) continue;
    if (!/^[+-]?\d+(?:\.\d+)?(?:\s+[+-]?\d+(?:\.\d+)?)*$/.test(line)) continue;
    const values = line.split(/\s+/).map(Number);
    if (values.every(Number.isFinite)) out.push({ lineNumber: index + 1, values });
  }
  return out;
}

function validDimensions(jobs: number, machines: number): boolean {
  return (
    Number.isInteger(jobs) && jobs > 0 && jobs <= MAX_JOBS &&
    Number.isInteger(machines) && machines > 0 && machines <= MAX_MACHINES
  );
}

function integerToken(value: number | undefined, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} 应为整数`);
  return value as number;
}

function parseFjspSegment(text: string, instanceName: string): ShopInstance | null {
  const lines = numericLines(text);
  for (let headerIndex = 0; headerIndex < lines.length; headerIndex += 1) {
    const header = lines[headerIndex].values;
    if (header.length !== 2 && header.length !== 3) continue;
    const jobsCount = header[0];
    const machineCount = header[1];
    if (!validDimensions(jobsCount, machineCount)) continue;

    const bodyLines = lines.slice(headerIndex + 1);
    if (bodyLines.some((line) => line.values.some((v) => !Number.isInteger(v)))) continue;
    const tokens = bodyLines.flatMap((line) => line.values);
    let cursor = 0;
    const take = (label: string): number => {
      if (cursor >= tokens.length) throw new Error(`数据不完整：缺少${label}`);
      const value = integerToken(tokens[cursor], label);
      cursor += 1;
      return value;
    };

    try {
      const parsedJobs: ShopOperation[][] = [];
      let operationCount = 0;
      for (let jobIndex = 0; jobIndex < jobsCount; jobIndex += 1) {
        const operationCountForJob = take(`第 ${jobIndex + 1} 个作业的工序数`);
        if (operationCountForJob < 1 || operationCountForJob > MAX_OPERATIONS_PER_INSTANCE) {
          throw new Error(`第 ${jobIndex + 1} 个作业的工序数 ${operationCountForJob} 不在支持范围内`);
        }
        operationCount += operationCountForJob;
        if (operationCount > MAX_OPERATIONS_PER_INSTANCE) {
          throw new Error(`该实例有 ${operationCount} 道工序，浏览器 WASM 档位最多支持 ${MAX_OPERATIONS_PER_INSTANCE} 道`);
        }

        const operations: ShopOperation[] = [];
        for (let operationIndex = 0; operationIndex < operationCountForJob; operationIndex += 1) {
          const alternativeCount = take(`第 ${jobIndex + 1} 个作业第 ${operationIndex + 1} 道工序的候选机器数`);
          if (alternativeCount < 1 || alternativeCount > machineCount) {
            throw new Error(`候选机器数 ${alternativeCount} 必须在 1 到 ${machineCount} 之间`);
          }
          const alternatives: ShopOperation['alternatives'] = [];
          const seenMachines = new Set<number>();
          for (let alternativeIndex = 0; alternativeIndex < alternativeCount; alternativeIndex += 1) {
            const machineNumber = take('机器编号');
            const duration = take('加工时间');
            if (machineNumber < 1 || machineNumber > machineCount) {
              throw new Error(`机器编号 ${machineNumber} 超出 Brandimarte/FJSPLib 的 1-based 范围 1–${machineCount}`);
            }
            if (duration < 1 || duration > MAX_DURATION_MIN) {
              throw new Error(`加工时间 ${duration} 必须为 1 到 ${MAX_DURATION_MIN} 分钟之间的正整数`);
            }
            if (seenMachines.has(machineNumber)) throw new Error(`同一道工序重复指定机器 ${machineNumber}`);
            seenMachines.add(machineNumber);
            alternatives.push({ machine: machineNumber - 1, duration });
          }
          operations.push({ alternatives });
        }
        parsedJobs.push(operations);
      }
      if (cursor !== tokens.length) throw new Error(`实例尾部还有 ${tokens.length - cursor} 个未识别数字`);
      return { family: 'FJSP', instanceName, jobs: parsedJobs, machines: machineCount };
    } catch {
      // A numeric line in a preamble can look like a header. Try later candidates
      // before returning an error, but only accept an exact parse of the segment.
    }
  }
  return null;
}

function parseJsspSegment(text: string, instanceName: string): ShopInstance | null {
  const lines = numericLines(text);
  for (let headerIndex = 0; headerIndex < lines.length; headerIndex += 1) {
    const header = lines[headerIndex].values;
    if (header.length !== 2) continue;
    const jobsCount = header[0];
    const machineCount = header[1];
    if (!validDimensions(jobsCount, machineCount)) continue;

    const jobLines = lines.slice(headerIndex + 1, headerIndex + 1 + jobsCount);
    if (jobLines.length !== jobsCount) continue;
    if (lines.length !== headerIndex + 1 + jobsCount) continue;

    try {
      const jobs: ShopOperation[][] = jobLines.map((line, jobIndex) => {
        if (line.values.length !== machineCount * 2) {
          throw new Error(`作业 ${jobIndex + 1} 应包含 ${machineCount} 组 (machine, time)`);
        }
        const seenMachines = new Set<number>();
        const operations: ShopOperation[] = [];
        for (let i = 0; i < line.values.length; i += 2) {
          const machine = integerToken(line.values[i], '机器编号');
          const duration = integerToken(line.values[i + 1], '加工时间');
          if (machine < 0 || machine >= machineCount) {
            throw new Error(`机器编号 ${machine} 超出 OR-Library 的 0-based 范围 0–${machineCount - 1}`);
          }
          if (duration < 1 || duration > MAX_DURATION_MIN) {
            throw new Error(`加工时间 ${duration} 必须为 1 到 ${MAX_DURATION_MIN} 分钟之间的正整数`);
          }
          if (seenMachines.has(machine)) throw new Error(`作业 ${jobIndex + 1} 重复访问机器 ${machine}`);
          seenMachines.add(machine);
          operations.push({ alternatives: [{ machine, duration }] });
        }
        return operations;
      });
      return { family: 'JSP', instanceName, jobs, machines: machineCount };
    } catch {
      // Keep looking: a two-number metadata line may precede the actual instance.
    }
  }
  return null;
}

function isoMinute(epochMs: number): string {
  const date = new Date(epochMs);
  const part = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${part(date.getUTCMonth() + 1)}-${part(date.getUTCDate())}T${part(date.getUTCHours())}:${part(date.getUTCMinutes())}:00Z`;
}

function convertInstance(instance: ShopInstance): StandardBenchmarkEntry {
  const operationCount = instance.jobs.reduce((sum, job) => sum + job.length, 0);
  if (operationCount < 1 || operationCount > MAX_OPERATIONS_PER_INSTANCE) {
    throw new Error(`实例有 ${operationCount} 道工序；当前浏览器 WASM 档位最多支持 ${MAX_OPERATIONS_PER_INSTANCE} 道`);
  }
  const serialUpperBound = instance.jobs.reduce(
    (sum, job) => sum + job.reduce((jobSum, operation) => jobSum + Math.max(...operation.alternatives.map((a) => a.duration)), 0),
    0,
  );
  const horizonEndMs = HORIZON_START_MS + (serialUpperBound + 60) * 60_000;
  if (!Number.isFinite(horizonEndMs) || !Number.isFinite(new Date(horizonEndMs).getTime())) {
    throw new Error('累计加工时间超出可用日期范围');
  }
  const startAt = isoMinute(HORIZON_START_MS);
  const endAt = isoMinute(horizonEndMs);
  const calendar = [{ start: startAt, end: endAt }];
  const machineIds = Array.from({ length: instance.machines }, (_, index) => `M${String(index + 1).padStart(2, '0')}`);
  const workerIds = Array.from({ length: instance.machines }, (_, index) => `W${String(index + 1).padStart(2, '0')}`);
  const jobs = instance.jobs.map((operations, jobIndex) => {
    const orderId = `J${String(jobIndex + 1).padStart(3, '0')}`;
    const opIds = operations.map((_, operationIndex) => `${orderId}-O${String(operationIndex + 1).padStart(3, '0')}`);
    return {
      id: orderId,
      quantity: 1,
      priority: 1,
      release_at: startAt,
      due_at: endAt,
      operations: operations.map((operation, operationIndex) => ({
        id: opIds[operationIndex],
        predecessors: operationIndex === 0 ? [] : [opIds[operationIndex - 1]],
        skill: GENERIC_SKILL,
        qualifications: [],
        worker_count: 1,
        alternatives: operation.alternatives.map((alternative) => ({
          machine_id: machineIds[alternative.machine],
          duration_min: alternative.duration,
        })),
        tools: [],
        materials: {},
      })),
    };
  });
  const slug = safeSlug(instance.instanceName);
  const source = instance.family === 'FJSP'
    ? 'FJSPLib · Brandimarte / FJSP text format'
    : 'OR-Library · jobshop1 / JSSP format';
  const assumptions = '作业顺序、候选机器与加工时间已映射；人员使用通用占位资源，按连续日历运行，不含工装、物料、班次或人员技能约束。';
  const problem: PlanProblemLike = {
    meta: {
      schema_version: 'plan-problem/1.0',
      tenant_id: 'benchmark-import',
      site_id: 'benchmark-shop',
      snapshot_id: `standard-${instance.family.toLowerCase()}-${slug}`,
      timezone: 'UTC',
      horizon_start: startAt,
      horizon_end: endAt,
      resolution_min: 1,
    },
    machines: machineIds.map((id) => ({
      id,
      capabilities: [GENERIC_SKILL],
      available: calendar,
      blocked: [],
    })),
    workers: workerIds.map((id) => ({
      id,
      skills: [GENERIC_SKILL],
      qualifications: [],
      available: calendar,
      blocked: [],
    })),
    tools: [],
    materials: [],
    orders: jobs,
    objective: {
      strategy: 'makespan',
      phases: ['makespan'],
      time_limit_ms: 2_000,
      seed: 42,
    },
  };
  return {
    id: `standard:${instance.family.toLowerCase()}:${slug}`,
    name: `${instance.family} · ${instance.instanceName}`,
    description: `${source}；${assumptions}`,
    source,
    expect: '仅比较 makespan；转换数据不含原模型之外的人员、日历、工装或物料约束。',
    operations: operationCount,
    orders: jobs.length,
    machines: machineIds.length,
    problem,
  };
}

function markersIn(text: string): Array<{ name: string; start: number; end: number }> {
  const markers: Array<{ name: string; start: number; end: number }> = [];
  const matcher = new RegExp(INSTANCE_MARKER.source, INSTANCE_MARKER.flags);
  for (const match of text.matchAll(matcher)) {
    if (match.index === undefined) continue;
    markers.push({ name: match[1], start: match.index, end: match.index + match[0].length });
  }
  return markers;
}

function parseSegment(text: string, instanceName: string, extension: string): ShopInstance | null {
  if (extension === 'fjs' || extension === 'fjsp') return parseFjspSegment(text, instanceName);
  if (extension === 'jsp' || extension === 'jssp') return parseJsspSegment(text, instanceName);

  const firstHeader = numericLines(text).find((line) => {
    const [jobs, machines] = line.values;
    return (line.values.length === 2 || line.values.length === 3) && validDimensions(jobs, machines);
  });
  // OR-Library starts with a two-number header; FJSPLib commonly adds an average-
  // flexibility field. Try the matching grammar first, then the alternate text form.
  if (firstHeader?.values.length === 2) {
    return parseJsspSegment(text, instanceName) ?? parseFjspSegment(text, instanceName);
  }
  return parseFjspSegment(text, instanceName) ?? parseJsspSegment(text, instanceName);
}

/** Return `handled: false` for file extensions outside the supported benchmark text formats. */
export function importStandardBenchmarks(text: string, fileName: string): StandardBenchmarkImportResult {
  const extension = extensionOf(fileName);
  const supportedExtension = ['fjs', 'fjsp', 'jsp', 'jssp', 'txt'].includes(extension);
  if (!supportedExtension) return { handled: false };
  if (text.length > MAX_TEXT_CHARS) {
    return { handled: true, error: `基准文本超过 ${Math.round(MAX_TEXT_CHARS / 1024 / 1024)} MiB 上限，请选取单个实例文件。` };
  }

  const markers = markersIn(text);
  if (markers.length > MAX_INSTANCES) {
    return { handled: true, error: `文件包含 ${markers.length} 个实例，单次最多导入 ${MAX_INSTANCES} 个。` };
  }
  const segments = markers.length > 0
    ? markers.map((marker, index) => ({
        name: marker.name,
        text: text.slice(marker.end, markers[index + 1]?.start ?? text.length),
      }))
    : [{ name: safeName(fileName), text }];

  const parsed: ShopInstance[] = [];
  let totalOperations = 0;
  for (const segment of segments) {
    const instance = parseSegment(segment.text, segment.name, extension);
    if (!instance) {
      return {
        handled: true,
        error: `无法解析实例「${segment.name}」。支持 FJSPLib/Brandimarte FJSP 文本（.fjs/.fjsp/.txt）及 OR-Library jobshop1 JSSP 文本（.jsp/.jssp/.txt）。`,
      };
    }
    const operations = instance.jobs.reduce((sum, job) => sum + job.length, 0);
    totalOperations += operations;
    if (totalOperations > MAX_OPERATIONS_PER_IMPORT) {
      return {
        handled: true,
        error: `本文件展开后超过 ${MAX_OPERATIONS_PER_IMPORT.toLocaleString()} 道工序的批量导入上限，请分批选择实例。`,
      };
    }
    parsed.push(instance);
  }

  try {
    return { handled: true, entries: parsed.map(convertInstance) };
  } catch (err) {
    return { handled: true, error: err instanceof Error ? err.message : String(err) };
  }
}
