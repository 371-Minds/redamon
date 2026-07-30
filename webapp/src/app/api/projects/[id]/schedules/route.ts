/**
 * Scan Timeline — Scan Scheduler CRUD (Section 7.2).
 *
 * GET  /api/projects/[id]/schedules   upcoming schedules + recent run history
 * POST /api/projects/[id]/schedules   create a schedule (validated + RAM-checked)
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
  params: Promise<{ id: string }>
}

const JOB_HISTORY_LIMIT = 50

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const eff = await requireEffectiveUser()
  if (eff instanceof NextResponse) return eff
  const access = await requireProjectAccess(eff, id)
  if (access instanceof NextResponse) return access

  try {
    const [schedules, jobs] = await Promise.all([
      prisma.scanSchedule.findMany({
        where: { projectId: id },
        orderBy: [{ enabled: 'desc' }, { nextRunAt: 'asc' }],
      }),
      prisma.scanJob.findMany({
        where: { projectId: id },
        orderBy: { createdAt: 'desc' },
        take: JOB_HISTORY_LIMIT,
        include: { version: { select: { seq: true, label: true } } },
      }),
    ])

    return NextResponse.json(
      {
        schedules: schedules.map(s => ({
          ...s,
          // BigInt is not JSON-serializable.
          estimatedEnvelopeBytes: s.estimatedEnvelopeBytes === null
            ? null
            : Number(s.estimatedEnvelopeBytes),
        })),
        jobs: jobs.map(j => ({
          id: j.id,
          trigger: j.trigger,
          mode: j.mode,
          status: j.status,
          startedAt: j.startedAt,
          finishedAt: j.finishedAt,
          createdAt: j.createdAt,
          nodeCount: j.nodeCount,
          ramReason: j.ramReason,
          scheduleId: j.scheduleId,
          version: j.version ? { seq: j.version.seq, label: j.version.label } : null,
        })),
      },
      { headers: { 'Cache-Control': 'private, no-cache' } }
    )
  } catch (error) {
    console.error('[scanTimeline] schedule list failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list schedules' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const eff = await requireEffectiveUser()
  if (eff instanceof NextResponse) return eff
  const access = await requireProjectAccess(eff, id)
  if (access instanceof NextResponse) return access

  const body = await request.json().catch(() => null)

  let validated
  try {
    validated = validateSchedule(body)
  } catch (err) {
    if (err instanceof ScheduleValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }

  try {
    // Static RAM feasibility (Section 7.3). Overlap is global: the memory pool is
    // shared across ALL projects, so we look at every enabled schedule.
    const env = await fetchScanEnvelope()
    if (env) {
      const others = await prisma.scanSchedule.findMany({
        where: { enabled: true, nextRunAt: { not: null } },
        select: { id: true, nextRunAt: true, estimatedEnvelopeBytes: true },
      })
      const feasibility = checkScheduleFeasibility(validated.nextRunAt, env, others)
      if (!feasibility.feasible) {
        return NextResponse.json(
          {
            error: feasibility.detail,
            // Mirrors the manual-scan limit payload so the UI can reuse its modal.
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

    const created = await prisma.scanSchedule.create({
      data: {
        projectId: id,
        userId: eff.userId,
        label: validated.label,
        mode: validated.mode,
        runAt: validated.runAt,
        intervalMinutes: validated.intervalMinutes,
        cronExpr: validated.cronExpr,
        scanMode: validated.scanMode,
        enabled: validated.enabled,
        nextRunAt: validated.nextRunAt,
        estimatedEnvelopeBytes: env ? BigInt(env.envelopeBytes) : null,
      },
    })

    await writeAudit({
      actorId: eff.userId,
      action: 'scan-schedule.create',
      targetType: 'scanSchedule',
      targetId: created.id,
      after: {
        projectId: id,
        mode: created.mode,
        scanMode: created.scanMode,
        nextRunAt: created.nextRunAt,
        cronExpr: created.cronExpr,
        intervalMinutes: created.intervalMinutes,
      },
    })

    return NextResponse.json({
      schedule: {
        ...created,
        estimatedEnvelopeBytes: created.estimatedEnvelopeBytes === null
          ? null
          : Number(created.estimatedEnvelopeBytes),
      },
    })
  } catch (error) {
    console.error('[scanTimeline] schedule create failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create the schedule' },
      { status: 500 }
    )
  }
}
