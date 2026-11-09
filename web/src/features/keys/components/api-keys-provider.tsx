/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import {
  SecureVerificationDialog,
  useSecureVerification,
} from '@/features/auth/secure-verification'
import useDialogState from '@/hooks/use-dialog'
import { handleServerError } from '@/lib/handle-server-error'
import { useAuthStore } from '@/stores/auth-store'

import {
  fetchTokenKey,
  fetchTokenKeysBatch,
  startKeyManagementSession,
  endKeyManagementSession,
  type KeyManagementSession,
  type ApiKeysScope,
} from '../api'
import { ERROR_MESSAGES } from '../constants'
import type { ApiKey, ApiKeysDialogType } from '../types'

type ApiKeysContextType = {
  scope?: ApiKeysScope
  verificationActive: boolean
  open: ApiKeysDialogType | null
  setOpen: (str: ApiKeysDialogType | null) => void
  currentRow: ApiKey | null
  setCurrentRow: React.Dispatch<React.SetStateAction<ApiKey | null>>
  refreshTrigger: number
  triggerRefresh: () => void
  resolvedKey: string
  setResolvedKey: React.Dispatch<React.SetStateAction<string>>
  resolveRealKey: (id: number) => Promise<string | null>
  resolveRealKeysBatch: (ids: number[]) => Promise<Record<number, string>>
  resolvedKeys: Record<number, string>
  loadingKeys: Record<number, boolean>
  copiedKeyId: number | null
  markKeyCopied: (id: number) => void
}

const ApiKeysContext = React.createContext<ApiKeysContextType | null>(null)

type ApiKeysProviderProps = {
  children: React.ReactNode
  owner?: { id: number; username: string }
}

export function ApiKeysProvider(props: ApiKeysProviderProps) {
  const userId = useAuthStore((state) => state.auth.user?.id)
  const sessionId = useAuthStore((state) => state.auth.session?.sid)
  return (
    <ApiKeysSession
      key={`${props.owner?.id ?? 'self'}:${userId ?? ''}:${sessionId ?? ''}`}
      {...props}
    />
  )
}

