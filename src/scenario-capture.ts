import { runWithTimeout } from "./exec.ts";
import { createMousePollers } from "./macos.ts";
import type { RecordedClickEvent } from "./scenario-record.ts";
import { frontmostCmd, parseFrontmost } from "./window.ts";

export type ClickPoint = { x: number; y: number };

type IntervalHandle = ReturnType<typeof setInterval>;

export type ClickEdgeDependencies = {
  pollButtonState: () => boolean;
  pollMouseLocation: () => ClickPoint;
  intervalMs: number;
  onClick: (point: ClickPoint, timestampMs: number) => void;
  now?: () => number;
  schedule?: (poll: () => void, intervalMs: number) => IntervalHandle;
  cancel?: (handle: IntervalHandle) => void;
};

/** Poll a button and report only released-to-pressed transitions. */
export function detectClickEdges(dependencies: ClickEdgeDependencies): { stop(): void } {
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.schedule ?? setInterval;
  const cancel = dependencies.cancel ?? clearInterval;
  let wasPressed = dependencies.pollButtonState();

  const handle = schedule(() => {
    const isPressed = dependencies.pollButtonState();
    if (!wasPressed && isPressed) {
      dependencies.onClick(dependencies.pollMouseLocation(), now());
    }
    wasPressed = isPressed;
  }, dependencies.intervalMs);

  return { stop: () => cancel(handle) };
}

export type MacOSClickCaptureOptions = {
  intervalMs?: number;
  accessibilityTimeoutMs?: number;
  onClick: (event: RecordedClickEvent) => void;
  onError?: (error: unknown) => void;
};

/** Connect the pure edge detector to CoreGraphics and the existing AX query. */
export async function captureMacOSClicks(
  options: MacOSClickCaptureOptions,
): Promise<{ stop(): void }> {
  const pollers = await createMousePollers();
  const { listElements } = await import("./cli.ts");
  let pending = Promise.resolve();

  return detectClickEdges({
    ...pollers,
    intervalMs: options.intervalMs ?? 20,
    onClick: (point, timestampMs) => {
      pending = pending.then(async () => {
        const result = await runWithTimeout(frontmostCmd("macos"), 5_000);
        if (result.code !== 0 || result.timedOut) {
          throw new Error("could not determine the frontmost application");
        }
        const app = parseFrontmost(result.stdout).split(" ")[0] ?? "";
        const { els } = await listElements(
          "macos",
          app,
          options.accessibilityTimeoutMs ?? 5_000,
        );
        options.onClick({ point, timestampMs, elements: els });
      }).catch((error) => options.onError?.(error));
    },
  });
}
