/**
 * Scan Timeline — one schedule (Section 7.2).
 *
 * PATCH  enable/disable, retime, change scan mode or label
 * DELETE remove the schedule (its ScanJob history survives, schedule_id -> NULL)
 */
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { writeAudit } from '@/lib/audit'
import {
  validateSchedule,
  checkScheduleFeasibility,
  ScheduleValidationError,
} from '@/lib/scanSchedule'
import { fetchScanEnvelope } from '@/lib/scanEnvelope'

interface RouteParams {
  params: Promise<{ id: string; scheduleId: string }>
}

/** Anti-IDOR: a schedule id is client-supplied and must belong to this project. */
async function loadOwnedSchedule(projectId: string, scheduleId: string) {
  if (!scheduleId) return null
  const row = await prisma.scanSchedule.findUnique({ where: { id: scheduleId } })
  if (!row || row.projectId !== projectId) return null
  return row
}

const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id, scheduleId } = await params
  const eff = await requireEffectiveUser()
  if (eff instanceof NextResponse) return eff
  const access = await requireProjectAccess(eff, id)
  if (access instanceof NextResponse) return access

  const existing = await loadOwnedSchedule(id, scheduleId)
  if (!existing) return NOT_FOUND()

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

  // A plain enable/disable does not re-validate the timing.
  const onlyEnabled = Object.keys(body).length === 1 && 'enabled' in body
  if (onlyEnabled) {
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
    }
    const updated = await prisma.scanSchedule.update({
      where: { id: scheduleId },
      data: { enabled: body.enabled },
    })
    await writeAudit({
      actorId: eff.userId,
      action: 'scan-schedule.update',
      targetType: 'scanSchedule',
      targetId: scheduleId,
      before: { enabled: existing.enabled },
      after: { enabled: updated.enabled },
    })
    return NextResponse.json({ schedule: serialize(updated) })
  }

  let validated
  try {
    validated = validateSchedule({
      mode: (body.mode as string) ?? existing.mode,
      runAt: (body.runAt as string) ?? existing.runAt,
      intervalMinutes: (body.intervalMinutes as number) ?? existing.intervalMinutes,
      cronExpr: (body.cronExpr as string) ?? existing.cronExpr,
      scanMode: (body.scanMode as 'new' | 'overwrite') ?? existing.scanMode,
      label: (body.label as string) ?? existing.label,
      enabled: body.enabled === undefined ? existing.enabled : Boolean(body.enabled),
    })
  } catch (err) {
    if (err instanceof ScheduleValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }

  try {
    const env = await fetchScanEnvelope()
    if (env && validated.enabled) {
      const others = await prisma.scanSchedule.findMany({
        where: { enabled: true, nextRunAt: { not: null }, id: { not: scheduleId } },
        select: { id: true, nextRunAt: true, estimatedEnvelopeBytes: true },
      })
      const feasibility = checkScheduleFeasibility(validated.nextRunAt, env, others)
      if (!feasibility.feasible) {
        return NextResponse.json(
          {
            error: feasibility.detail,
            limit: {
              limitType: feasibility.limitType,
              resource: 'scan',
              detail: feasibility.detail,
              reason: feasibility.reason,
              conflictingScheduleIds: feasibility.conflictingScheduleIds,
            },
          },
          { status: 409 }
        )
      }
    }

    const updated = await prisma.scanSchedule.update({
      where: { id: scheduleId },
      data: {
        label: validated.label,
        mode: validated.mode,
        runAt: validated.runAt,
        intervalMinutes: validated.intervalMinutes,
        cronExpr: validated.cronExpr,
        scanMode: validated.scanMode,
        enabled: validated.enabled,
        nextRunAt: validated.nextRunAt,
        ...(env ? { estimatedEnvelopeBytes: BigInt(env.envelopeBytes) } : {}),
      },
    })

    await writeAudit({
      actorId: eff.userId,
      action: 'scan-schedule.update',
      targetType: 'scanSchedule',
      targetId: scheduleId,
      before: { mode: existing.mode, nextRunAt: existing.nextRunAt, enabled: existing.enabled },
      after: { mode: updated.mode, nextRunAt: updated.nextRunAt, enabled: updated.enabled },
    })

    return NextResponse.json({ schedule: serialize(updated) })
  } catch (error) {
    console.error('[scanTimeline] schedule update failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update the schedule' },
      { status: 500 }
    )
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { id, scheduleId } = await params
  const eff = await requireEffectiveUser()
  if (eff instanceof NextResponse) return eff
  const access = await requireProjectAccess(eff, id)
  if (access instanceof NextResponse) return access

  const existing = await loadOwnedSchedule(id, scheduleId)
  if (!existing) return NOT_FOUND()

  try {
    await prisma.scanSchedule.delete({ where: { id: scheduleId } })
    await writeAudit({
      actorId: eff.userId,
      action: 'scan-schedule.delete',
      targetType: 'scanSchedule',
      targetId: scheduleId,
      before: {
        projectId: id, mode: existing.mode, scanMode: existing.scanMode,
        cronExpr: existing.cronExpr, intervalMinutes: existing.intervalMinutes,
      },
    })
    return NextResponse.json({ ok: true, deletedScheduleId: scheduleId })
  } catch (error) {
    console.error('[scanTimeline] schedule delete failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete the schedule' },
      { status: 500 }
    )
  }
}

function serialize(s: { estimatedEnvelopeBytes: bigint | null }) {
  return {
    ...s,
    estimatedEnvelopeBytes: s.estimatedEnvelopeBytes === null ? null : Number(s.estimatedEnvelopeBytes),
  }
}