function ApiKeysSession(props: ApiKeysProviderProps) {
  const { t } = useTranslation()
  const verification = useSecureVerification()
  const requestVerification = verification.requestVerification
  const ownerId = props.owner?.id
  const ownerName = props.owner?.username
  const managementSession = useRef<KeyManagementSession | null>(null)
  const pendingAuthorization = useRef<Promise<{
    managementSession: string
  } | null> | null>(null)
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      const grant = managementSession.current
      managementSession.current = null
      if (ownerId !== undefined && grant) {
        void endKeyManagementSession(ownerId, grant.management_token).catch(
          () => {}
        )
      }
    }
  }, [ownerId])
  const scope = useMemo<ApiKeysScope | undefined>(() => {
    if (ownerId === undefined) return undefined
    return {
      userId: ownerId,
      authorize: async () => {
        if (!alive.current) return null
        const grant = managementSession.current
        if (grant && grant.expires_at > Date.now() / 1000) {
          return { managementSession: grant.management_token }
        }
        if (pendingAuthorization.current) return pendingAuthorization.current
        const pending = (async () => {
          const proof = await requestVerification({
            scope: 'admin.user.tokens',
            context: {
              user_id: ownerId,
              action: 'manage',
              token_ids: [],
              count: 0,
            },
            title: t('Verify API key management'),
            description: t(
              'Confirm your identity before managing API keys for {{username}}.',
              { username: ownerName }
            ),
          })
          if (!proof || !alive.current) return null
          const next = await startKeyManagementSession(
            ownerId,
            proof.proof_token
          )
          if (!alive.current) {
            await endKeyManagementSession(ownerId, next.management_token).catch(
              () => {}
            )
            return null
          }
          managementSession.current = next
          return { managementSession: next.management_token }
        })()
        pendingAuthorization.current = pending
        try {
          return await pending
        } finally {
          pendingAuthorization.current = null
        }
      },
    }
  }, [ownerId, ownerName, requestVerification, t])
  const [open, setOpen] = useDialogState<ApiKeysDialogType>(null)
  const [currentRow, setCurrentRow] = useState<ApiKey | null>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const [resolvedKey, setResolvedKey] = useState('')

  const [resolvedKeys, setResolvedKeys] = useState<Record<number, string>>({})
  const [loadingKeys, setLoadingKeys] = useState<Record<number, boolean>>({})
  const pendingRequests = useRef<Record<number, Promise<string | null>>>({})
  const active = useRef(true)

  const [copiedKeyId, setCopiedKeyId] = useState<number | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const markKeyCopied = useCallback((id: number) => {
    setCopiedKeyId(id)
    clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => setCopiedKeyId(null), 2000)
  }, [])

  const triggerRefresh = useCallback(() => {
    setResolvedKeys({})
    setResolvedKey('')
    setRefreshTrigger((prev) => prev + 1)
  }, [])

  const resolveRealKey = useCallback(
    async (id: number): Promise<string | null> => {
      if (resolvedKeys[id]) return resolvedKeys[id]
      if (id in pendingRequests.current) return pendingRequests.current[id]

      const request = (async () => {
        setLoadingKeys((prev) => ({ ...prev, [id]: true }))
        try {
          const res = await fetchTokenKey(id, scope)
          if (!active.current) return null
          if (res.success && res.data?.key) {
            const fullKey = `sk-${res.data.key}`
            setResolvedKeys((prev) => ({ ...prev, [id]: fullKey }))
            return fullKey
          }
          handleServerError(res, t(ERROR_MESSAGES.UNEXPECTED))
          return null
        } catch (error) {
          handleServerError(error, t(ERROR_MESSAGES.UNEXPECTED))
          return null
        } finally {
          delete pendingRequests.current[id]
          setLoadingKeys((prev) => {
            const next = { ...prev }
            delete next[id]
            return next
          })
        }
      })()

      pendingRequests.current[id] = request
      return request
    },
    [resolvedKeys, scope, t]
  )

  const resolveRealKeysBatch = useCallback(
    async (ids: number[]): Promise<Record<number, string>> => {
      const uncachedIds = ids.filter((id) => !resolvedKeys[id])
      if (uncachedIds.length === 0) {
        const result: Record<number, string> = {}
        for (const id of ids) result[id] = resolvedKeys[id]
        return result
      }

      for (const id of uncachedIds) {
        setLoadingKeys((prev) => ({ ...prev, [id]: true }))
      }

      try {
        const res = await fetchTokenKeysBatch(uncachedIds, scope)
        if (!active.current) return {}
        if (res.success && res.data?.keys) {
          const newKeys: Record<number, string> = {}
          for (const [idStr, key] of Object.entries(res.data.keys)) {
            newKeys[Number(idStr)] = `sk-${key}`
          }
          setResolvedKeys((prev) => ({ ...prev, ...newKeys }))

          const result: Record<number, string> = { ...newKeys }
          for (const id of ids) {
            if (resolvedKeys[id]) result[id] = resolvedKeys[id]
          }
          return result
        }
        handleServerError(res, t(ERROR_MESSAGES.UNEXPECTED))
        return {}
      } catch (error) {
        handleServerError(error, t(ERROR_MESSAGES.UNEXPECTED))
        return {}
      } finally {
        for (const id of uncachedIds) {
          setLoadingKeys((prev) => {
            const next = { ...prev }
            delete next[id]
            return next
          })
        }
      }
    },
    [resolvedKeys, scope, t]
  )

  return (
    <ApiKeysContext
      value={{
        scope,
        verificationActive: verification.isActive,
        open,
        setOpen,
        currentRow,
        setCurrentRow,
        refreshTrigger,
        triggerRefresh,
        resolvedKey,
        setResolvedKey,
        resolveRealKey,
        resolveRealKeysBatch,
        resolvedKeys,
        loadingKeys,
        copiedKeyId,
        markKeyCopied,
      }}
    >
      {props.children}
      <SecureVerificationDialog {...verification.dialogProps} />
    </ApiKeysContext>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useApiKeys = () => {
  const apiKeysContext = React.useContext(ApiKeysContext)

  if (!apiKeysContext) {
    throw new Error('useApiKeys has to be used within <ApiKeysContext>')
  }

  return apiKeysContext
}
