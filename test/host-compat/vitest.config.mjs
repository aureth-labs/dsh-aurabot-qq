import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Invoke the DSH vitest binary with its source checkout as the working directory.
const dsh = process.cwd()
const requireDsh = createRequire(join(dsh, 'package.json'))
const ts = requireDsh('typescript')
const root = dirname(fileURLToPath(import.meta.url))
const { config, error } = ts.readConfigFile(join(dsh, 'tsconfig.base.json'), ts.sys.readFile)
if (error) throw new Error('Run the compatibility tests from the target DSH source checkout')
const alias = Object.entries(config.compilerOptions.paths).flatMap(([name, [path]]) =>
  name.endsWith('/*') ? [] : [{ find: name, replacement: join(dsh, path).replaceAll('\\', '/') }])
alias.push({ find: 'vitest', replacement: requireDsh.resolve('vitest', { paths: [dsh] }).replace(/index.cjs$/, 'dist/index.js') })
alias.push({ find: 'dsh-probe-source', replacement: dsh.replaceAll('\\', '/') })

export default {
  root,
  resolve: { alias },
  plugins: [{
    name: 'dsh-decorators',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.ts') || !/^\s*@[A-Za-z_$][\w$]*/m.test(code)) return
      return ts.transpileModule(code, {
        fileName: id,
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
      }).outputText
    },
  }],
  test: {
    include: ['*.spec.ts'],
    cache: false,
    pool: 'forks',
    execArgv: process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : [],
  },
}
