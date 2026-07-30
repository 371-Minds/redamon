/**
 * Scan Timeline — Scan Scheduler table (Section 7.1).
 *
 * Beyond rendering: a failing load must not turn into a request storm. The
 * component loads inside an effect, and the alert helpers it used to depend on
 * change identity every time an alert opens — so reporting a load failure through
 * one of them re-triggered the load, which failed again, forever.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const alertError = vi.fn()
const dangerConfirm = vi.fn()
const toastInfo = vi.fn()

// The REAL AlertProvider rebuilds `alert*` with useCallback([current]), so their
// identity changes every time an alert opens or closes. Reproduce that worst case
// here (fresh function identities on every render) so a component that feeds an
// alert helper back into an effect's dependency list shows up as a request storm.
vi.mock('@/components/ui', () => ({
  useAlertModal: () => ({
    alertError: (...a: unknown[]) => alertError(...a),
    dangerConfirm: (...a: unknown[]) => dangerConfirm(...a),
  }),
  useToast: () => ({ info: (...a: unknown[]) => toastInfo(...a) }),
}))

import { ScanScheduleTable } from './ScanScheduleTable'

const SCHEDULE = {
  id: 's1', label: 'nightly', mode: 'cron' as const, runAt: null, intervalMinutes: null,
  cronExpr: '0 3 * * *', scanMode: 'new' as const, enabled: true,
  nextRunAt: '2026-08-01T03:00:00.000Z', lastRunAt: null,
}
const JOB = {
  id: 'j1', trigger: 'scheduled' as const, mode: 'new' as const, status: 'deferred_ram',
  startedAt: null, finishedAt: null, createdAt: '2026-07-30T03:00:00.000Z',
  nodeCount: null, ramReason: 'graph busy: a version activation is in progress',
}

let fetchMock: ReturnType<typeof vi.fn>
const ok = (body: unknown) => ({ ok: true, json: async () => body })
const fail = (status: number, body: unknown) => ({ ok: false, status, json: async () => body })

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn().mockResolvedValue(ok({ schedules: [SCHEDULE], jobs: [JOB] }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ScanScheduleTable', () => {
  test('lists schedules and run history, including why a run did not happen', async () => {
    render(<ScanScheduleTable projectId="p1" />)
    await waitFor(() => expect(screen.getByText('nightly')).toBeTruthy())
    expect(screen.getByText(/cron 0 3 \* \* \* \(UTC\)/)).toBeTruthy()
    expect(screen.getByText('deferred_ram')).toBeTruthy()
    expect(screen.getByText(/graph busy/)).toBeTruthy()
  })

  test('a failing load is reported ONCE, not retried in a loop', async () => {
    fetchMock.mockResolvedValue(fail(500, { error: 'schedules exploded' }))
    render(<ScanScheduleTable projectId="p1" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // Give a runaway effect plenty of turns to pile requests up.
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5))
    expect(fetchMock.mock.calls.filter(c => String(c[1]?.method ?? 'GET') === 'GET')).toHaveLength(1)
    await waitFor(() => expect(screen.getByText(/schedules exploded/)).toBeTruthy())
  })

  test('only one load happens per project on mount', async () => {
    render(<ScanScheduleTable projectId="p1" />)
    await waitFor(() => expect(screen.getByText('nightly')).toBeTruthy())
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 5))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('toggling enabled PATCHes the schedule and reloads', async () => {
    render(<ScanScheduleTable projectId="p1" />)
    await waitFor(() => expect(screen.getByText('nightly')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Disable'))
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(c => c[1]?.method === 'PATCH')
      expect(patch).toBeTruthy()
      expect(String(patch![0])).toBe('/api/projects/p1/schedules/s1')
      expect(JSON.parse(patch![1].body)).toEqual({ enabled: false })
    })
  })

  test('a rejected create surfaces the server reason (e.g. the RAM overlap check)', async () => {
    render(<ScanScheduleTable projectId="p1" />)
    await waitFor(() => expect(screen.getByText('nightly')).toBeTruthy())
    fetchMock.mockResolvedValueOnce(fail(409, { error: 'not enough RAM in that window' }))
    fireEvent.click(screen.getByText('Add schedule'))
    await waitFor(() => expect(alertError).toHaveBeenCalledWith(
      'not enough RAM in that window', 'Schedule not created'
    ))
  })

  test('deleting asks for a destructive confirm first', async () => {
    dangerConfirm.mockResolvedValue(false)
    render(<ScanScheduleTable projectId="p1" />)
    await waitFor(() => expect(screen.getByText('nightly')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Delete schedule'))
    await waitFor(() => expect(dangerConfirm).toHaveBeenCalled())
    expect(fetchMock.mock.calls.find(c => c[1]?.method === 'DELETE')).toBeUndefined()
  })
})
