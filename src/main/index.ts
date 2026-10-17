import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { runSharedCodexLauncher } from './shared-codex-launcher'
import { CodexAppServerAdapter } from '../adapters/codex-app-server/codex-adapter'
import { ControllerScheduler } from '../core/scheduler/controller-scheduler'
import { GoalControllerDatabase, recoverControllerDatabaseIfNeeded } from '../persistence/database'
import type { DashboardSnapshot, GoalPolicyOverride, UpdateSettingsInput } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let scheduler: ControllerScheduler | null = null
let isQuitting = false

async function openSharedCodex(): Promise<string> {
  const script = app.isPackaged
    ? join(process.resourcesPath, 'icons', 'start-shared-codex.ps1')
    : join(app.getAppPath(), 'resources', 'start-shared-codex.ps1')
  return runSharedCodexLauncher(script)
}

function runTrayAction(action: Promise<unknown> | undefined): void {
  void action?.catch(() => undefined)
}

function trayIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(join(iconDirectory(), 'tray.png'))
}

function iconDirectory(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icons') : join(app.getAppPath(), 'resources')
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'ChatGPT Goal Controller',
    icon: join(iconDirectory(), 'icon.png'),
    backgroundColor: '#08110f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  window.removeMenu()
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      window.hide()
    }
  })
  window.once('ready-to-show', () => window.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  tray = new Tray(trayIcon())
  tray.setToolTip('ChatGPT Goal Controller — Canlı Kontrol')
  const menu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: showWindow },
    { type: 'separator' },
    {
      label: 'Pause All Goals',
      click: () => runTrayAction(scheduler?.pauseAll())
    },
    {
      label: 'Resume Allowed Goals',
      click: () => runTrayAction(scheduler?.resumeAllowed())
    },
    { label: 'Run Check Now', click: () => runTrayAction(scheduler?.runCycle()) },
    { label: 'Settings', click: showWindow },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('double-click', showWindow)
}

function senderIsTrusted(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  if (process.env.ELECTRON_RENDERER_URL) return url.startsWith(process.env.ELECTRON_RENDERER_URL)
  return url.startsWith('file://')
}

function trustedHandler<T extends unknown[], R>(
  handler: (...args: T) => R | Promise<R>
): (event: IpcMainInvokeEvent, ...args: T) => R | Promise<R> {
  return (event, ...args) => {
    if (!senderIsTrusted(event)) throw new Error('Untrusted IPC sender.')
    return handler(...args)
  }
}

function broadcast(snapshot: DashboardSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('controller:snapshot', snapshot)
  }
}

function registerIpc(): void {
  if (!scheduler) throw new Error('Scheduler is not initialized.')
  ipcMain.handle('controller:open-shared-codex', trustedHandler(openSharedCodex))
  ipcMain.handle('controller:get-snapshot', trustedHandler(() => scheduler!.snapshot()))
  ipcMain.handle('controller:run-check', trustedHandler(() => scheduler!.runCycle()))
  ipcMain.handle('controller:start-goal', trustedHandler((goalId: string) => scheduler!.startGoal(goalId)))
  ipcMain.handle('controller:pause-goal', trustedHandler((goalId: string) => {
    if (typeof goalId !== 'string' || !goalId.trim()) throw new Error('Goal kimliği gerekli.')
    return scheduler!.pauseGoal(goalId)
  }))
  ipcMain.handle(
    'controller:update-priority',
    trustedHandler((goalId: string, priority: number) => scheduler!.updatePriority(goalId, priority))
  )
  ipcMain.handle(
    'controller:set-excluded',
    trustedHandler((goalId: string, excluded: boolean) => scheduler!.setExcluded(goalId, excluded))
  )
  ipcMain.handle(
    'controller:update-goal-policy',
    trustedHandler((goalId: string, policy: GoalPolicyOverride | null) => scheduler!.updateGoalPolicy(goalId, policy))
  )
  ipcMain.handle(
    'controller:take-control-and-resume',
    trustedHandler((goalId: string) => scheduler!.takeControlAndResume(goalId))
  )
  ipcMain.handle(
    'controller:update-settings',
    trustedHandler((input: UpdateSettingsInput) => scheduler!.updateSettings(input))
  )
  ipcMain.handle('controller:pause-all', trustedHandler(() => scheduler!.pauseAll()))
  ipcMain.handle('controller:resume-allowed', trustedHandler(() => scheduler!.resumeAllowed()))
}

function applyLoginSetting(enabled: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: enabled, enabled, path: process.execPath })
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.local.chatgpt-goal-controller')
    const databasePath = join(app.getPath('userData'), 'goal-controller.db')
    let recovery
    try {
      recovery = recoverControllerDatabaseIfNeeded(databasePath)
    } catch (error) {
      dialog.showErrorBox(
        'Goal Controller veritabanı açılamadı',
        error instanceof Error ? error.message : String(error)
      )
      app.quit()
      return
    }
    const database = new GoalControllerDatabase(databasePath)
    if (recovery) {
      database.recordSystemEvent(
        'database_recovered',
        'info',
        `Audit Log rebuilt; ${recovery.skippedAuditRows} unreadable rows preserved at ${recovery.backupDirectory}.`
      )
    }
    scheduler = new ControllerScheduler(new CodexAppServerAdapter(), database)
    scheduler.on('snapshot', broadcast)
    scheduler.on('settings-changed', (settings) => applyLoginSetting(settings.launchAtLogin))
    registerIpc()
    createTray()
    mainWindow = createWindow()
    applyLoginSetting(database.getSettings().launchAtLogin)
    await scheduler.start()
  })

  app.on('activate', showWindow)
  app.on('window-all-closed', () => {
    // The application intentionally remains alive in the Windows notification area.
  })
  app.on('before-quit', () => {
    isQuitting = true
  })
  app.on('will-quit', () => {
    void scheduler?.stop()
  })
}
