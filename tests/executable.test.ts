import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
vi.mock('node:fs', () => ({ existsSync: vi.fn(), readdirSync: vi.fn(), statSync: vi.fn() }))
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolveCodexExecutable } from '../src/adapters/codex-app-server/executable'

describe.skipIf(process.platform !== 'win32')('Windows executable discovery', () => {
  it('finds the current version with no PATH, ahead of an old root executable', () => {
    const root = join('C:\\UserData', 'OpenAI', 'Codex', 'bin')
    vi.mocked(readdirSync).mockImplementation(((p: string) => p === root ? [{ name: 'new', isDirectory: () => true }] : []) as never)
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(statSync).mockReturnValue({ isFile: () => true, mtimeMs: 100 } as never)
    expect(resolveCodexExecutable({ LOCALAPPDATA: 'C:\\UserData' })).toBe(join(root, 'new', 'codex.exe'))
  })
  it('reports missing Codex without falling back to a relative command', () => {
    vi.mocked(readdirSync).mockReturnValue([])
    vi.mocked(statSync).mockImplementation(() => { throw new Error('missing') })
    expect(() => resolveCodexExecutable({ LOCALAPPDATA: 'C:\\Absent', PATH: '.' })).toThrow('Codex bulunamadı')
  })
})
