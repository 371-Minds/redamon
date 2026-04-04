'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, Check, Info } from 'lucide-react'
import { icons } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { createPortal } from 'react-dom'
import { Modal } from '@/components/ui/Modal/Modal'
import { RECON_PRESETS, type ReconPreset } from '@/lib/recon-presets'
import styles from './ReconPresetModal.module.css'

interface ReconPresetDrawerProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (preset: ReconPreset) => void
  currentPresetId?: string
}

function PresetIcon({ name, size = 20 }: { name: string; size?: number }) {
  const Icon = icons[name as keyof typeof icons] as LucideIcon | undefined
  if (!Icon) return null
  return <Icon size={size} />
}

function renderDescription(text: string) {
  const parts = text.split(/^### /gm).filter(Boolean)
  return parts.map((part, i) => {
    const lines = part.split('\n')
    const title = lines[0]
    const body = lines.slice(1).join('\n').trim()
    return (
      <div key={i} className={styles.detailSection}>
        <h4>{title}</h4>
        {body.split('\n').map((line, j) => {
          const trimmed = line.trim()
          if (trimmed.startsWith('- ')) {
            return <div key={j} className={styles.detailLineBullet}>{trimmed}</div>
          }
          if (!trimmed) return <br key={j} />
          return <div key={j} className={styles.detailLine}>{trimmed}</div>
        })}
      </div>
    )
  })
}

export function ReconPresetModal({ isOpen, onClose, onSelect, currentPresetId }: ReconPresetDrawerProps) {
  const [detailPreset, setDetailPreset] = useState<ReconPreset | null>(null)

  // Close on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (detailPreset) {
        setDetailPreset(null)
      } else {
        onClose()
      }
    }
  }, [detailPreset, onClose])

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      document.body.style.overflow = 'hidden'
      return () => {
        document.removeEventListener('keydown', handleKeyDown)
        document.body.style.overflow = ''
      }
    }
  }, [isOpen, handleKeyDown])

  if (!isOpen) return null

  const drawer = (
    <>
      {/* Overlay */}
      <div
        className={styles.drawerOverlay}
        onClick={onClose}
      />

      {/* Drawer */}
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>Recon Presets</h2>
          <button
            type="button"
            className={styles.drawerClose}
            onClick={onClose}
            aria-label="Close drawer"
          >
            <X size={14} />
          </button>
        </div>

        <div className={styles.drawerBody}>
          {RECON_PRESETS.map(preset => {
            const isApplied = preset.id === currentPresetId

            return (
              <div
                key={preset.id}
                className={`${styles.card} ${isApplied ? styles.cardSelected : ''}`}
              >
                {preset.image && (
                  <img
                    src={preset.image}
                    alt=""
                    className={styles.cardImage}
                  />
                )}
                <div className={styles.cardHeader}>
                  <div className={styles.cardIcon}>
                    <PresetIcon name={preset.icon} />
                  </div>
                  <h3 className={styles.cardTitle}>{preset.name}</h3>
                </div>

                <p className={styles.cardDescription}>{preset.shortDescription}</p>

                <div className={styles.cardActions}>
                  <button
                    type="button"
                    className={styles.showMoreButton}
                    onClick={() => setDetailPreset(preset)}
                  >
                    <Info size={12} />
                    Show more
                  </button>

                  <button
                    type="button"
                    className={`${styles.selectButton} ${isApplied ? styles.selectButtonApplied : ''}`}
                    onClick={() => !isApplied && onSelect(preset)}
                    disabled={isApplied}
                  >
                    {isApplied ? (
                      <>
                        <Check size={12} />
                        Applied
                      </>
                    ) : (
                      'Select'
                    )}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Detail modal (centered, scrollable) */}
      {detailPreset && (
        <Modal
          isOpen={true}
          onClose={() => setDetailPreset(null)}
          title={detailPreset.name}
          size="default"
        >
          <div className={styles.detailBody}>
            {renderDescription(detailPreset.fullDescription)}
          </div>
        </Modal>
      )}
    </>
  )

  if (typeof document !== 'undefined') {
    return createPortal(drawer, document.body)
  }

  return null
}
