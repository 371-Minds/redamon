/**
 * Reconcile an authoritative (DB-rebuilt) timeline with the timeline currently
 * on screen, for the post-connect resync of a still-running session.
 *
 * Why this exists: opening a running session from history reads the conversation
 * over HTTP, but the agent's streamed events are persisted by a lagging async
 * queue on the backend — so that first read can be stale/empty. After the socket
 * connects (and the backend flushes its persist queue), we re-read the DB and
 * call this to fold the fresh, authoritative timeline back in WITHOUT dropping
 * the handful of live events that arrived over the socket in the meantime.
 *
 * Strategy: keep every authoritative item (correct DB ids + full data, already
 * time-ordered by the restore), then append only the current items that have no
 * equivalent in the authoritative set. Stale first-restore items are a subset of
 * the authoritative set, so they collapse away with no duplication; genuinely
 * newer live items (not yet persisted when we re-read) survive as a chronological
 * suffix. We intentionally do NOT re-sort: authoritative is already sorted and
 * live items carry client-clock timestamps, so mixing them into a comparison
 * would be unreliable across client/server clock skew.
 */

import type { ChatItem } from '../types'

/**
 * Content-based identity for a chat item, independent of the id scheme (DB rows
 * use cuids, live-appended items use generated `type-timestamp-n` ids, so ids
 * can't be compared across the two sources).
 */
export function timelineItemKey(item: ChatItem): string {
  const it = item as any
  if ('role' in it) return `msg:${it.role}:${String(it.content || '').slice(0, 200)}`
  switch (it.type) {
    case 'thinking':
      return `think:${String(it.thought || '').slice(0, 200)}`
    case 'tool_execution':
      return `tool:${it.tool_name || ''}:${JSON.stringify(it.tool_args || {})}`
    case 'plan_wave':
      // wave_id is the stable identity once assigned; fall back to the local id
      // for a still-pending wave that has no wave_id yet.
      return `wave:${it.wave_id || it.id}`
    case 'deep_think':
      return `deep:${String(it.analysis || '').slice(0, 200)}`
    case 'lats_search':
      return `lats:${it.search_id}`
    case 'fireteam':
      return `ft:${it.fireteam_id}`
    case 'file_download':
      return `file:${it.filepath || ''}:${it.filename || ''}`
    default:
      return `id:${it.id}`
  }
}

/**
 * @param authoritative freshly rebuilt timeline from the DB (time-ordered)
 * @param current the timeline currently in React state (stale restore + any
 *                live events appended since)
 * @returns authoritative items followed by the current items with no
 *          authoritative equivalent (i.e. live events not yet persisted)
 */
export function reconcileTimeline(authoritative: ChatItem[], current: ChatItem[]): ChatItem[] {
  const known = new Set<string>()
  for (const item of authoritative) known.add(timelineItemKey(item))

  const survivors: ChatItem[] = []
  const seenNew = new Set<string>()
  for (const item of current) {
    const key = timelineItemKey(item)
    if (known.has(key)) continue      // superseded by the authoritative version
    if (seenNew.has(key)) continue    // de-dupe within the live suffix itself
    seenNew.add(key)
    survivors.push(item)
  }

  return [...authoritative, ...survivors]
}
