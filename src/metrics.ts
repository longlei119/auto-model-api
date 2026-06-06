import type { ProviderMetric } from "./types.js";

export class MetricsStore {
  private readonly metrics = new Map<string, ProviderMetric>();

  recordSuccess(providerId: string, model: string, latencyMs: number): void {
    const metric = this.get(providerId, model);
    metric.successCount += 1;
    metric.lastOkAt = Date.now();
    metric.latencies.push(latencyMs);
    if (metric.latencies.length > 50) {
      metric.latencies.shift();
    }
  }

  recordFailure(providerId: string, model: string): void {
    const metric = this.get(providerId, model);
    metric.failureCount += 1;
    metric.lastErrorAt = Date.now();
  }

  score(providerId: string, model: string): number {
    const metric = this.get(providerId, model);
    const latency = percentile(metric.latencies, 50) ?? 60000;
    const total = metric.successCount + metric.failureCount;
    const successRate = total === 0 ? 0.5 : metric.successCount / total;
    return latency / Math.max(successRate, 0.05);
  }

  snapshot(): ProviderMetric[] {
    return [...this.metrics.values()].map((metric) => ({
      ...metric,
      latencies: [...metric.latencies]
    }));
  }

  private get(providerId: string, model: string): ProviderMetric {
    const key = `${providerId}:${model}`;
    const existing = this.metrics.get(key);
    if (existing) return existing;

    const metric: ProviderMetric = {
      providerId,
      model,
      successCount: 0,
      failureCount: 0,
      latencies: []
    };
    this.metrics.set(key, metric);
    return metric;
  }
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}
