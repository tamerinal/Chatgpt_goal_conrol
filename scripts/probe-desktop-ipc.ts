import { connectDesktopReader } from './desktop-ipc-reader'

// Manual live diagnostic: requires user approval and exact target UUID.
const uuid = process.argv[2]
if (!uuid || process.argv.length !== 3 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid)) {
  throw new Error('Usage: tsx scripts/probe-desktop-ipc.ts <approved-conversation-UUID>')
}
async function main(): Promise<void> {
  const reader = connectDesktopReader()
  try {
    const result = await reader.inspect(uuid)
    console.log(JSON.stringify({ conversationId: uuid, ...result, mutationsSent: 0 }))
  } finally { reader.close() }
}
void main().catch((error) => { console.error(error.message); process.exitCode = 1 })
