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
  DEFAULT_MODEL_REPLACEMENT_SETTINGS,
  createDetectedModel,
  createModelReplacementSettingsSchema,
  findOverlappingWindows,
  setChannelIncluded,
} from '../lib/settings-form'
import type { ModelReplacementSettings } from '../types'

const schema = createModelReplacementSettingsSchema((key) => key)

function issuePaths(values: ModelReplacementSettings): string[] {
  const result = schema.safeParse(values)
  if (result.success) return []
  return result.error.issues.map((issue) => issue.path.join('.'))
}

describe('setChannelIncluded', () => {
  it('adds an unchecked channel to the exclusions in sorted order', () => {
    expect(setChannelIncluded([5], 2, false)).toEqual([2, 5])
  })

  it('removes a checked channel from the exclusions', () => {
    expect(setChannelIncluded([2, 5], 5, true)).toEqual([2])
  })
})

describe('model replacement settings schema', () => {
  it('accepts the defaults', () => {
    expect(issuePaths(DEFAULT_MODEL_REPLACEMENT_SETTINGS)).toEqual([])
  })

  it('validates request failure actions independently of replacement actions', () => {
    expect(
      issuePaths({
        ...DEFAULT_MODEL_REPLACEMENT_SETTINGS,
        fail_actions: [{ type: 'auto_disable', value: '', amount: 0 }],
        request_failure_actions: [{ type: 'set_tag', value: '', amount: 0 }],
      })
    ).toEqual(['request_failure_actions'])
    const result = schema.parse({
      ...DEFAULT_MODEL_REPLACEMENT_SETTINGS,
      request_failure_actions: [{ type: 'set_priority', value: '', amount: 7 }],
    })
    expect(result.request_failure_actions).toEqual([
      { type: 'set_priority', value: '', amount: 7 },
    ])
    expect(result.fail_actions).toEqual([])
  })

  it('accepts detection turned on with empty action lists', () => {
    expect(
      issuePaths({ ...DEFAULT_MODEL_REPLACEMENT_SETTINGS, enabled: true })
    ).toEqual([])
  })

  it('reports the first invalid action on its list', () => {
    expect(
      issuePaths({
        ...DEFAULT_MODEL_REPLACEMENT_SETTINGS,
        pass_actions: [{ type: 'add_group', value: 'healthy', amount: 0 }],
        fail_actions: [
          { type: 'auto_disable', value: '', amount: 0 },
          { type: 'decrease_priority', value: '', amount: 0 },
        ],
      })
    ).toEqual(['fail_actions'])
  })

  it('rejects an invalid regular expression answer', () => {
    const model = {
      ...createDetectedModel('gpt-4o'),
      question: 'Which model are you?',
      expected_answer: '(',
      match_mode: 'regex' as const,
    }
    expect(
      issuePaths({ ...DEFAULT_MODEL_REPLACEMENT_SETTINGS, models: [model] })
    ).toEqual(['models.0.expected_answer'])
  })

  it('requires a question and an expected answer for each model', () => {
    expect(
      issuePaths({
        ...DEFAULT_MODEL_REPLACEMENT_SETTINGS,
        models: [createDetectedModel('gpt-4o')],
      })
    ).toEqual(['models.0.question', 'models.0.expected_answer'])
  })
})

describe('interval windows', () => {
  const window = (start: string, end: string, interval_minutes = 30) => ({
    start,
    end,
    interval_minutes,
  })

  it('accepts adjacent windows that cover the whole day', () => {
    expect(
      findOverlappingWindows([
        window('00:00', '07:00', 60),
        window('07:00', '00:00'),
      ])
    ).toBeNull()
  })

  it('finds windows that overlap, including one that runs past midnight', () => {
    expect(
      findOverlappingWindows([
        window('00:00', '08:00'),
        window('07:00', '12:00'),
      ])
    ).toEqual([0, 1])
    expect(
      findOverlappingWindows([
        window('12:00', '13:00'),
        window('22:00', '02:00'),
        window('01:00', '03:00'),
      ])
    ).toEqual([1, 2])
  })

  it('reports an overlap on the window list and a zero-length window on its end time', () => {
    expect(
      issuePaths({
        ...DEFAULT_MODEL_REPLACEMENT_SETTINGS,
        interval_windows: [window('00:00', '08:00'), window('07:00', '12:00')],
      })
    ).toEqual(['interval_windows'])
    expect(
      issuePaths({
        ...DEFAULT_MODEL_REPLACEMENT_SETTINGS,
        interval_windows: [window('08:00', '08:00')],
      })
    ).toEqual(['interval_windows.0.end'])
  })

  it('rejects a time that is not HH:MM', () => {
    expect(
      issuePaths({
        ...DEFAULT_MODEL_REPLACEMENT_SETTINGS,
        interval_windows: [window('7:00', '08:00')],
      })
    ).toEqual(['interval_windows.0.start'])
  })
})
