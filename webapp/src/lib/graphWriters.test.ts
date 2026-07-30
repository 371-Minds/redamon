/**
 * Scan Timeline — "who is writing the live graph?" (Section 4A.3).
 *
 * This is the check that stands between a version activation and a corrupted
 * scan/agent run, so its failure mode matters as much as its happy path: an
 * unreachable orchestrator must read as BUSY, never as idle.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({ conversation: { findFirst: vi.fn() } }))
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/prisma', () => ({ default: prismaMock }))
vi.mock('@/lib/orchestrator', () => ({ orchestratorFetch: (...a: unknown[]) => fetchMock(...a) }))

import { describeLiveGraphWriters } from './graphWriters'

const okJson = (body: unknown) => ({ ok: true, json: async () => body })

beforeEach(() => {
  vi.clearAllMocks()
  prismaMock.conversation.findFirst.mockResolvedValue(null)
  fetchMock.mockImplementation(async (url: string) =>
    url.includes('/partial/all') ? okJson({ runs: [] }) : okJson({ status: 'idle' }))
})

describe('describeLiveGraphWriters', () => {
  test('idle project → null', async () => {
    expect(await describeLiveGraphWriters('p1')).toBeNull()
  })

  test('a running agent session blocks, without even asking the orchestrator', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue({ id: 'c1' })
    expect(await describeLiveGraphWriters('p1')).toBe('an agent session is running')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each(['running', 'starting', 'paused', 'stopping'])('recon status %s blocks', async status => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/partial/all') ? okJson({ runs: [] }) : okJson({ status }))
    expect(await describeLiveGraphWriters('p1')).toBe('a full recon scan is running')
  })

  test.each(['idle', 'completed', 'error'])('recon status %s does not block', async status => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/partial/all') ? okJson({ runs: [] }) : okJson({ status }))
    expect(await describeLiveGraphWriters('p1')).toBeNull()
  })

  test('an active partial recon run blocks', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/partial/all')
        ? okJson({ runs: [{ status: 'completed' }, { status: 'running' }] })
        : okJson({ status: 'idle' }))
    expect(await describeLiveGraphWriters('p1')).toBe('a partial recon run is active')
  })

  test('finished partial runs do not block', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/partial/all')
        ? okJson({ runs: [{ status: 'completed' }, { status: 'error' }] })
        : okJson({ status: 'idle' }))
    expect(await describeLiveGraphWriters('p1')).toBeNull()
  })

  test('FAIL CLOSED: an unreachable orchestrator reads as busy, not idle', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await describeLiveGraphWriters('p1')).toMatch(/could not be verified/)
  })

  test('FAIL CLOSED: a non-OK status response reads as busy', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/partial/all') ? okJson({ runs: [] }) : { ok: false, json: async () => ({}) })
    expect(await describeLiveGraphWriters('p1')).toMatch(/scan status could not be verified/)
  })

  test('FAIL CLOSED: an unreadable agent-session state reads as busy', async () => {
    prismaMock.conversation.findFirst.mockRejectedValue(new Error('db down'))
    expect(await describeLiveGraphWriters('p1')).toMatch(/agent session state could not be verified/)
  })
})
