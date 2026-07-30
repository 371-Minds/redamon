'use client'

import { DELTA_STATE_COLORS } from '../../utils'
import styles from './DeltaOverlayLegend.module.css'

interface DeltaOverlayLegendProps {
  fromLabel: string
  toLabel: string
  counts: { added: number; removed: number; changed: number; stable: number }
  changesOnly: boolean
  onToggleChangesOnly: (value: boolean) => void
}

const ITEMS: Array<{ state: keyof DeltaOverlayLegendProps['counts']; label: string }> = [
  { state: 'added', label: 'New' },
  { state: 'removed', label: 'Removed' },
  { state: 'changed', label: 'Changed' },
  { state: 'stable', label: 'Unchanged' },
]

/**
 * Legend + "changes only" switch for the Recon Delta graph overlay (Section 6.3).
 *
 * Comparing two large versions renders the UNION of both, which roughly doubles
 * the node count, so the default is changes-only and "show unchanged" is opt-in.
 */
export function DeltaOverlayLegend({
  fromLabel,
  toLabel,
  counts,
  changesOnly,
  onToggleChangesOnly,
}: DeltaOverlayLegendProps) {
  return (
    <div className={styles.legend}>
      <span className={styles.compare}>
        {fromLabel} <span className={styles.arrow}>→</span> {toLabel}
      </span>
      {ITEMS.map(({ state, label }) => (
        <span key={state} className={styles.item}>
          <span className={styles.swatch} style={{ background: DELTA_STATE_COLORS[state] }} />
          {label} ({counts[state]})
        </span>
      ))}
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={!changesOnly}
          onChange={e => onToggleChangesOnly(!e.target.checked)}
        />
        Show unchanged
      </label>
    </div>
  )
}

export default DeltaOverlayLegend
