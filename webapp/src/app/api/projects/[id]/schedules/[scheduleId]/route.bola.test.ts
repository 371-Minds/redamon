/**
 * BOLA — PATCH/DELETE /api/projects/[id]/schedules/[scheduleId].
 *
 * The schedule id is client-supplied, so owning project A must not let a caller
 * retime, disable or delete project B's scheduled scans.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireEff: vi.fn(),
  requireProjectAccess: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  findMany: vi.fn(),
  envelope: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: () => h.requireEff(),
  requireProjectAccess: (...a: unknown[]) => h.requireProjectAccess(...a),
}))
vi.mock('@/lib/prisma', () => ({
  default: {
    scanSchedule: {
      findUnique: (...a: unknown[]) => h.findUnique(...a),
      update: (...a: unknown[]) => h.update(...a),
      delete: (...a: unknown[]) => h.del(...a),
      findMany: (...a: unknown[]) => h.findMany(...a),
    },
  },
}))
vi.mock('@/lib/audit', () => ({ writeAudit: (...a: unknown[]) => h.audit(...a) }))
vi.mock('@/lib/scanEnvelope', () => ({ fetchScanEnvelope: () => h.envelope() }))

import { PATCH, DELETE } from './route'

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 })
const params = (id: string, scheduleId: string) => ({ params: Promise.resolve({ id, scheduleId }) })
const patchReq = (body: unknown) => new NextRequest('http://x/api/projects/p1/schedules/s1', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const delReq = () => new NextRequest('http://x/api/projects/p1/schedules/s1', { method: 'DELETE' })

const SCHEDULE = {
  id: 's1', projectId: 'p1', userId: 'owner', label: '', mode: 'interval',
  runAt: null, intervalMinutes: 1440, cronExpr: null, scanMode: 'new',
  enabled: true, nextRunAt: new Date(), estimatedEnvelopeBytes: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireEff.mockResolvedValue({ userId: 'owner' })
  h.requireProjectAccess.mockResolvedValue({ project: { id: 'p1', userId: 'owner' } })
  h.findUnique.mockResolvedValue(SCHEDULE)
  h.findMany.mockResolvedValue([])
  h.envelope.mockResolvedValue(null)
  h.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    ({ ...SCHEDULE, ...data }))
  h.del.mockResolvedValue({})
})

describe('PATCH — BOLA', () => {
  test("another user's project → 404, nothing written", async () => {
    h.requireProjectAccess.mockResolvedValue(NOT_FOUND)
    expect((await PATCH(patchReq({ enabled: false }), params('victimProj', 's1'))).status).toBe(404)
    expect(h.update).not.toHaveBeenCalled()
  })

  test("EXPLOIT: a schedule id from another project → 404, nothing written", async () => {
    h.findUnique.mockResolvedValue({ ...SCHEDULE, projectId: 'someoneElse' })
    expect((await PATCH(patchReq({ enabled: false }), params('p1', 'sOther'))).status).toBe(404)
    expect(h.update).not.toHaveBeenCalled()
  })
})

describe('PATCH — behavior', () => {
  test('a bare enable/disable does not re-validate the timing', async () => {
    const res = await PATCH(patchReq({ enabled: false }), params('p1', 's1'))
    expect(res.status).toBe(200)
    expect(h.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { enabled: false } })
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'scan-schedule.update' }))
  })

  test('a non-boolean enabled is rejected', async () => {
    expect((await PATCH(patchReq({ enabled: 'yes' }), params('p1', 's1'))).status).toBe(400)
    expect(h.update).not.toHaveBeenCalled()
  })

  test('a retime is validated and recomputes the next run', async () => {
    const res = await PATCH(patchReq({ mode: 'cron', cronExpr: '0 4 * * *' }), params('p1', 's1'))
    expect(res.status).toBe(200)
    const data = h.update.mock.calls[0][0].data
    expect(data.mode).toBe('cron')
    expect(data.cronExpr).toBe('0 4 * * *')
    expect(data.nextRunAt).toBeInstanceOf(Date)
  })

  test('an invalid retime is rejected without touching the row', async () => {
    expect((await PATCH(patchReq({ mode: 'cron', cronExpr: '* * * * *' }), params('p1', 's1'))).status).toBe(400)
    expect(h.update).not.toHaveBeenCalled()
  })

  test('a retime that would overload the RAM window is rejected', async () => {
    const MB = 1024 * 1024
    h.envelope.mockResolvedValue({ envelopeBytes: 5000 * MB, scanPoolBytes: 6000 * MB })
    h.findMany.mockResolvedValue([
      { id: 'other', nextRunAt: new Date(Date.now() + 30 * 60_000), estimatedEnvelopeBytes: BigInt(5000 * MB) },
    ])
    const res = await PATCH(patchReq({ mode: 'interval', intervalMinutes: 30 }), params('p1', 's1'))
    expect(res.status).toBe(409)
    expect(h.update).not.toHaveBeenCalled()
    // The schedule being edited must not be counted as its own conflict.
    expect(h.findMany.mock.calls[0][0].where.id).toEqual({ not: 's1' })
  })
})

describe('DELETE', () => {
  test("EXPLOIT: a schedule id from another project → 404, nothing deleted", async () => {
    h.findUnique.mockResolvedValue({ ...SCHEDULE, projectId: 'someoneElse' })
    expect((await DELETE(delReq(), params('p1', 'sOther'))).status).toBe(404)
    expect(h.del).not.toHaveBeenCalled()
  })

  test('owner → deletes and audits', async () => {
    const res = await DELETE(delReq(), params('p1', 's1'))
    expect(res.status).toBe(200)
    expect(h.del).toHaveBeenCalledWith({ where: { id: 's1' } })
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'scan-schedule.delete' }))
  })
})
