import { describe, expect, it } from "vitest";
import { InMemoryMetricsStore, StructuredAlertSink } from "../src/metrics.js";

describe("operational ports", () => {
  it("keeps deterministic counters and gauges", () => {
    const metrics = new InMemoryMetricsStore();
    metrics.increment("requests"); metrics.increment("requests", 2); metrics.gauge("buffer", 7);
    expect(metrics.snapshot()).toEqual({ counters: { requests: 3 }, gauges: { buffer: 7 } });
  });
  it("records structured alerts without coupling to a vendor", () => {
    const sink = new StructuredAlertSink(); sink.alert("buffer.low", { depth: 2 });
    expect(sink.events).toEqual([{ name: "buffer.low", metadata: { depth: 2 } }]);
  });
});
