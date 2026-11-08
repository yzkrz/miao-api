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
import dayjs from 'dayjs'

import { CHANNEL_STATUS } from '@/features/channels/constants'

import type { DetectionChannelRow, DetectionRecord, Verdict } from '../types'

/**
 * Match percentage of a record. With a model selected it is that model's
 * match rate (null when the model was not detected in the record); without
 * one it is the worst match rate across the record's models.
 */
export function getRecordMatchPercent(
  record: DetectionRecord,
  model: string | null
): number | null {
  if (!model) return record.match_percent
  const stat = record.models.find(
    (item) => item.model === model && item.total > 0
  )
  return stat ? stat.match_percent : null
}

/**
 * Verdict of a record for the selected model, or the channel verdict when no
 * model is selected. Null when the model was not detected in the record.
 */
export function getRecordVerdict(
  record: DetectionRecord,
  model: string | null
): Verdict | null {
  if (!model) return record.verdict
  const stat = record.models.find((item) => item.model === model)
  return stat?.verdict ? stat.verdict : null
}

/** Formats a Unix-second range, omitting the end date when it is the same day. */
export function formatTimeRange(startedAt: number, finishedAt: number): string {
  if (!startedAt) return '-'
  const start = dayjs(startedAt * 1000)
  if (!finishedAt) return start.format('YYYY-MM-DD HH:mm:ss')
  const end = dayjs(finishedAt * 1000)
  const endFormat = start.isSame(end, 'day')
    ? 'HH:mm:ss'
    : 'YYYY-MM-DD HH:mm:ss'
  return `${start.format('YYYY-MM-DD HH:mm:ss')} – ${end.format(endFormat)}`
}

export type HealthPoint = {
  /** The run shown when the point is clicked; the latest run of a bucket. */
  recordId: number
  channelId: number
  /** Channel label; one line per channel when several are overlaid. */
  series: string
  /** Unix seconds of the run, or of the bucket start once aggregated. */
  timestamp: number
  time: string
  percent: number
  verdict: Verdict | null
  /** Number of runs averaged into the point; absent for a single run. */
  runs?: number
}

export function channelLabel(channel: {
  channel_id: number
  channel_name: string
}): string {
  return `#${channel.channel_id} ${channel.channel_name}`
}

/**
 * Chart points for detection history, one series per channel. Every point of
 * a run uses the run's start time, so the lines of different channels line
 * up. Records that did not detect the selected model are left out instead of
 * being drawn as 0%.
 */
export function buildHealthPoints(
  records: DetectionRecord[],
  model: string | null
): HealthPoint[] {
  const runStart = new Map<string, number>()
  for (const record of records) {
    const start = record.started_at || record.created_at
    const current = runStart.get(record.run_id)
    if (current === undefined || start < current) {
      runStart.set(record.run_id, start)
    }
  }
  const points: HealthPoint[] = []
  for (const record of records) {
    const percent = getRecordMatchPercent(record, model)
    if (percent == null) continue
    const start = runStart.get(record.run_id) ?? record.created_at
    points.push({
      recordId: record.id,
      channelId: record.channel_id,
      series: channelLabel(record),
      timestamp: start,
      time: dayjs(start * 1000).format('MM-DD HH:mm:ss'),
      percent: Math.round(percent * 100) / 100,
      verdict: getRecordVerdict(record, model),
    })
  }
  points.sort((a, b) => a.timestamp - b.timestamp || a.channelId - b.channelId)
  return points
}

/** Chart granularity choices in seconds; 0 plots every run. */
export const GRANULARITY_OPTIONS = [
  { value: 0, label: 'Each run' },
  { value: 60 * 60, label: '1 hour' },
  { value: 6 * 60 * 60, label: '6 hours' },
  { value: 12 * 60 * 60, label: '12 hours' },
  { value: 24 * 60 * 60, label: '1 day' },
  { value: 3 * 24 * 60 * 60, label: '3 days' },
] as const

const VERDICT_SEVERITY: Record<Verdict, number> = {
  passed: 1,
  failed: 2,
  replaced: 3,
}

/**
 * Averages each channel's points into buckets of `granularity` seconds that
 * start at `rangeStart`, the start of the selected date range. An aggregated
 * point keeps the worst verdict and the latest run of its bucket, and counts
 * the runs it averages. A granularity of 0 returns the points unchanged.
 */
