/**
 * Scan Timeline — full-scan version bookkeeping unit tests.
 *
 * The critical guarantee under test is FAIL CLOSED: in 'new' mode, if the current
 * graph cannot be frozen, prepareVersionsForFullScan must throw and must NOT have
 * demoted the current version or created a new one — the caller then aborts the
 * scan, so the graph is never destroyed unsaved.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  scanVersion: { update: vi.fn(), create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  scanJob: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}))
const snapshotMock = vi.hoisted(() => ({
  captureGraphSnapshot: vi.fn(),
  storeSnapshot: vi.fn(),
  ensureCurrentVersion: vi.fn(),
}))
const auditMock = vi.hoisted(() => ({ writeAudit: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ default: prismaMock }))
vi.mock('@/lib/audit', () => auditMock)
vi.mock('@/lib/scanSnapshot', async orig => ({
  ...(await orig<typeof import('@/lib/scanSnapshot')>()),
  captureGraphSnapshot: (...a: unknown[]) => snapshotMock.captureGraphSnapshot(...a),
  storeSnapshot: (...a: unknown[]) => snapshotMock.storeSnapshot(...a),
  ensureCurrentVersion: (...a: unknown[]) => snapshotMock.ensureCurrentVersion(...a),
}))

import {
  parseScanMode,
  prepareVersionsForFullScan,
  createScanJob,
  reconcileScanJobStatus,
  nextVersionSeq,
  SnapshotFreezeError,
} from './scanTimeline'

const CURRENT = {
  id: 'vCur', seq: 2, label: 'Scan 2 — 2026-07-01 10:00 UTC',
  isCurrent: true, pinned: false, nodeCount: 100, linkCount: 200, createdAt: new Date(),
}

beforeEach(() => {
  vi.clearAllMocks()
  snapshotMock.ensureCurrentVersion.mockResolvedValue(CURRENT)
  prismaMock.scanVersion.findFirst.mockResolvedValue({ seq: 2 })
  prismaMock.scanVersion.update.mockImplementation(async ({ where, data }: never) =>
    ({ ...CURRENT, ...(data as object), id: (where as { id: string }).id }))
  prismaMock.scanVersion.create.mockResolvedValue({ ...CURRENT, id: 'vNew', seq: 3, label: 'Scan 3' })
  // Run the transaction body against the same mock client.
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock))
})

describe('parseScanMode', () => {
  test('accepts only the two known modes', () => {
    expect(parseScanMode('new')).toBe('new')
    expect(parseScanMode('overwrite')).toBe('overwrite')
    for (const bad of ['NEW', 'delete', '', null, undefined, 1, {}]) {
      expect(parseScanMode(bad)).toBeNull()
    }
  })
})

describe("prepareVersionsForFullScan — mode 'new'", () => {
  test('freezes the current version, demotes it, and mints the next one', async () => {
    snapshotMock.captureGraphSnapshot.mockResolvedValue({
      nodes: [{}], relationships: [], nodeCount: 100, linkCount: 200, summary: { IP: 100 },
    })
    snapshotMock.storeSnapshot.mockResolvedValue({ bytes: 1234 })

    const res = await prepareVersionsForFullScan('p1', 'new', 'u1')

    expect(snapshotMock.captureGraphSnapshot).toHaveBeenCalledWith('p1')
    expect(snapshotMock.storeSnapshot).toHaveBeenCalledWith('vCur', expect.objectContaining({ nodeCount: 100 }))
    // Demote then create, inside one transaction.
    expect(prismaMock.$transaction).toHaveBeenCalled()
    expect(prismaMock.scanVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'vCur' }, data: { isCurrent: false } })
    )
    const created = prismaMock.scanVersion.create.mock.calls[0][0].data
    expect(created).toMatchObject({ projectId: 'p1', seq: 3, isCurrent: true, snapshot: null })
    expect(res.frozenVersionId).toBe('vCur')
    expect(res.frozenNodeCount).toBe(100)
    expect(res.currentVersion.id).toBe('vNew')
  })

  test('FAIL CLOSED: capture failure throws and nothing is demoted or created', async () => {
    snapshotMock.captureGraphSnapshot.mockRejectedValue(new Error('neo4j unreachable'))
    await expect(prepareVersionsForFullScan('p1', 'new', 'u1'))
      .rejects.toBeInstanceOf(SnapshotFreezeError)
    expect(snapshotMock.storeSnapshot).not.toHaveBeenCalled()
    expect(prismaMock.scanVersion.update).not.toHaveBeenCalled()
    expect(prismaMock.scanVersion.create).not.toHaveBeenCalled()
  })

  test('FAIL CLOSED: store failure throws and nothing is demoted or created', async () => {
    snapshotMock.captureGraphSnapshot.mockResolvedValue({
      nodes: [{}], relationships: [], nodeCount: 5, linkCount: 1, summary: {},
    })
    snapshotMock.storeSnapshot.mockRejectedValue(new Error('snapshot too large'))
    await expect(prepareVersionsForFullScan('p1', 'new', 'u1'))
      .rejects.toThrow(/Could not store the snapshot/)
    expect(prismaMock.scanVersion.update).not.toHaveBeenCalled()
    expect(prismaMock.scanVersion.create).not.toHaveBeenCalled()
  })

  test('an empty live graph is not frozen and does not consume a version', async () => {
    snapshotMock.captureGraphSnapshot.mockResolvedValue({
      nodes: [], relationships: [], nodeCount: 0, linkCount: 0, summary: {},
    })
    const res = await prepareVersionsForFullScan('p1', 'new', 'u1')
    expect(snapshotMock.storeSnapshot).not.toHaveBeenCalled()
    expect(prismaMock.scanVersion.create).not.toHaveBeenCalled()
    expect(res.frozenVersionId).toBeNull()
    expect(res.currentVersion.id).toBe('vCur')
  })
})

describe("prepareVersionsForFullScan — mode 'overwrite'", () => {
  test('keeps the current version, takes NO snapshot, and audits the discard', async () => {
    const res = await prepareVersionsForFullScan('p1', 'overwrite', 'u1')
    expect(snapshotMock.captureGraphSnapshot).not.toHaveBeenCalled()
    expect(snapshotMock.storeSnapshot).not.toHaveBeenCalled()
    expect(prismaMock.scanVersion.create).not.toHaveBeenCalled()
    expect(res.frozenVersionId).toBeNull()
    expect(res.currentVersion.id).toBe('vCur')
    expect(auditMock.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'scan-version.overwrite', actorId: 'u1', targetId: 'vCur',
    }))
  })

  test('refreshes an auto-generated label but preserves a user rename', async () => {
    await prepareVersionsForFullScan('p1', 'overwrite', 'u1')
    const autoLabel = prismaMock.scanVersion.update.mock.calls[0][0].data.label
    expect(autoLabel).toMatch(/^Scan 2 — \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/)
    expect(autoLabel).not.toBe(CURRENT.label)

    vi.clearAllMocks()
    snapshotMock.ensureCurrentVersion.mockResolvedValue({ ...CURRENT, label: 'Pre-migration baseline' })
    prismaMock.scanVersion.update.mockResolvedValue(CURRENT)
    await prepareVersionsForFullScan('p1', 'overwrite', 'u1')
    expect(prismaMock.scanVersion.update.mock.calls[0][0].data.label).toBe('Pre-migration baseline')
  })
})

describe('nextVersionSeq', () => {
  test('is max(seq) + 1, and 1 for a project with no versions', async () => {
    prismaMock.scanVersion.findFirst.mockResolvedValue({ seq: 7 })
    expect(await nextVersionSeq('p1')).toBe(8)
    prismaMock.scanVersion.findFirst.mockResolvedValue(null)
    expect(await nextVersionSeq('p1')).toBe(1)
  })
})

describe('createScanJob', () => {
  test('a running job records startedAt; a non-running one does not', async () => {
    prismaMock.scanJob.create.mockResolvedValue({ id: 'j1' })
    await createScanJob({ projectId: 'p1', versionId: 'v1', trigger: 'manual', mode: 'new', initiatedByUserId: 'u1' })
    let data = prismaMock.scanJob.create.mock.calls[0][0].data
    expect(data).toMatchObject({ projectId: 'p1', versionId: 'v1', trigger: 'manual', mode: 'new', status: 'running', initiatedByUserId: 'u1' })
    expect(data.startedAt).toBeInstanceOf(Date)

    prismaMock.scanJob.create.mockClear()
    await createScanJob({ projectId: 'p1', trigger: 'scheduled', mode: 'new', status: 'deferred_ram', ramReason: 'graph busy' })
    data = prismaMock.scanJob.create.mock.calls[0][0].data
    expect(data.status).toBe('deferred_ram')
    expect(data.ramReason).toBe('graph busy')
    expect(data.startedAt).toBeNull()
  })
})

describe('reconcileScanJobStatus', () => {
  beforeEach(() => {
    prismaMock.scanJob.findFirst.mockResolvedValue({ id: 'j1', versionId: 'v1' })
    prismaMock.scanVersion.findUnique.mockResolvedValue({ nodeCount: 42 })
    prismaMock.scanJob.update.mockResolvedValue({})
  })

  test('maps terminal orchestrator states onto the open job', async () => {
    for (const [status, expected] of [['completed', 'completed'], ['error', 'failed'], ['idle', 'canceled']]) {
      prismaMock.scanJob.update.mockClear()
      await reconcileScanJobStatus('p1', status)
      expect(prismaMock.scanJob.update.mock.calls[0][0].data).toMatchObject({ status: expected, nodeCount: 42 })
    }
  })

  test('leaves non-terminal states alone (no DB work at all)', async () => {
    for (const status of ['running', 'starting', 'paused', 'stopping', undefined, null]) {
      await reconcileScanJobStatus('p1', status)
    }
    expect(prismaMock.scanJob.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.scanJob.update).not.toHaveBeenCalled()
  })

  test('no open job → no update', async () => {
    prismaMock.scanJob.findFirst.mockResolvedValue(null)
    await reconcileScanJobStatus('p1', 'completed')
    expect(prismaMock.scanJob.update).not.toHaveBeenCalled()
  })

  test('swallows DB errors so a status poll never breaks', async () => {
    prismaMock.scanJob.findFirst.mockRejectedValue(new Error('db down'))
    await expect(reconcileScanJobStatus('p1', 'completed')).resolves.toBeUndefined()
  })
})
