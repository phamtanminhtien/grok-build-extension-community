export interface VirtualWindow {
  start: number;
  end: number; // exclusive
}

/**
 * Compute which message indices to mount given scroll metrics.
 */
export function computeVirtualWindow(args: {
  total: number;
  scrollTop: number;
  viewportHeight: number;
  estimatedRowHeight: number;
  overscan?: number;
}): VirtualWindow {
  const { total, scrollTop, viewportHeight, estimatedRowHeight } = args;
  const overscan = args.overscan ?? 5;
  if (total <= 0 || estimatedRowHeight <= 0) {
    return { start: 0, end: 0 };
  }
  const first = Math.floor(scrollTop / estimatedRowHeight);
  const visible = Math.ceil(viewportHeight / estimatedRowHeight);
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + visible + overscan);
  return { start, end };
}

export function shouldStickToBottom(
  scrollTop: number,
  scrollHeight: number,
  viewportHeight: number,
  thresholdPx = 48,
): boolean {
  return scrollTop + viewportHeight >= scrollHeight - thresholdPx;
}
