/**
 * "Is anything writing this project's live graph right now?" (Section 4A.3).
 *
 * Activation deletes and rebuilds the live graph, so it must be mutually
 * exclusive with the three things that write it:
 *   - a full recon scan          (orchestrator recon status)
 *   - a partial recon run        (orchestrator partial-run list)
 *   - an agent / LATS session    (Conversation.agentRunning - the agent writes
 *                                 AttackChain-family nodes and reasons over the
 *                                 graph; swapping it mid-run changes its world)
 *
 * FAIL CLOSED: if the orchestrator cannot be reached we report "busy" rather than
 * assume idle, because guessing wrong here means swapping the graph under a
 * running scan.
 */
import prisma from '@/lib/prisma'
import { orchestratorFetch } from '@/lib/orchestrator'

const RECON_ORCHESTRATOR_URL = process.env.RECON_ORCHESTRATOR_URL || 'http://localhost:8010'

const ACTIVE_RECON_STATUSES = new Set(['running', 'starting', 'paused', 'stopping'])
const ACTIVE_PARTIAL_STATUSES = new Set(['running', 'starting', 'stopping'])

/**
 * Returns a human phrase describing what is holding the live graph
 * (e.g. "a full recon scan is running"), or null when the graph is free.
 * Used by ACTIVATION, which is exclusive with all three writers.
 */
export async function describeLiveGraphWriters(projectId: string): Promise<string | null> {
  // Agent sessions first: a plain DB read, no network.
  try {
    const agent = await prisma.conversation.findFirst({
      where: { projectId, agentRunning: true },
      select: { id: true },
    })
    if (agent) return 'an agent session is running'
  } catch (err) {
    console.error('[graphWriters] agent-session check failed (treating as busy):', err)
    return 'the agent session state could not be verified'
  }

  return describeScanWriters(projectId)
}

/**
 * The SCAN subset: a full recon or a partial recon that is rewriting the graph
 * right now. Used before taking a snapshot (Risk 1: a capture must never read a
 * mid-write graph) and before starting another full scan.
 *
 * Deliberately excludes agent sessions: an agent legitimately runs alongside a
 * scan today, and blocking one on the other would be a behavior regression.
 */
export async function describeScanWriters(projectId: string): Promise<string | null> {
  let reconStatus: string | undefined
  try {
    const res = await orchestratorFetch(`${RECON_ORCHESTRATOR_URL}/recon/${projectId}/status`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) return 'the scan status could not be verified'
    reconStatus = (await res.json())?.status
  } catch (err) {
    console.error('[graphWriters] recon status check failed (treating as busy):', err)
    return 'the scan status could not be verified'
  }
  if (reconStatus && ACTIVE_RECON_STATUSES.has(reconStatus)) {
    return 'a full recon scan is running'
  }

  try {
    const res = await orchestratorFetch(`${RECON_ORCHESTRATOR_URL}/recon/${projectId}/partial/all`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) return 'the partial-recon status could not be verified'
    const data = await res.json()
    const runs: Array<{ status?: string }> = Array.isArray(data?.runs) ? data.runs : []
    if (runs.some(r => r.status && ACTIVE_PARTIAL_STATUSES.has(r.status))) {
      return 'a partial recon run is active'
    }
  } catch (err) {
    console.error('[graphWriters] partial recon check failed (treating as busy):', err)
    return 'the partial-recon status could not be verified'
  }

  return null
}
