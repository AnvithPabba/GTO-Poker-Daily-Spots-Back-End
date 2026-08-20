export type MetricSnapshot = { counters: Record<string, number>; gauges: Record<string, number> };

export interface MetricsStore {
  increment(name: string, value?: number): void;
  gauge(name: string, value: number): void;
  snapshot(): MetricSnapshot;
}

/** Process-local metrics are deliberately small and replaceable. Production
 * can adapt this port to Prometheus/OpenTelemetry without changing use cases. */
export class InMemoryMetricsStore implements MetricsStore {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  public increment(name: string, value = 1): void { this.counters.set(name, (this.counters.get(name) ?? 0) + value); }
  public gauge(name: string, value: number): void { this.gauges.set(name, value); }
  public snapshot(): MetricSnapshot { return { counters: Object.fromEntries(this.counters), gauges: Object.fromEntries(this.gauges) }; }
}

export interface AlertSink { alert(name: string, metadata?: Record<string, string | number | boolean>): void; }

export class StructuredAlertSink implements AlertSink {
  public readonly events: Array<{ name: string; metadata?: Record<string, string | number | boolean> }> = [];
  public alert(name: string, metadata?: Record<string, string | number | boolean>): void {
    this.events.push({ name, ...(metadata ? { metadata } : {}) });
    console.warn(JSON.stringify({ event: "operational_alert", name, ...(metadata ? { metadata } : {}) }));
  }
}
