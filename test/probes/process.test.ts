import { describe, expect, test } from "bun:test";
import { detectOS } from "../../src/os.ts";
import { probeProcess } from "../../src/probes/process.ts";
import { parseProbeResult } from "../../src/probes/types.ts";

describe("process probe", () => {
  const platform = detectOS();

  test("reports the current process", async () => {
    const result = await probeProcess(process.pid, platform);

    expect(result.found).toBe(true);
    expect(result.status).toBe("found");
    expect(result.normalized?.pid).toBe(process.pid);
    expect(parseProbeResult(result).ok).toBe(true);
  });

  test("reports a missing process", async () => {
    const result = await probeProcess(999_999, platform);

    expect(result.status).toBe("not-found");
    expect(result.found).toBe(false);
    expect(result.normalized).toBeNull();
  });

  test("reports unsupported platforms as unavailable", async () => {
    const result = await probeProcess(process.pid, "windows");

    expect(result.status).toBe("unavailable");
    expect(result.found).toBe(false);
    expect(result.normalized).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(parseProbeResult(result).ok).toBe(true);
  });
});
