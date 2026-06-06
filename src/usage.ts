import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type UsageRecord = {
  id: string;
  timestamp: string;
  requestedModel: string;
  providerId: string;
  providerName: string;
  actualModel: string;
  stream: boolean;
  success: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
};

export type UsageSummary = {
  totalCalls: number;
  successCalls: number;
  failureCalls: number;
  byProvider: Array<UsageBucket>;
  byModel: Array<UsageBucket>;
  recent: UsageRecord[];
};

export type UsageBucket = {
  id: string;
  calls: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
};

export class UsageStore {
  private readonly records: UsageRecord[] = [];
  private readonly filePath = resolve(process.cwd(), "usage-log.jsonl");

  constructor(private readonly maxMemoryRecords = 1000) {
    this.loadRecent();
  }

  record(record: UsageRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxMemoryRecords) {
      this.records.shift();
    }
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  summary(): UsageSummary {
    return {
      totalCalls: this.records.length,
      successCalls: this.records.filter((record) => record.success).length,
      failureCalls: this.records.filter((record) => !record.success).length,
      byProvider: bucketize(this.records, (record) => record.providerId),
      byModel: bucketize(this.records, (record) => record.actualModel),
      recent: [...this.records].slice(-50).reverse()
    };
  }

  private loadRecent(): void {
    if (!existsSync(this.filePath)) return;
    const lines = readFileSync(this.filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(-this.maxMemoryRecords)) {
      try {
        this.records.push(JSON.parse(line) as UsageRecord);
      } catch {
        // Ignore corrupt historical log lines.
      }
    }
  }
}

function bucketize(records: UsageRecord[], keyOf: (record: UsageRecord) => string): UsageBucket[] {
  const map = new Map<string, { calls: number; successes: number; failures: number; latency: number; inputTokens: number; outputTokens: number }>();

  for (const record of records) {
    const key = keyOf(record);
    const bucket = map.get(key) ?? { calls: 0, successes: 0, failures: 0, latency: 0, inputTokens: 0, outputTokens: 0 };
    bucket.calls += 1;
    bucket.successes += record.success ? 1 : 0;
    bucket.failures += record.success ? 0 : 1;
    bucket.latency += record.latencyMs;
    bucket.inputTokens += record.inputTokens ?? 0;
    bucket.outputTokens += record.outputTokens ?? 0;
    map.set(key, bucket);
  }

  return [...map.entries()]
    .map(([id, bucket]) => ({
      id,
      calls: bucket.calls,
      successes: bucket.successes,
      failures: bucket.failures,
      avgLatencyMs: Math.round(bucket.latency / Math.max(bucket.calls, 1)),
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens
    }))
    .sort((a, b) => b.calls - a.calls);
}
