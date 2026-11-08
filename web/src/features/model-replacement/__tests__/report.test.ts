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
import { describe, expect, it } from 'vitest'

import {
  aggregateHealthPoints,
  buildHealthPoints,
  channelsForModel,
  countChannelHealth,
  DEFAULT_CHANNEL_SUMMARY_FILTER,
  filterChannelSummary,
  getRecordMatchPercent,
  getRecordVerdict,
  healthSeriesDomain,
  todayRange,
  type HealthPoint,
} from '../lib/report'
import type { DetectionChannelRow, DetectionRecord } from '../types'

function record(overrides: Partial<DetectionRecord> = {}): DetectionRecord {
  return {
    id: 1,
    run_id: 'run-1',
    channel_id: 7,
    channel_name: 'upstream',
    verdict: 'replaced',
    match_percent: 50,
    actions: [],
    error_message: '',
    avg_latency_ms: 800,
    started_at: 1_700_000_000,
    finished_at: 1_700_000_030,
    created_at: 1_700_000_031,
    models: [
      {
        model: 'gpt-4o',
        total: 2,
        matched: 2,
        mismatched: 0,
        failed: 0,
        match_percent: 100,
        mismatch_percent: 0,
        verdict: 'passed',
      },
      {
        model: 'claude',
        total: 2,
        matched: 1,
        mismatched: 1,
        failed: 0,
        match_percent: 50,
        mismatch_percent: 50,
        verdict: 'replaced',
      },
    ],
    ...overrides,
  }
}

describe('record percentages', () => {
  it('uses the worst model when no model is selected', () => {
    expect(getRecordMatchPercent(record(), null)).toBe(50)
    expect(getRecordVerdict(record(), null)).toBe('replaced')
  })

  it('uses the selected model when one is selected', () => {
    expect(getRecordMatchPercent(record(), 'gpt-4o')).toBe(100)
    expect(getRecordVerdict(record(), 'gpt-4o')).toBe('passed')
  })

  it('returns null when the selected model was not detected in the record', () => {
    expect(getRecordMatchPercent(record(), 'gemini')).toBeNull()
    expect(getRecordVerdict(record(), 'gemini')).toBeNull()
  })
})

describe('buildHealthPoints', () => {
  it('skips runs that did not detect the selected model instead of plotting 0%', () => {
    const withoutClaude = record({
      id: 2,
      run_id: 'run-2',
      started_at: 1_700_000_600,
      models: [record().models[0]],
      match_percent: 100,
      verdict: 'passed',
    })

    const points = buildHealthPoints([record(), withoutClaude], 'claude')

    expect(points.map((point) => point.recordId)).toEqual([1])
    expect(points[0]).toMatchObject({ percent: 50, verdict: 'replaced' })
  })

  it('aligns the channels of one run on the run start and orders them by channel', () => {
    const later = record({
      id: 3,
      channel_id: 2,
      channel_name: 'beta',
      started_at: 1_700_000_020,
      match_percent: 100,
      verdict: 'passed',
    })
    const nextRun = record({
      id: 4,
      run_id: 'run-2',
      started_at: 1_700_000_600,
    })

    const points = buildHealthPoints([later, record(), nextRun], null)

    expect(points.map((point) => [point.recordId, point.series])).toEqual([
      [3, '#2 beta'],
      [1, '#7 upstream'],
      [4, '#7 upstream'],
    ])
    expect(points[0].time).toBe(points[1].time)
    expect(points[2].time).not.toBe(points[0].time)
  })
})

describe('healthSeriesDomain', () => {
  it('lists each channel once in channel ID order so colors follow the channel', () => {
    const domain = healthSeriesDomain([
      record({ channel_id: 9, channel_name: 'zeta' }),
      record({ channel_id: 2, channel_name: 'beta' }),
      record({ id: 5, channel_id: 9, channel_name: 'zeta' }),
    ])

    expect(domain).toEqual(['#2 beta', '#9 zeta'])
  })
})

describe('channelsForModel', () => {
  it('keeps only channels whose latest run detected the selected model', () => {
    const rows = [
      { id: 1, latest: record() },
      {
        id: 2,
        latest: record({ models: [record().models[0]] }),
      },
      { id: 3, latest: null },
    ]

    expect(channelsForModel(rows, 'claude').map((row) => row.id)).toEqual([1])
    expect(channelsForModel(rows, null).map((row) => row.id)).toEqual([1, 2, 3])
  })
})

describe('todayRange', () => {
  it('covers the whole local day of the given time', () => {
    const range = todayRange(new Date(2026, 10, 5, 14, 30))

    expect(range.start).toEqual(new Date(2026, 10, 5, 0, 0, 0, 0))
    expect(range.end).toEqual(new Date(2026, 10, 5, 23, 59, 59, 999))
  })
})

