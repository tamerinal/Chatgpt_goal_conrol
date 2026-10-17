import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeLauncher } from '../src/main/shared-codex-launcher'

const script = resolve('resources/start-shared-codex.ps1')
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`
function run(code: string, timeout = 10_000) {
  return spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout, windowsHide: true
  })
}
describe.skipIf(process.platform !== 'win32')('shared launcher (parser and mocked Desktop only)', () => {
  it('parses in Windows PowerShell without executing the launcher', () => {
    const result = run(`$tokens=$null; $problems=$null; [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$tokens,[ref]$problems) | Out-Null; if($problems.Count -gt 0) { exit 1 }; Write-Output 'PARSE_OK'`)
    expect(result.status).toBe(0)
    expect(result.error).toBeUndefined()
    expect(result.stdout).toContain('PARSE_OK')
  })
  it('refuses an open Desktop before starting processes or changing files', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'goal-launcher-fake-'))
    mkdirSync(join(fixture, 'app'))
    const executable = join(fixture, 'app', 'ChatGPT.exe')
    writeFileSync(executable, '')
    const result = run(`
      function Get-AppxPackage { [pscustomobject]@{InstallLocation=${quote(fixture)};Version='1'} }
      function Get-Process { [pscustomobject]@{Path=${quote(executable)}} }
      function Start-Process { throw 'UNEXPECTED_PROCESS_START' }
      function New-Item { throw 'UNEXPECTED_FILE_CHANGE' }
      & ${quote(script)}
    `)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Once Codex Desktop')
    expect(result.stderr).not.toContain('UNEXPECTED_')
  })
  it('returns while Desktop is alive and keeps Desktop logs out of launcher stderr', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'goal-launcher-detach-'))
    mkdirSync(join(fixture, 'app'))
    const executable = join(fixture, 'app', 'ChatGPT.exe')
    const compile = run(`Add-Type -TypeDefinition 'public class DesktopFixture { public static void Main() { System.Console.Error.WriteLine("DESKTOP_WARNING"); System.Threading.Thread.Sleep(6000); } }' -OutputAssembly ${quote(executable)} -OutputType ConsoleApplication`)
    expect(compile.status).toBe(0)
    expect(compile.error).toBeUndefined()
    mkdirSync(join(fixture, 'OpenAI', 'Codex', 'bin'), { recursive: true })
    writeFileSync(join(fixture, 'OpenAI', 'Codex', 'bin', 'codex.exe'), '')
    const code = `
      $env:LOCALAPPDATA=${quote(fixture)}
      function Get-AppxPackage { [pscustomobject]@{InstallLocation=${quote(fixture)};Version='1'} }
      function Get-Process { param($Name,$Id) if($Id) { [pscustomobject]@{Id=$Id} } }
      function Get-CimInstance { [pscustomobject]@{ProcessId=4242;CreationDate=[DateTime]::UtcNow} }
      function Get-NetTCPConnection { if(Test-Path (Join-Path $env:LOCALAPPDATA 'ChatGPT Goal Controller\\shared-codex\\server.json')) { [pscustomobject]@{OwningProcess=4242;LocalAddress='127.0.0.1'} } }
      function Invoke-WebRequest { [pscustomobject]@{StatusCode=200} }
      function Start-Process {
        param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError)
        if($FilePath -like '*codex.exe') { return [pscustomobject]@{Id=4242} }
        Microsoft.PowerShell.Management\\Start-Process @PSBoundParameters
      }
      & ${quote(script)}
      if($LASTEXITCODE -eq 1) { exit 1 }
    `
    const startedAt = performance.now()
    const result = await executeLauncher('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
      timeout: 10_000, windowsHide: true, maxBuffer: 128 * 1024
    })
    expect(performance.now() - startedAt).toBeLessThan(5_000)
    expect(result.stdout).toContain('Codex ortak yerel baglanti ile acildi')
    expect(result.stdout).not.toContain('DESKTOP_WARNING')
  }, 20_000)
})
