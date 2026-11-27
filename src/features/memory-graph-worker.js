import { parentPort, workerData } from 'node:worker_threads'
import { buildEdges, layoutGraph3d } from './memory-graph.js'

// 模块源码索引也会从主线程导入本文件。
if (parentPort) {
  const { items, prev, day } = workerData
  const edges = buildEdges(items)
  const out = layoutGraph3d(items, { edges, prev, now: Date.now(), day })
  parentPort.postMessage({ edges, out })
}
