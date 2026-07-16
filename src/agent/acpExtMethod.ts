/**
 * ACP extension methods on the wire must be `_`-prefixed so the protocol
 * decoder routes them to `Agent::ext_method`. Logical names (`x.ai/foo`)
 * and already-prefixed wire names (`_x.ai/foo`) are both accepted.
 *
 * Without the prefix, the agent returns JSON-RPC -32601 method_not_found
 * before any handler runs.
 */
export function toAcpExtWireMethod(method: string): string {
  const m = method.trim();
  if (!m) {
    return m;
  }
  if (m.startsWith("_")) {
    return m;
  }
  return `_${m}`;
}
