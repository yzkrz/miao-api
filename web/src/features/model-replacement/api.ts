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
import { api } from '@/lib/api'

import type {
  ApiResponse,
  DetectionChannelRow,
  DetectionOverview,
  DetectionRecord,
  DetectionRun,
  ModelCandidate,
  ModelReplacementSettings,
  RecordAttempts,
  SettingsResponse,
} from './types'

const BASE_PATH = '/api/model_replacement'

export const modelReplacementQueryKeys = {
  all: ['model-replacement'] as const,
  settings: () => [...modelReplacementQueryKeys.all, 'settings'] as const,
  candidates: () => [...modelReplacementQueryKeys.all, 'candidates'] as const,
  overview: () => [...modelReplacementQueryKeys.all, 'overview'] as const,
  channels: () => [...modelReplacementQueryKeys.all, 'channels'] as const,
  history: (filter: HistoryFilter) =>
    [
      ...modelReplacementQueryKeys.all,
      'history',
      filter.channelId ?? 'all',
      filter.start,
      filter.end,
    ] as const,
  attempts: (recordId: number) =>
    [...modelReplacementQueryKeys.all, 'attempts', recordId] as const,
}

export async function getModelReplacementSettings() {
  const res = await api.get<ApiResponse<SettingsResponse>>(
    `${BASE_PATH}/settings`
  )
  return res.data
}

export async function updateModelReplacementSettings(
  settings: ModelReplacementSettings
) {
  const res = await api.put<ApiResponse<ModelReplacementSettings>>(
    `${BASE_PATH}/settings`,
    settings
  )
  return res.data
}

export async function getModelReplacementCandidates() {
  const res = await api.get<ApiResponse<ModelCandidate[]>>(
    `${BASE_PATH}/candidates`
  )
  return res.data
}

export async function getModelReplacementOverview() {
  const res = await api.get<ApiResponse<DetectionOverview>>(
    `${BASE_PATH}/overview`
  )
  return res.data
}

export async function runModelReplacementDetection() {
  const res = await api.post<ApiResponse<DetectionRun>>(`${BASE_PATH}/run`)
  return res.data
}

export async function runModelReplacementChannelDetection(channelId: number) {
  const res = await api.post<ApiResponse<DetectionRun>>(
    `${BASE_PATH}/channels/${channelId}/run`
  )
  return res.data
}

export async function getModelReplacementChannels() {
  const res = await api.get<ApiResponse<DetectionChannelRow[]>>(
    `${BASE_PATH}/channels`
  )
  return res.data
}

export type HistoryFilter = {
  /** Null covers every channel. */
  channelId: number | null
  /** Unix seconds, inclusive. */
  start: number
  end: number
}

/** Records created in the range, oldest first, for one channel or all. */
export async function getModelReplacementHistory(filter: HistoryFilter) {
  const res = await api.get<ApiResponse<DetectionRecord[]>>(
    `${BASE_PATH}/history`,
    {
      params: {
        channel_id: filter.channelId ?? undefined,
        start: filter.start,
        end: filter.end,
      },
    }
  )
  return res.data
}

export async function getModelReplacementAttempts(recordId: number) {
  const res = await api.get<ApiResponse<RecordAttempts>>(
    `${BASE_PATH}/records/${recordId}/attempts`
  )
  return res.data
}
