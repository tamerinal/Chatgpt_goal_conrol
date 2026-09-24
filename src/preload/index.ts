import { contextBridge, ipcRenderer } from 'electron'
import type {
  DashboardSnapshot,
  GoalControllerApi,
  UpdateSettingsInput
} from '../shared/types'

const api: GoalControllerApi = {
  getSnapshot: () => ipcRenderer.invoke('controller:get-snapshot'),
  runCheck: () => ipcRenderer.invoke('controller:run-check'),
  updatePriority: (goalId, priority) =>
    ipcRenderer.invoke('controller:update-priority', goalId, priority),
  setExcluded: (goalId, excluded) =>
    ipcRenderer.invoke('controller:set-excluded', goalId, excluded),
  updateGoalPolicy: (goalId, policy) =>
    ipcRenderer.invoke('controller:update-goal-policy', goalId, policy),
  takeControlAndResume: (goalId) =>
    ipcRenderer.invoke('controller:take-control-and-resume', goalId),
  updateSettings: (input: UpdateSettingsInput) =>
    ipcRenderer.invoke('controller:update-settings', input),
  pauseAll: () => ipcRenderer.invoke('controller:pause-all'),
  resumeAllowed: () => ipcRenderer.invoke('controller:resume-allowed'),
  onSnapshot: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: DashboardSnapshot): void => callback(snapshot)
    ipcRenderer.on('controller:snapshot', listener)
    return () => ipcRenderer.removeListener('controller:snapshot', listener)
  }
}

contextBridge.exposeInMainWorld('goalController', api)
