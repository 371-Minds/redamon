/**
 * Scan Timeline - defer a due schedule (Sections 7.2/7.3, F3). Internal-key only.
 *
 * The worker calls this instead of `/run` when the run cannot proceed right now:
 * the project's graph is being swapped by an activation ("graph busy"), or the
 * admission ledger has no room. A `deferred_ram` ScanJob is recorded so the
 * timeline shows WHY nothing ran, and `nextRunAt` is pushed out by one retry
 * interval so the worker does not hot-loop.
 *
 * Bounded: after SCAN_SCHEDULE_MAX_DEFERRALS consecutive deferrals the schedule
 * rolls to its normal next occurrence instead of retrying every tick.
 */
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { isInternalRequest } from '@/lib/session'
import { createScanJob, parseScanMode } from '@/lib/scanTimeline'
import { computeNextRun } from '@/lib/scanSchedule'

export const runtime = 'nodejs'

interface RouteParams {
  params: Promise<{ scheduleId: string }>
}

function retryDelayMinutes(): number {
  const raw = parseInt(process.env.SCAN_SCHEDULE_DEFER_RETRY_MINUTES || '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 5
}

function maxDeferrals(): number {
  const raw = parseInt(process.env.SCAN_SCHEDULE_MAX_DEFERRALS || '', 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : 6
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { scheduleId } = await params
  const body = (await request.json().catch(() => ({}))) as { reason?: string }
  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim().slice(0, 500)
    : 'deferred'

  try {
    const schedule = await prisma.scanSchedule.findUnique({ where: { id: scheduleId } })
    if (!schedule) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const now = new Date()

    // Count the consecutive deferrals since the last real run, to bound retries.
    const consecutive = await prisma.scanJob.count({
      where: {
        scheduleId,
        status: 'deferred_ram',
        createdAt: schedule.lastRunAt ? { gt: schedule.lastRunAt } : undefined,
      },
    })

    const giveUp = consecutive + 1 >= maxDeferrals()
    const nextRunAt = giveUp
      ? computeNextRun(schedule, now)
      : new Date(now.getTime() + retryDelayMinutes() * 60_000)

    await createScanJob({
      projectId: schedule.projectId,
      trigger: 'scheduled',
      mode: parseScanMode(schedule.scanMode),
      status: 'deferred_ram',
      initiatedByUserId: schedule.userId,
      scheduleId,
      ramReason: reason,
    })

    await prisma.scanSchedule.update({
      where: { id: scheduleId },
      data: {
        nextRunAt,
        ...(giveUp && schedule.mode === 'once' ? { enabled: false } : {}),
      },
    })

    console.info(
      `[scanScheduler] deferred schedule ${scheduleId} (${reason}); ` +
      `attempt ${consecutive + 1}, next attempt ${nextRunAt?.toISOString() ?? 'never'}`
    )

    return NextResponse.json({ ok: true, deferred: true, reason, nextRunAt, gaveUp: giveUp })
  } catch (error) {
    console.error('[scanScheduler] defer failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to defer the schedule' },
      { status: 500 }
    )
  }
}
