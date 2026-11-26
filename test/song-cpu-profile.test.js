import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The wrapper contract can be tested with stdlib-only stubs; no Torch/model downloads.
const python = [process.env.PYTHON, 'python3', 'python'].filter(Boolean)
  .find(cmd => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0)
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-cpu-profile-'))
  const setup = join(root, 'setup'), project = join(root, 'Applio')
  mkdirSync(setup); mkdirSync(join(project, 'rvc', 'configs'), { recursive: true })
  const entry = join(setup, 'song-cpu-infer.py'), trace = join(root, 'trace.json')
  copyFileSync(new URL('../src/local/templates/song-cpu-infer.py', import.meta.url), entry)
  writeFileSync(join(setup, 'torch.py'), `from types import SimpleNamespace
backends = SimpleNamespace(mkldnn=SimpleNamespace(enabled=True))
def set_num_threads(n): globals()['threads'] = n
def set_num_interop_threads(n): globals()['interop'] = n
`)
  writeFileSync(join(project, 'rvc', 'configs', 'config.py'), `from types import SimpleNamespace
config = SimpleNamespace(device='cuda:0', x_query=6, x_center=38, x_max=41)
def Config(): return config
`)
  writeFileSync(join(project, 'core.py'), `import os, sys, json, torch
from rvc.configs.config import Config
with open(os.environ['TRACE'], 'w') as f:
 json.dump(dict(argv=sys.argv, cwd=os.getcwd(), device=Config().device, segments=[Config().x_query,Config().x_center,Config().x_max], mkldnn=torch.backends.mkldnn.enabled, threads=torch.threads, interop=torch.interop, omp=os.environ['OMP_NUM_THREADS'], mkl=os.environ['MKL_NUM_THREADS']), f)
`)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { entry, project, trace }
}
for (const value of [undefined, '4']) test(`可选 CPU 入口：线程 ${value || '默认'}，保留推理参数和短分段`, { skip: !python }, t => {
  const f = fixture(t), env = { ...process.env, TRACE: f.trace }
  delete env.AURABOT_RVC_CPU_THREADS
  if (value !== undefined) env.AURABOT_RVC_CPU_THREADS = value
  const args = ['infer', '--input-path', '带空格 input.wav', '--output-path', 'output.wav', '--pitch', '0']
  const r = spawnSync(python, [f.entry, ...args], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const trace = JSON.parse(readFileSync(f.trace, 'utf8'))
  assert.deepEqual(trace.argv, [join(f.project, 'core.py'), ...args])
  assert.equal(trace.cwd, f.project)
  assert.equal(trace.device, 'cpu')
  assert.equal(trace.mkldnn, false)
  assert.deepEqual(trace.segments, [1, 6, 8])
  assert.equal(trace.threads, Number(value || 1))
  assert.equal(trace.interop, 1)
  assert.equal(trace.omp, value || '1')
  assert.equal(trace.mkl, value || '1')
})
for (const value of ['0', 'not-a-number']) test(`非法线程数 ${value} 在加载模型前拒绝`, { skip: !python }, t => {
  const f = fixture(t)
  const r = spawnSync(python, [f.entry, 'infer'], { env: { ...process.env, AURABOT_RVC_CPU_THREADS: value, TRACE: f.trace }, encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /must be a positive integer/)
})
