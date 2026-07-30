/**
 * Scan Timeline — Scan Scheduler run history maintenance.
 *
 * DELETE /api/projects/[id]/schedules/history
 *   body { ids: string[] }  delete exactly those run-history rows (multi-select)
 *   body {} or no body      clear the whole run history for the project
 *
 * Deleting a ScanJob only removes the history ROW. It does not touch the versions,
 * the schedules, or a scan that is actually running (the orchestrator owns scan
 * liveness); a deleted in-flight row simply stops appearing in the table.
 */
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { writeAudit } from '@/lib/audit'

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const eff = await requireEffectiveUser()
  if (eff instanceof NextResponse) return eff
  const access = await requireProjectAccess(eff, id)
  if (access instanceof NextResponse) return access

  const body = await request.json().catch(() => ({}))
  const rawIds = (body as { ids?: unknown })?.ids
  const ids = Array.isArray(rawIds)
    ? rawIds.filter((x): x is string => typeof x === 'string')
    : null

  // Scope every delete to this project so a stray id can never remove another
  // project's history.
  const where = ids && ids.length > 0
    ? { projectId: id, id: { in: ids } }
    : { projectId: id }

  try {
    const result = await prisma.scanJob.deleteMany({ where })
    await writeAudit({
      actorId: eff.userId,
      action: 'scan-job.history-clear',
      targetType: 'project',
      targetId: id,
      after: { deleted: result.count, scope: ids ? 'selected' : 'all' },
    })
    return NextResponse.json({ ok: true, deleted: result.count })
  } catch (error) {
    console.error('[scanTimeline] run-history delete failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to clear run history' },
      { status: 500 }
    )
  }
}
