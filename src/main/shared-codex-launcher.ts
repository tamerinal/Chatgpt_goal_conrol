import { spawn } from 'node:child_process'
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface LauncherOptions {
  windowsHide: boolean
  timeout: number
  maxBuffer: number
}
type LauncherRunner = (file: string, args: string[], options: LauncherOptions) => Promise<{ stdout: string | Buffer }>

function readBounded(path: string, limit: number): { text: string; exceeded: boolean } {
  const descriptor = openSync(path, 'r')
  try {
    const size = fstatSync(descriptor).size
    const buffer = Buffer.alloc(Math.min(size, limit))
    let offset = 0
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    return { text: buffer.subarray(0, offset).toString('utf8'), exceeded: size > limit }
  } finally {
    closeSync(descriptor)
  }
}

// Windows Start-Process descendants can inherit the launcher's pipe handles even
// when their own output is redirected. File descriptors let us observe the
// launcher exit without waiting for Desktop or the shared server to close pipes.
export async function executeLauncher(file: string, args: string[], options: LauncherOptions): Promise<{ stdout: string }> {
  if (!Number.isSafeInteger(options.maxBuffer) || options.maxBuffer < 1) throw new Error('Invalid launcher output limit.')
  if (!Number.isFinite(options.timeout) || options.timeout < 0) throw new Error('Invalid launcher timeout.')
  const directory = mkdtempSync(join(tmpdir(), 'goal-controller-launch-'))
  const stdoutPath = join(directory, 'stdout.log')
  const stderrPath = join(directory, 'stderr.log')
  const descriptors: number[] = []
  try {
    descriptors.push(openSync(stdoutPath, 'wx'))
    descriptors.push(openSync(stderrPath, 'wx'))
    const child = spawn(file, args, {
      windowsHide: options.windowsHide,
      stdio: ['ignore', descriptors[0], descriptors[1]]
    })
    // The child owns inherited handles; the parent must release its copies.
    for (const descriptor of descriptors.splice(0)) closeSync(descriptor)
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        callback()
      }
      child.once('error', error => finish(() => reject(error)))
      child.once('exit', (code, signal) => finish(() => resolve({ code, signal })))
      if (options.timeout > 0) {
        timer = setTimeout(() => {
          // Only terminate this launcher. A Desktop/server it started may still
          // be running, so callers must treat the launch outcome as unknown.
          try { child.kill() } catch { /* Preserve the timeout outcome. */ }
          finish(() => reject(Object.assign(new Error('Launcher timed out.'), { code: 'ETIMEDOUT' })))
        }, options.timeout)
      }
    })
    const stdout = readBounded(stdoutPath, options.maxBuffer)
    const stderr = readBounded(stderrPath, options.maxBuffer)
    if (outcome.code !== 0 || outcome.signal !== null) {
      throw Object.assign(new Error(stderr.text.trim() || 'Launcher failed.'), {
        code: outcome.code, signal: outcome.signal, stderr: stderr.text
      })
    }
    if (stdout.exceeded || stderr.exceeded) {
      throw Object.assign(new Error('Launcher output exceeded its limit.'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: stderr.text
      })
    }
    return { stdout: stdout.text }
  } finally {
    for (const descriptor of descriptors) {
      try { closeSync(descriptor) } catch { /* Best effort after a spawn failure. */ }
    }
    // Descendants may retain these exact files on Windows. Never recurse or
    // touch other paths; locked temporary files can remain until later cleanup.
    for (const path of [stdoutPath, stderrPath]) {
      try { unlinkSync(path) } catch { /* An inherited Windows handle may be open. */ }
    }
    try { rmdirSync(directory) } catch { /* Remove only an empty owned directory. */ }
  }
}

export async function runSharedCodexLauncher(script: string, run: LauncherRunner = executeLauncher): Promise<string> {
  try {
    const result = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true, timeout: 25_000, maxBuffer: 128 * 1024
    })
    return String(result.stdout).trim()
  } catch (error) {
    const failure = error as { killed?: boolean; code?: string | number; stderr?: string }
    if (failure.killed || failure.code === 'ETIMEDOUT') {
      throw new Error('Codex açılış sonucu zamanında alınamadı. Codex açılmış olabilir. Tekrar açmayı denemeden önce Şimdi Kontrol Et ile bağlantıyı doğrulayın.')
    }
    const detail = failure.stderr?.trim()
    throw new Error(detail?.slice(0, 1200) || 'Ortak Codex başlatılamadı. Codex Desktop kapalı olmalı.')
  }
}
