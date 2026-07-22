/**
 * LATS Search Card (Layer 1) — the in-chat live view of an exploit-path search.
 *
 * One card that mutates in place as the search runs: a HUD row (rollouts,
 * probe budget, depth, phase, observe-only badge in shadow mode), the tree as a
 * compact collapsible indented outline with per-status node glyphs, and the
 * current best root-to-hot-leaf line pinned at the bottom. "Expand tree" opens
 * the full React Flow canvas (Layer 2, wired in a later step).
 */

'use client'

import { useState } from 'react'
import { GitBranch, Maximize2 } from 'lucide-react'
import styles from './LatsSearchCard.module.css'
import { LatsTreePanel } from './LatsTreePanel'
import type { LatsSearchItem } from './AgentTimeline'
import type { LatsNodeView, LatsNodeStatus } from '@/lib/websocket-types'

interface LatsSearchCardProps {
  item: LatsSearchItem
  /** Test seam / override; when omitted the card opens the built-in tree panel. */
  onExpand?: () => void
}

const STATUS_GLYPH: Record<LatsNodeStatus, string> = {
  proposed: '·',    // ·  queued
  executing: '○',   // ○  running
  evaluated: '◉',   // ◉  scored
  pruned: '✗',      // ✗  dead
  terminal: '⚑',    // ⚑  foothold
}

function buildChildrenMap(nodes: LatsNodeView[]): Map<string | null, LatsNodeView[]> {
  const byParent = new Map<string | null, LatsNodeView[]>()
  for (const n of nodes) {
    const key = n.parent_id
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(n)
  }
  return byParent
}

function OutlineNode({
  node,
  byParent,
  bestSet,
  depth,
}: {
  node: LatsNodeView
  byParent: Map<string | null, LatsNodeView[]>
  bestSet: Set<string>
  depth: number
}) {
  const children = byParent.get(node.id) ?? []
  const isHot = bestSet.has(node.id) && node.status !== 'pruned'
  const rowClass = [
    styles.node,
    node.status === 'pruned' ? styles.pruned : '',
    isHot ? styles.hot : '',
    node.status === 'terminal' ? styles.terminal : '',
  ].filter(Boolean).join(' ')
  return (
    <>
      <div className={rowClass} style={{ paddingLeft: `${depth * 14}px` }} data-status={node.status}>
        <span className={styles.glyph}>{STATUS_GLYPH[node.status]}</span>
        <span className={styles.nodeLabel}>{node.label || node.tool_name || node.id}</span>
        {node.is_dangerous && <span className={styles.dangerFlag} title="Will prompt for confirmation">!</span>}
        <span className={styles.nodeValue}>{node.value.toFixed(2)}</span>
        {node.reflection ? (
          <span className={styles.reflection}>{node.reflection}</span>
        ) : node.observation ? (
          <span className={styles.observation}>{node.observation}</span>
        ) : null}
      </div>
      {children.map(c => (
        <OutlineNode key={c.id} node={c} byParent={byParent} bestSet={bestSet} depth={depth + 1} />
      ))}
    </>
  )
}

export function LatsSearchCard({ item, onExpand }: LatsSearchCardProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const snap = item.latest
  const byParent = buildChildrenMap(snap.nodes)
  const roots = byParent.get(null) ?? []
  const bestSet = new Set(snap.best_trajectory)
  const probes = snap.nodes.filter(n => n.status !== 'proposed').length
  const maxDepthReached = snap.nodes.reduce((m, n) => Math.max(m, n.depth), 0)
  const bestLabels = snap.best_trajectory
    .map(id => snap.nodes.find(n => n.id === id))
    .filter((n): n is LatsNodeView => !!n)
    .map(n => n.label || n.tool_name || n.id)

  return (
    <div className={styles.card} data-testid="lats-search-card">
      <div className={styles.header} onClick={() => setCollapsed(c => !c)}>
        <GitBranch size={14} className={styles.headerIcon} />
        <span className={styles.title}>Exploit-Path Search</span>
        {item.status === 'running' && (
          <span className={styles.statusBadge}>
            <span className={styles.statusDot} />running
          </span>
        )}
        <span className={styles.phaseBadge}>{snap.phase}</span>
        <span className={styles.rolloutBadge}>rollout {snap.rollouts}/{snap.budget.max_rollouts}</span>
        {item.shadow_mode && <span className={styles.shadowBadge}>observe-only</span>}
        {item.status === 'complete' && (
          <span className={styles.outcomeBadge} data-outcome={item.outcome}>{item.outcome}</span>
        )}
      </div>

      <div className={styles.hud}>
        <span>probes {probes}/{snap.budget.max_rollouts}</span>
        <span>depth {maxDepthReached}/{snap.budget.max_depth}</span>
        <span>{snap.nodes.length} nodes</span>
      </div>

      {!collapsed && (
        <div className={styles.outline}>
          {roots.map(r => (
            <OutlineNode key={r.id} node={r} byParent={byParent} bestSet={bestSet} depth={0} />
          ))}
        </div>
      )}

      {bestLabels.length > 0 && (
        <div className={styles.bestLine} data-testid="lats-best-line">
          <span className={styles.bestLineLabel}>best line:</span>
          <span className={styles.bestLinePath}>{bestLabels.join(' > ')}</span>
        </div>
      )}

      <div className={styles.footer}>
        <button
          className={styles.expandBtn}
          onClick={() => (onExpand ? onExpand() : setPanelOpen(true))}
          data-testid="lats-expand-btn"
        >
          <Maximize2 size={14} /> Expand tree
        </button>
      </div>

      {panelOpen && (
        <LatsTreePanel item={item} isOpen={panelOpen} onClose={() => setPanelOpen(false)} />
      )}
    </div>
  )
}
