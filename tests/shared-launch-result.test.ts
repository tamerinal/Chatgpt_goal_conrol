import { describe, expect, it } from 'vitest'
import { executeLauncher, runSharedCodexLauncher } from '../src/main/shared-codex-launcher'

const options = { windowsHide: true, timeout: 5_000, maxBuffer: 1_024 }

describe('launcher process result', () => {
  it('returns launcher output while treating stderr as diagnostic on exit zero', async () => {
    const result = await executeLauncher(process.execPath, ['-e', 'process.stdout.write("LAUNCH_OK"); process.stderr.write("diagnostic")'], options)
    expect(result.stdout).toBe('LAUNCH_OK')
  })
  it('preserves a nonzero launcher exit and its bounded error text', async () => {
    await expect(executeLauncher(process.execPath, ['-e', 'process.stderr.write("launch refused: " + "x".repeat(200000)); process.exitCode = 7'], options))
      .rejects.toMatchObject({ code: 7, stderr: 'launch refused: '.padEnd(options.maxBuffer, 'x') })
  })
  it('rejects oversized output without reading the entire file', async () => {
    await expect(executeLauncher(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000)); process.stderr.write("oversized")'], options))
      .rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: 'oversized' })
  })
  it('reports timeout as an unknown outcome', async () => {
    await expect(executeLauncher(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { ...options, timeout: 100 }))
      .rejects.toMatchObject({ code: 'ETIMEDOUT' })
  })
  it('reports failure to create the launcher process', async () => {
    await expect(executeLauncher('goal-controller-nonexistent-launcher-5decc8a2', [], options))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('shared Desktop launch result', () => {
  it('reports an unknown launch outcome on timeout without exposing Desktop logs or retrying', async () => {
    let calls = 0
    const run = (async () => { calls++; throw { code: 'ETIMEDOUT', stderr: 'DESKTOP_INTERNAL_LOG' } }) as Parameters<typeof runSharedCodexLauncher>[1]
    await expect(runSharedCodexLauncher('fake.ps1', run)).rejects.toThrow('Codex açılmış olabilir')
    expect(calls).toBe(1)
  })
  it('keeps a launcher refusal actionable', async () => {
    const run = (async () => { throw { code: 1, stderr: 'Once Codex Desktop uygulamasindan tamamen cikin.' } }) as Parameters<typeof runSharedCodexLauncher>[1]
    await expect(runSharedCodexLauncher('fake.ps1', run)).rejects.toThrow('Once Codex Desktop')
  })
  it('limits a refusal shown in the UI to 1200 characters', async () => {
    const run = async () => { throw { code: 1, stderr: 'x'.repeat(5_000) } }
    await expect(runSharedCodexLauncher('fake.ps1', run)).rejects.toMatchObject({ message: 'x'.repeat(1_200) })
  })
})
