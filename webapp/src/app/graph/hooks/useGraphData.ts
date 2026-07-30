import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { GraphData } from '../types'

// Store last ETag and data outside component to survive re-renders
const etagStore = new Map<string, { etag: string; data: GraphData }>()


async function fetchGraphData(projectId: string, fresh = false): Promise<GraphData> {
  const stored = etagStore.get(projectId)
  const headers: Record<string, string> = {}
  const fetchOpts: RequestInit = { headers }

  if (fresh) {
    // Bypass server in-memory cache (?fresh=1) and client ETag store.
    // Browser cache is already handled via Cache-Control: no-cache.
    etagStore.delete(projectId)
  } else if (stored?.etag) {
    headers['If-None-Match'] = `"${stored.etag}"`
  }

  const url = `/api/graph?projectId=${projectId}${fresh ? '&fresh=1' : ''}`
  const response = await fetch(url, fetchOpts)

  // 304 Not Modified -- return previous data, skip JSON parse entirely
  if (response.status === 304) {
    if (stored?.data) return stored.data
    // Fallback: shouldn't happen, but refetch without ETag
    const fallback = await fetch(`/api/graph?projectId=${projectId}`)
    return fallback.json()
  }

  if (!response.ok) {
    throw new Error('Failed to fetch graph data')
  }

  // Extract ETag from response
  const newEtag = response.headers.get('etag')?.replace(/"/g, '') || ''

  const data: GraphData = await response.json()

  // Store for next conditional request
  if (newEtag) {
    etagStore.set(projectId, { etag: newEtag, data })
  }

  return data
}

/**
 * Scan Timeline: render a PAST version from its stored snapshot. Same
 * `{nodes, links}` shape as the live payload, so every downstream consumer
 * (canvas, clustering, node/link tables) is unchanged. Immutable, so no ETag
 * negotiation is needed — react-query's cache is enough.
 */
async function fetchVersionGraphData(projectId: string, versionId: string): Promise<GraphData> {
  const response = await fetch(`/api/projects/${projectId}/versions/${versionId}/graph`)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error || 'Failed to fetch version graph data')
  }
  return response.json()
}

/**
 * @param versionId when set (and not the current version), the graph is read from
 * that version's stored snapshot instead of the live graph.
 */
export function useGraphData(projectId: string | null, versionId?: string | null) {
  const queryClient = useQueryClient()
  const isPastVersion = !!versionId

  // No timer-based polling. Refetches are driven by events (SSE log activity from
  // full/partial recon, agent tool-completion websockets, pipeline completion).
  const query = useQuery({
    queryKey: isPastVersion ? ['graph', projectId, versionId] : ['graph', projectId],
    queryFn: () => isPastVersion
      ? fetchVersionGraphData(projectId!, versionId!)
      : fetchGraphData(projectId!),
    enabled: !!projectId,
    refetchInterval: false,
    // A past version is immutable — never re-fetch it.
    staleTime: isPastVersion ? Infinity : 30000,
    // Only re-render the component when data or error actually change
    notifyOnChangeProps: ['data', 'error', 'isLoading'],
  })

  // Bypass all three cache layers (browser, server, client ETag) and
  // update react-query cache directly. Used after pipeline completion.
  // A past version has nothing to refresh.
  const refetchFresh = useCallback(async () => {
    if (!projectId || isPastVersion) return
    const data = await fetchGraphData(projectId, true)
    queryClient.setQueryData(['graph', projectId], data)
  }, [projectId, isPastVersion, queryClient])

  return { ...query, refetchFresh }
}
