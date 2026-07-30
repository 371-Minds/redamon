/**
 * Object-level ownership for Scan Timeline version ids (anti-IDOR/BOLA).
 *
 * `requireProjectAccess` proves the caller owns the PROJECT; it says nothing
 * about a client-supplied `versionId`. Without this second check a user who owns
 * project A could read/delete/activate a snapshot belonging to project B by
 * guessing its id. Every route that accepts a version id must go through here,
 * and a version that belongs to another project is reported as 404 (the repo's
 * anti-enumeration convention), never 403.
 */
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

export interface OwnedVersion {
  id: string
  projectId: string
  seq: number
  label: string
  isCurrent: boolean
  pinned: boolean
  nodeCount: number | null
  linkCount: number | null
  createdAt: Date
  hasSnapshot: boolean
}

const NOT_FOUND = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

/**
 * Load a ScanVersion and verify it belongs to `projectId`.
 * Returns the row, or a 404 NextResponse the caller must return.
 */
export async function requireVersionInProject(
  projectId: string,
  versionId: string
): Promise<OwnedVersion | NextResponse> {
  if (!versionId || typeof versionId !== 'string') return NOT_FOUND()

  const row = await prisma.scanVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      projectId: true,
      seq: true,
      label: true,
      isCurrent: true,
      pinned: true,
      nodeCount: true,
      linkCount: true,
      createdAt: true,
      // Only the presence of bytes — never select the payload itself here.
      snapshot: false,
    },
  })
  if (!row || row.projectId !== projectId) return NOT_FOUND()

  // `snapshot` is potentially megabytes, so ask Postgres for its size instead of
  // loading it just to answer "is this version activatable?".
  const [sizeRow] = await prisma.$queryRaw<Array<{ len: number | null }>>`
    SELECT octet_length(snapshot) AS len FROM scan_versions WHERE id = ${versionId}
  `
  return { ...row, hasSnapshot: (sizeRow?.len ?? 0) > 0 }
}

/**
 * Resolve a `from`/`to`-style version selector: the literal 'current' (the live
 * graph) or a version id that must belong to the project.
 */
export async function resolveVersionSelector(
  projectId: string,
  selector: string | null
): Promise<{ current: true } | OwnedVersion | NextResponse> {
  if (!selector || selector === 'current') return { current: true }
  return requireVersionInProject(projectId, selector)
}

export function isCurrentSelector(
  v: { current: true } | OwnedVersion
): v is { current: true } {
  return (v as { current?: true }).current === true
}
