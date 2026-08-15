import { describe, expect, test } from "bun:test";
import { detectOS } from "../../src/os.ts";
import { probePort } from "../../src/probes/port.ts";
import { parseProbeResult } from "../../src/probes/types.ts";

describe("port probe", () => {
  const platform = detectOS();

  test("reports a live TCP listener", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });

    try {
      const result = await probePort(listener.port, "tcp", platform);

      expect(result.found).toBe(true);
      expect(result.status).toBe("found");
      expect(result.normalized?.port).toBe(listener.port);
      expect(parseProbeResult(result).ok).toBe(true);
    } finally {
      listener.stop(true);
    }
  }, 15_000);

  test("reports a port without a listener", async () => {
    const result = await probePort(59_999, "tcp", platform);

    expect(result.status).toBe("not-found");
    expect(result.found).toBe(false);
    expect(result.normalized).toBeNull();
  }, 15_000);

  test("reports unsupported platforms as unavailable", async () => {
    const result = await probePort(80, "tcp", "unknown");

    expect(result.status).toBe("unavailable");
    expect(result.found).toBe(false);
    expect(result.normalized).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(parseProbeResult(result).ok).toBe(true);
  });
});