export function aggregateHealthPoints(
  points: HealthPoint[],
  rangeStart: number,
  granularity: number
): HealthPoint[] {
  if (granularity <= 0) return points
  const buckets = new Map<
    string,
    { point: HealthPoint; latest: number; total: number; count: number }
  >()
  for (const point of points) {
    const start =
      rangeStart +
      Math.floor((point.timestamp - rangeStart) / granularity) * granularity
    const key = `${point.channelId}:${start}`
    const bucket = buckets.get(key)
    if (!bucket) {
      buckets.set(key, {
        point: {
          ...point,
          timestamp: start,
          time: dayjs(start * 1000).format('MM-DD HH:mm'),
        },
        latest: point.timestamp,
        total: point.percent,
        count: 1,
      })
      continue
    }
    bucket.total += point.percent
    bucket.count += 1
    if (point.timestamp >= bucket.latest) {
      bucket.latest = point.timestamp
      bucket.point.recordId = point.recordId
    }
    const current = bucket.point.verdict
    if (
      point.verdict &&
      (!current || VERDICT_SEVERITY[point.verdict] > VERDICT_SEVERITY[current])
    ) {
      bucket.point.verdict = point.verdict
    }
  }
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket.point,
      percent: Math.round((bucket.total / bucket.count) * 100) / 100,
      runs: bucket.count,
    }))
    .sort((a, b) => a.timestamp - b.timestamp || a.channelId - b.channelId)
}

/**
 * Channel labels in channel ID order. Used as the fixed color domain so a
 * channel keeps its color when a filter hides other channels.
 */
export function healthSeriesDomain(records: DetectionRecord[]): string[] {
  const labels = new Map<number, string>()
  for (const record of records) {
    labels.set(record.channel_id, channelLabel(record))
  }
  return [...labels.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, label]) => label)
}

/**
 * Channels whose latest detection covered the model; every channel when no
 * model is selected. Used to narrow the chart's channel choices.
 */
export function channelsForModel<T extends { latest: DetectionRecord | null }>(
  rows: T[],
  model: string | null
): T[] {
  if (!model) return rows
  return rows.filter((row) =>
    row.latest?.models.some((stat) => stat.model === model && stat.total > 0)
  )
}

export type ChannelStatusFilter =
  | 'all'
  | 'healthy'
  | 'abnormal'
  | 'failed'
  | 'unrequested'

export type ChannelSummaryFilter = {
  /** Channel ID as typed, with or without a leading #; empty matches all. */
  channelId: string
  status: ChannelStatusFilter
  /** Hides channels detected before but no longer in detection scope. */
  hideOutOfScope: boolean
  hideDisabled: boolean
  hideAutoDisabled: boolean
}

export const DEFAULT_CHANNEL_SUMMARY_FILTER: ChannelSummaryFilter = {
  channelId: '',
  status: 'all',
  hideOutOfScope: true,
  hideDisabled: true,
  hideAutoDisabled: true,
}

/**
 * Narrows by current channel visibility and the latest detection result for
 * the selected model. Request failures are separate from suspected replacements.
 */
export function filterChannelSummary<
  T extends Pick<DetectionChannelRow, 'id' | 'status' | 'in_scope' | 'latest'>,
>(rows: T[], filter: ChannelSummaryFilter, model: string | null): T[] {
  const channelId = filter.channelId.trim().replace(/^#/, '')
  return rows.filter((row) => {
    if (filter.hideOutOfScope && !row.in_scope) return false
    if (filter.hideDisabled && row.status === CHANNEL_STATUS.MANUAL_DISABLED) {
      return false
    }
    if (
      filter.hideAutoDisabled &&
      row.status === CHANNEL_STATUS.AUTO_DISABLED
    ) {
      return false
    }
    if (channelId && String(row.id) !== channelId) return false
    if (filter.status === 'all') return true
    const verdict = row.latest ? getRecordVerdict(row.latest, model) : null
    if (filter.status === 'unrequested') return verdict === null
    if (filter.status === 'failed') return verdict === 'failed'
    if (filter.status === 'healthy') return verdict === 'passed'
    return verdict === 'replaced'
  })
}

/** Counts each in-scope channel once, including disabled and untested channels. */
export function countChannelHealth(rows: DetectionChannelRow[]): {
  healthy: number
  total: number
} {
  const channels = new Map(
    rows.filter((row) => row.in_scope).map((row) => [row.id, row])
  )
  let healthy = 0
  for (const row of channels.values()) {
    if (
      row.status === CHANNEL_STATUS.ENABLED &&
      row.latest?.verdict === 'passed'
    ) {
      healthy += 1
    }
  }
  return { healthy, total: channels.size }
}

/** The chart's default date range: today in local time. */
export function todayRange(now: Date = new Date()): { start: Date; end: Date } {
  return {
    start: dayjs(now).startOf('day').toDate(),
    end: dayjs(now).endOf('day').toDate(),
  }
}
