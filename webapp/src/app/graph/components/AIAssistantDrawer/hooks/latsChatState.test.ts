/**
 * Unit tests for the LATS chat-state reducer.
 *
 * Run: npx vitest run --no-file-parallelism \
 *   src/app/graph/components/AIAssistantDrawer/hooks/latsChatState.test.ts
 *
 * Covers: start seeds one card keyed by search_id; update replaces latest +
 * pushes history; complete marks status + pins the best line; an orphan update
 * seeds a card instead of dropping; an orphan complete is a no-op.
 */

import { describe, test, expect } from 'vitest'
import { handleLatsStart, handleLatsUpdate, handleLatsComplete, findLatsIndex, buildLatsCardFromEvents } from './latsChatState'
import type { ChatItem, LatsSearchItem } from '../types'
import type {
  LatsStartPayload,
  LatsTreeUpdatePayload,
  LatsCompletePayload,
  LatsTreeSnapshot,
  LatsNodeView,
} from '@/lib/websocket-types'

function node(over: Partial<LatsNodeView>): LatsNodeView {
  return {
    id: 'n', parent_id: null, depth: 0, label: 'n', tool_name: null,
    status: 'evaluated', value: 0, local_value: 0, visits: 0, verdict: '',
    error_class: '', finding_confidence: 0, exploit_succeeded: false,
    duration_ms: 0, observation: '', reflection: '', is_dangerous: false,
    step_id: null, ...over,
  }
}

function snapshot(over: Partial<LatsTreeSnapshot> = {}): LatsTreeSnapshot {
  return {
    search_id: 's1:root', objective: 'admin takeover', phase: 'exploitation',
    shadow_mode: true, rollouts: 1, budget: { max_rollouts: 24, max_depth: 6 },
    active_id: 'root', best_trajectory: ['root', 'c3'],
    nodes: [
      node({ id: 'root', label: 'root', value: 0.8 }),
      node({ id: 'c3', parent_id: 'root', depth: 1, label: 'forgot-password', value: 0.8 }),
    ],
    ...over,
  }
}

const START: LatsStartPayload = {
  search_id: 's1:root', objective: 'admin takeover', phase: 'exploitation',
  budget: { max_rollouts: 24, max_depth: 6 }, shadow_mode: true,
}

describe('handleLatsStart', () => {
  test('seeds a single running card keyed by search_id', () => {
    const items = handleLatsStart([], START)
    expect(items).toHaveLength(1)
    const card = items[0] as LatsSearchItem
    expect(card.type).toBe('lats_search')
    expect(card.search_id).toBe('s1:root')
    expect(card.status).toBe('running')
    expect(card.shadow_mode).toBe(true)
    expect(findLatsIndex(items, 's1:root')).toBe(0)
  })

  test('a duplicate start refreshes in place, not a second card', () => {
    const once = handleLatsStart([], START)
    const twice = handleLatsStart(once, START)
    expect(twice.filter(i => i.type === 'lats_search')).toHaveLength(1)
  })
})

describe('handleLatsUpdate', () => {
  test('replaces latest and pushes history', () => {
    const started = handleLatsStart([], START)
    const p: LatsTreeUpdatePayload = { search_id: 's1:root', snapshot: snapshot() }
    const items = handleLatsUpdate(started, p)
    const card = items[0] as LatsSearchItem
    expect(card.latest.nodes).toHaveLength(2)
    expect(card.history).toHaveLength(1)
    // a second update grows history
    const items2 = handleLatsUpdate(items, { search_id: 's1:root', snapshot: snapshot({ rollouts: 2 }) })
    expect((items2[0] as LatsSearchItem).history).toHaveLength(2)
    expect((items2[0] as LatsSearchItem).latest.rollouts).toBe(2)
  })

  test('reflects prune/terminal statuses from the snapshot', () => {
    const started = handleLatsStart([], START)
    const snap = snapshot({
      nodes: [
        node({ id: 'root', label: 'root' }),
        node({ id: 'c1', parent_id: 'root', depth: 1, status: 'pruned', reflection: 'WAF' }),
        node({ id: 'c3', parent_id: 'root', depth: 1, status: 'terminal', exploit_succeeded: true }),
      ],
    })
    const items = handleLatsUpdate(started, { search_id: 's1:root', snapshot: snap })
    const statuses = (items[0] as LatsSearchItem).latest.nodes.map(n => n.status)
    expect(statuses).toContain('pruned')
    expect(statuses).toContain('terminal')
  })

  test('orphan update (no prior start) seeds a card', () => {
    const items = handleLatsUpdate([], { search_id: 's1:root', snapshot: snapshot() })
    expect(items).toHaveLength(1)
    expect((items[0] as LatsSearchItem).history).toHaveLength(1)
  })

  test('returns a new array (immutability)', () => {
    const started = handleLatsStart([], START)
    const items = handleLatsUpdate(started, { search_id: 's1:root', snapshot: snapshot() })
    expect(items).not.toBe(started)
  })
})

describe('handleLatsComplete', () => {
  test('marks complete and pins the best line', () => {
    const started = handleLatsStart([], START)
    const updated = handleLatsUpdate(started, { search_id: 's1:root', snapshot: snapshot() })
    const p: LatsCompletePayload = {
      search_id: 's1:root', best_trajectory: ['root', 'c3'],
      outcome: 'terminal_success', metrics: { rollouts: 3 },
    }
    const items = handleLatsComplete(updated, p)
    const card = items[0] as LatsSearchItem
    expect(card.status).toBe('complete')
    expect(card.outcome).toBe('terminal_success')
    expect(card.latest.best_trajectory).toEqual(['root', 'c3'])
  })

  test('orphan complete is a no-op', () => {
    const items: ChatItem[] = []
    expect(handleLatsComplete(items, {
      search_id: 'nope', best_trajectory: [], outcome: 'x',
    })).toBe(items)
  })
})

describe('buildLatsCardFromEvents (restore)', () => {
  test('replays a persisted event sequence into one card with rebuilt history', () => {
    const events = [
      { _latsEvent: 'lats_start' as const, payload: START },
      { _latsEvent: 'lats_tree_update' as const, payload: { search_id: 's1:root', snapshot: snapshot({ rollouts: 1 }) } },
      { _latsEvent: 'lats_tree_update' as const, payload: { search_id: 's1:root', snapshot: snapshot({ rollouts: 2 }) } },
      { _latsEvent: 'lats_complete' as const, payload: { search_id: 's1:root', best_trajectory: ['root', 'c3'], outcome: 'terminal_success' } },
    ]
    const card = buildLatsCardFromEvents(events)
    expect(card).not.toBeNull()
    expect(card!.search_id).toBe('s1:root')
    expect(card!.status).toBe('complete')
    expect(card!.outcome).toBe('terminal_success')
    expect(card!.history).toHaveLength(2)              // one per tree_update
    expect(card!.latest.best_trajectory).toEqual(['root', 'c3'])
  })

  test('an empty sequence yields null', () => {
    expect(buildLatsCardFromEvents([])).toBeNull()
  })
})