describe('aggregateHealthPoints', () => {
  const point = (overrides: Partial<HealthPoint>): HealthPoint => ({
    recordId: 1,
    channelId: 7,
    series: '#7 upstream',
    timestamp: 0,
    time: '',
    percent: 100,
    verdict: 'passed',
    ...overrides,
  })
  // 00:30 local time, so buckets start at :30 rather than on the hour.
  const rangeStart = new Date(2026, 10, 6, 0, 30).getTime() / 1000
  const hour = 60 * 60

  it('averages each channel per period counted from the start of the range', () => {
    const points = [
      point({ recordId: 1, timestamp: rangeStart + 60, percent: 100 }),
      point({
        recordId: 2,
        timestamp: rangeStart + 600,
        percent: 50,
        verdict: 'replaced',
      }),
      point({ recordId: 3, timestamp: rangeStart + hour + 60, percent: 100 }),
      point({
        recordId: 9,
        channelId: 2,
        series: '#2 beta',
        timestamp: rangeStart + 120,
        percent: 0,
        verdict: 'failed',
      }),
    ]

    const result = aggregateHealthPoints(points, rangeStart, hour)

    expect(
      result.map(
        ({ recordId, channelId, timestamp, percent, verdict, runs, time }) => ({
          recordId,
          channelId,
          offset: timestamp - rangeStart,
          percent,
          verdict,
          runs,
          time,
        })
      )
    ).toEqual([
      {
        recordId: 9,
        channelId: 2,
        offset: 0,
        percent: 0,
        verdict: 'failed',
        runs: 1,
        time: '11-06 00:30',
      },
      {
        recordId: 2,
        channelId: 7,
        offset: 0,
        percent: 75,
        verdict: 'replaced',
        runs: 2,
        time: '11-06 00:30',
      },
      {
        recordId: 3,
        channelId: 7,
        offset: hour,
        percent: 100,
        verdict: 'passed',
        runs: 1,
        time: '11-06 01:30',
      },
    ])
  })

  it('leaves the points unchanged when every run is plotted', () => {
    const points = [point({ timestamp: rangeStart + 60 })]

    expect(aggregateHealthPoints(points, rangeStart, 0)).toBe(points)
  })
})

describe('filterChannelSummary', () => {
  const row = (
    overrides: Partial<DetectionChannelRow> & { id: number }
  ): DetectionChannelRow => ({
    name: `channel-${overrides.id}`,
    type: 1,
    status: 1,
    groups: [],
    in_scope: true,
    latest: record({ verdict: 'passed' }),
    ...overrides,
  })
  const rows = [
    row({ id: 1 }),
    row({ id: 2, status: 3, latest: record({ verdict: 'replaced' }) }),
    row({ id: 3, in_scope: false }),
    row({ id: 12, latest: null }),
  ]
  const ids = (filtered: DetectionChannelRow[]) =>
    filtered.map((item) => item.id)

  it('hides channels no longer in detection scope by default and keeps them once the option is off', () => {
    expect(
      ids(filterChannelSummary(rows, DEFAULT_CHANNEL_SUMMARY_FILTER, null))
    ).toEqual([1, 12])
    expect(
      ids(
        filterChannelSummary(
          rows,
          { ...DEFAULT_CHANNEL_SUMMARY_FILTER, hideOutOfScope: false },
          null
        )
      )
    ).toEqual([1, 3, 12])
  })

  it('matches the typed channel ID exactly, with or without a leading #', () => {
    const byId = (channelId: string) =>
      ids(
        filterChannelSummary(
          rows,
          { ...DEFAULT_CHANNEL_SUMMARY_FILTER, channelId },
          null
        )
      )

    expect(byId('1')).toEqual([1])
    expect(byId(' #12 ')).toEqual([12])
    expect(byId('abc')).toEqual([])
  })

  it('sorts healthy and abnormal by the result shown for the selected model and skips undetected channels', () => {
    const byStatus = (status: 'healthy' | 'abnormal', model: string | null) =>
      ids(
        filterChannelSummary(
          rows,
          {
            ...DEFAULT_CHANNEL_SUMMARY_FILTER,
            status,
            hideAutoDisabled: false,
          },
          model
        )
      )

    expect(byStatus('healthy', null)).toEqual([1])
    expect(byStatus('abnormal', null)).toEqual([2])
    // Both records passed gpt-4o, whatever their worst model did.
    expect(byStatus('healthy', 'gpt-4o')).toEqual([1, 2])
    expect(byStatus('abnormal', 'claude')).toEqual([1, 2])
  })

  it('shows automatically disabled channels only when the hide option is cleared', () => {
    expect(
      ids(
        filterChannelSummary(
          rows,
          { ...DEFAULT_CHANNEL_SUMMARY_FILTER, hideAutoDisabled: false },
          null
        )
      )
    ).toEqual([1, 2, 12])
  })

  it('counts the in-scope union including disabled and untested channels, but only enabled passing channels are healthy', () => {
    const enabled = row({ id: 1 })
    const counted = [
      enabled,
      row({ id: 2, status: 2 }),
      row({ id: 3, status: 3 }),
      row({ id: 4, latest: null }),
      row({ id: 5, latest: record({ verdict: 'failed' }) }),
      row({ id: 6, in_scope: false }),
      enabled,
    ]
    expect(countChannelHealth(counted)).toEqual({ healthy: 1, total: 5 })
    expect(countChannelHealth([])).toEqual({ healthy: 0, total: 0 })
  })

  it('separates failed requests, unrequested models and suspected replacements', () => {
    const items = [
      row({ id: 1, latest: record({ verdict: 'failed' }) }),
      row({ id: 2, latest: record({ verdict: 'replaced' }) }),
      row({ id: 3, latest: null }),
    ]
    expect(
      ids(
        filterChannelSummary(
          items,
          { ...DEFAULT_CHANNEL_SUMMARY_FILTER, status: 'failed' },
          null
        )
      )
    ).toEqual([1])
    expect(
      ids(
        filterChannelSummary(
          items,
          { ...DEFAULT_CHANNEL_SUMMARY_FILTER, status: 'abnormal' },
          null
        )
      )
    ).toEqual([2])
    expect(
      ids(
        filterChannelSummary(
          items,
          { ...DEFAULT_CHANNEL_SUMMARY_FILTER, status: 'unrequested' },
          null
        )
      )
    ).toEqual([3])
    expect(
      ids(
        filterChannelSummary(
          items,
          { ...DEFAULT_CHANNEL_SUMMARY_FILTER, status: 'unrequested' },
          'gemini'
        )
      )
    ).toEqual([1, 2, 3])
  })
})
