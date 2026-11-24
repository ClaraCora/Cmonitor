import type { Node } from "./api.ts"

export type InventorySnapshot = { seq: number | null; nodes: Node[] }
type InventoryFrame = {
  admin?: boolean; nodes?: Node[]; seq?: number; base?: number; order?: number[]
  drop?: number[]; put?: Node[]; patch?: {id: number; set?: Partial<Node>}[]
}

// Inventory screens read configuration, reachability, capacities and billed
// counters. Older Hubs may also send nested chart patches, which they do not use.
export function nextInventory(previous: InventorySnapshot | null, frame: InventoryFrame): InventorySnapshot {
  if (Array.isArray(frame.nodes)) {
    if (frame.admin !== true || (frame.seq !== undefined && !Number.isSafeInteger(frame.seq))) throw new Error("invalid inventory")
    return {nodes: frame.nodes, seq: frame.seq ?? null}
  }
  if (!previous || previous.seq === null || frame.base !== previous.seq || !Number.isSafeInteger(frame.seq) || frame.seq! <= previous.seq) {
    throw new Error("inventory out of sequence")
  }
  const rows = new Map(previous.nodes.map(node => [node.id, node]))
  for (const id of frame.drop ?? []) if (!rows.delete(id)) throw new Error("unknown inventory removal")
  for (const node of frame.put ?? []) {
    if (!Number.isSafeInteger(node.id)) throw new Error("invalid node")
    rows.set(node.id, node)
  }
  for (const patch of frame.patch ?? []) {
    const old = rows.get(patch.id)
    if (!old || (patch.set?.id !== undefined && patch.set.id !== old.id)) throw new Error("invalid inventory patch")
    if (patch.set) rows.set(old.id, {...old, ...patch.set})
  }
  if (frame.order && (frame.order.length !== rows.size || new Set(frame.order).size !== rows.size)) throw new Error("invalid inventory order")
  const nodes = Array.from(frame.order ?? rows.keys(), id => {
    const node = rows.get(id)
    if (!node) throw new Error("unknown inventory node")
    return node
  })
  return {seq: frame.seq!, nodes}
}
