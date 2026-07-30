/**
 * BOLA / IDOR — GET /api/projects/[id]/versions/[versionId]/graph.
 *
 * Two independent object checks are required (Section 8.1 + 8.2):
 *   1. the caller must own the PROJECT (requireProjectAccess), and
 *   2. the client-supplied versionId must BELONG to that project — otherwise a
 *      user who owns project A could read project B's snapshot by guessing its
 *      version id, which is exactly the data a snapshot contains.
 * A version from another project is reported as 404 (anti-enumeration).
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockRequireEff = vi.fn()
const mockRequireProjectAccess = vi.fn()
const mockFindUnique = vi.fn()
const mockQueryRaw = vi.fn()
const mockLoadSnapshot = vi.fn()
const mockReadLiveGraph = vi.fn()

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: () => mockRequireEff(),
  requireProjectAccess: (...a: unknown[]) => mockRequireProjectAccess(...a),
}))
vi.mock('@/lib/prisma', () => ({
  default: {
    scanVersion: { findUnique: (...a: unknown[]) => mockFindUnique(...a) },
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
  },
}))
vi.mock('@/lib/scanSnapshot', async orig => ({
  ...(await orig<typeof import('@/lib/scanSnapshot')>()),
  loadSnapshot: (...a: unknown[]) => mockLoadSnapshot(...a),
}))
vi.mock('@/app/api/graph/liveRead', () => ({
  readLiveGraph: (...a: unknown[]) => mockReadLiveGraph(...a),
}))

import { GET } from './route'

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 })
const UNAUTH = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
const params = (id: string, versionId: string) => ({ params: Promise.resolve({ id, versionId }) })
const req = () => new NextRequest('http://x/api/projects/p1/versions/v1/graph')

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireEff.mockResolvedValue({ userId: 'owner' })
  mockRequireProjectAccess.mockResolvedValue({ project: { id: 'p1', userId: 'owner' } })
  mockQueryRaw.mockResolvedValue([{ len: 10 }])
  mockLoadSnapshot.mockResolvedValue({ nodes: [], relationships: [] })
  mockReadLiveGraph.mockResolvedValue({ nodes: [], links: [] })
})

describe('GET version graph — authorization', () => {
  test('no session → 401, nothing read', async () => {
    mockRequireEff.mockResolvedValue(UNAUTH)
    const res = await GET(req(), params('p1', 'v1'))
    expect(res.status).toBe(401)
    expect(mockFindUnique).not.toHaveBeenCalled()
    expect(mockLoadSnapshot).not.toHaveBeenCalled()
  })

  test("EXPLOIT: another user's project → 404, no version lookup", async () => {
    mockRequireProjectAccess.mockResolvedValue(NOT_FOUND)
    const res = await GET(req(), params('victimProj', 'v1'))
    expect(res.status).toBe(404)
    expect(mockFindUnique).not.toHaveBeenCalled()
    expect(mockLoadSnapshot).not.toHaveBeenCalled()
  })

  test("EXPLOIT: own project + ANOTHER project's versionId → 404, snapshot never loaded", async () => {
    mockFindUnique.mockResolvedValue({ id: 'vOther', projectId: 'someoneElsesProject', isCurrent: false })
    const res = await GET(req(), params('p1', 'vOther'))
    expect(res.status).toBe(404)
    expect(mockLoadSnapshot).not.toHaveBeenCalled()
    expect(mockReadLiveGraph).not.toHaveBeenCalled()
  })

  test('unknown versionId → 404', async () => {
    mockFindUnique.mockResolvedValue(null)
    const res = await GET(req(), params('p1', 'nope'))
    expect(res.status).toBe(404)
  })
})

describe('GET version graph — payload source', () => {
  test('current version reads the LIVE graph', async () => {
    mockFindUnique.mockResolvedValue({ id: 'v3', projectId: 'p1', isCurrent: true })
    mockReadLiveGraph.mockResolvedValue({ nodes: [{ id: '1' }], links: [] })
    const res = await GET(req(), params('p1', 'v3'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.live).toBe(true)
    expect(body.nodes).toHaveLength(1)
    expect(mockReadLiveGraph).toHaveBeenCalledWith('p1')
    expect(mockLoadSnapshot).not.toHaveBeenCalled()
  })

  test('past version renders stored bytes and NEVER touches Neo4j', async () => {
    mockFindUnique.mockResolvedValue({ id: 'v1', projectId: 'p1', isCurrent: false })
    mockLoadSnapshot.mockResolvedValue({
      nodes: [{ labels: ['IP'], properties: { address: '1.1.1.1' }, _exportId: 'n1' }],
      relationships: [],
    })
    const res = await GET(req(), params('p1', 'v1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.live).toBe(false)
    expect(body.nodes).toEqual([{ id: 'n1', name: '1.1.1.1', type: 'IP', properties: { address: '1.1.1.1' } }])
    expect(mockReadLiveGraph).not.toHaveBeenCalled()
  })

  test('a past version with no bytes reports it instead of showing live data', async () => {
    mockFindUnique.mockResolvedValue({ id: 'v1', projectId: 'p1', isCurrent: false })
    mockLoadSnapshot.mockResolvedValue(null)
    const res = await GET(req(), params('p1', 'v1'))
    expect(res.status).toBe(409)
    expect((await res.json()).emptySnapshot).toBe(true)
    expect(mockReadLiveGraph).not.toHaveBeenCalled()
  })

  test('responses are not cacheable by shared caches', async () => {
    mockFindUnique.mockResolvedValue({ id: 'v1', projectId: 'p1', isCurrent: false })
    const res = await GET(req(), params('p1', 'v1'))
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
  })
})
