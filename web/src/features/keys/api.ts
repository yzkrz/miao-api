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
import { api, getUserGroups, getUserModels } from '@/lib/api'

import type {
  ApiKey,
  ApiResponse,
  GetApiKeysParams,
  GetApiKeysResponse,
  SearchApiKeysParams,
  ApiKeyFormData,
  TokenAutoGroupsConfig,
} from './types'

export type ApiKeyManagementAction =
  | 'create'
  | 'update'
  | 'status'
  | 'delete'
  | 'reveal'
  | 'delete_batch'
  | 'reveal_batch'

export interface ApiKeysScope {
  userId: number
  authorize: (
    action: ApiKeyManagementAction,
    tokenIds: number[],
    count?: number
  ) => Promise<string | null>
}

function tokenBase(scope?: ApiKeysScope) {
  return scope ? `/api/user/${scope.userId}/tokens` : '/api/token'
}

async function tokenWriteOptions(
  scope: ApiKeysScope | undefined,
  action: ApiKeyManagementAction,
  ids: number[],
  count?: number
) {
  if (!scope) return undefined
  const uniqueIds = [...new Set(ids)].sort((a, b) => a - b)
  const proof = await scope.authorize(action, uniqueIds, count ?? 0)
  if (!proof) throw new DOMException('Verification cancelled', 'AbortError')
  return { headers: { 'X-Security-Proof': proof } }
}

// ============================================================================
// API Key Management
// ============================================================================

// Get paginated API keys list
export async function getApiKeys(
  params: GetApiKeysParams = {},
  scope?: ApiKeysScope
): Promise<GetApiKeysResponse> {
  const { p = 1, size = 10 } = params
  const res = await api.get(`${tokenBase(scope)}/?p=${p}&size=${size}`)
  return res.data
}

// Search API keys by keyword or token (with pagination)
export async function searchApiKeys(
  params: SearchApiKeysParams,
  scope?: ApiKeysScope
): Promise<GetApiKeysResponse> {
  const { keyword = '', token = '', p, size } = params
  const queryParams = new URLSearchParams()
  if (keyword) queryParams.set('keyword', keyword)
  if (token) queryParams.set('token', token)
  if (p != null) queryParams.set('p', String(p))
  if (size != null) queryParams.set('size', String(size))
  const res = await api.get(
    `${tokenBase(scope)}/search?${queryParams.toString()}`
  )
  return res.data
}

// Get single API key by ID
export async function getApiKey(
  id: number,
  scope?: ApiKeysScope
): Promise<ApiResponse<ApiKey>> {
  const res = await api.get(`${tokenBase(scope)}/${id}`)
  return res.data
}

// Get the current user's global Auto order and the per-token selection limit.
export async function getTokenAutoGroups(
  scope?: ApiKeysScope
): Promise<ApiResponse<TokenAutoGroupsConfig>> {
  const res = await api.get(`${tokenBase(scope)}/auto-groups`)
  return res.data
}

// Create a new API key
export async function createApiKey(
  data: ApiKeyFormData,
  scope?: ApiKeysScope
): Promise<ApiResponse<ApiKey>> {
  const options = await tokenWriteOptions(scope, 'create', [], 1)
  const res = options
    ? await api.post(`${tokenBase(scope)}/`, data, options)
    : await api.post('/api/token/', data)
  return res.data
}

// Update an existing API key
export async function updateApiKey(
  data: ApiKeyFormData & { id: number },
  scope?: ApiKeysScope
): Promise<ApiResponse<ApiKey>> {
  const options = await tokenWriteOptions(scope, 'update', [data.id])
  const res = options
    ? await api.put(`${tokenBase(scope)}/`, data, options)
    : await api.put('/api/token/', data)
  return res.data
}

// Delete a single API key
export async function deleteApiKey(
  id: number,
  scope?: ApiKeysScope
): Promise<ApiResponse> {
  const options = await tokenWriteOptions(scope, 'delete', [id])
  const res = options
    ? await api.delete(`${tokenBase(scope)}/${id}/`, options)
    : await api.delete(`/api/token/${id}/`)
  return res.data
}

// Batch delete multiple API keys
export async function batchDeleteApiKeys(
  ids: number[],
  scope?: ApiKeysScope
): Promise<ApiResponse<number>> {
  const options = await tokenWriteOptions(scope, 'delete_batch', ids)
  const res = options
    ? await api.post(`${tokenBase(scope)}/batch`, { ids }, options)
    : await api.post('/api/token/batch', { ids })
  return res.data
}

// Update API key status (enable/disable)
export async function updateApiKeyStatus(
  id: number,
  status: number,
  scope?: ApiKeysScope
): Promise<ApiResponse<ApiKey>> {
  const options = await tokenWriteOptions(scope, 'status', [id])
  const res = options
    ? await api.put(
        `${tokenBase(scope)}/?status_only=true`,
        { id, status },
        options
      )
    : await api.put('/api/token/?status_only=true', { id, status })
  return res.data
}

// Fetch the real (unmasked) key for a token by ID
export async function fetchTokenKey(
  id: number,
  scope?: ApiKeysScope
): Promise<{ success: boolean; message?: string; data?: { key: string } }> {
  const options = await tokenWriteOptions(scope, 'reveal', [id])
  const res = options
    ? await api.post(`${tokenBase(scope)}/${id}/key`, undefined, options)
    : await api.post(`/api/token/${id}/key`)
  return res.data
}

// Batch fetch real (unmasked) keys for multiple tokens
export async function fetchTokenKeysBatch(
  ids: number[],
  scope?: ApiKeysScope
): Promise<{
  success: boolean
  message?: string
  data?: { keys: Record<number, string> }
}> {
  const options = await tokenWriteOptions(scope, 'reveal_batch', ids)
  const res = options
    ? await api.post(`${tokenBase(scope)}/batch/keys`, { ids }, options)
    : await api.post('/api/token/batch/keys', { ids })
  return res.data
}

export async function getApiKeyModels(
  scope?: ApiKeysScope
): ReturnType<typeof getUserModels> {
  if (!scope) return getUserModels()
  const res = await api.get(`${tokenBase(scope)}/models`)
  return res.data
}

export async function getApiKeyGroups(
  scope?: ApiKeysScope
): ReturnType<typeof getUserGroups> {
  if (!scope) return getUserGroups()
  const res = await api.get(`${tokenBase(scope)}/groups`)
  return res.data
}

export async function createManagedApiKeys(
  tokens: ApiKeyFormData[],
  scope: ApiKeysScope
): Promise<ApiResponse<{ count: number }>> {
  const options = await tokenWriteOptions(scope, 'create', [], tokens.length)
  const res = await api.post(
    `${tokenBase(scope)}/batch/create`,
    { tokens },
    options
  )
  return res.data
}
