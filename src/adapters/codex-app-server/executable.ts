import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

// Explorer and elevated launches need not inherit the terminal's PATH.
export function resolveCodexExecutable(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32') return 'codex'
  const profile = env.USERPROFILE || homedir()
  const local = env.LOCALAPPDATA || join(profile, 'AppData', 'Local')
  const candidates: string[] = []
  const roots = [join(local, 'OpenAI', 'Codex', 'bin'), join(local, 'Programs', 'OpenAI', 'Codex', 'bin')]
  for (const root of roots) {
    try {
      const versions = readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(root, entry.name, 'codex.exe'))
        .filter(file => existsSync(file))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      candidates.push(...versions)
    } catch { /* The next installation location may exist. */ }
    candidates.push(join(root, 'codex.exe'))
  }
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || ''
  for (const directory of path.split(delimiter)) {
    const clean = directory.replace(/^"|"$/g, '')
    if (isAbsolute(clean)) candidates.push(join(clean, 'codex.exe'))
  }
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) return candidate } catch { /* Missing candidate. */ }
  }
  throw new Error('Bu Windows kullanıcısı için Codex bulunamadı. ChatGPT/Codex ile aynı Windows hesabında çalıştırın; yönetici olarak çalıştırmanız gerekmez.')
}
