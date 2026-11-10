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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getEditableQuotaStep } from '@/lib/format'
import type { UserLimits } from '@/lib/usage-limits'
import {
  DEFAULT_CURRENCY_CONFIG,
  useSystemConfigStore,
} from '@/stores/system-config-store'

import {
  createUserLimitsFormSchema,
  userLimitsFormToPayload,
  userLimitsToFormValues,
  type UsageRuleFormValue,
  type UserLimitsFormValues,
} from '../user-limits-form'

const translate = (key: string) => key
const schema = createUserLimitsFormSchema(translate)

function savedLimits(rules: Array<[number, number, boolean]>): UserLimits {
  return {
    max_concurrency: 3,
    current_concurrency: 1,
    updated_at: 0,
    usage_rules: rules.map(([window_seconds, quota_limit, enabled]) => ({
      window_seconds,
      quota_limit,
      enabled,
      status: 'idle',
      used_quota: 0,
      window_start: 0,
      reset_at: 0,
    })),
  }
}

function rule(overrides: Partial<UsageRuleFormValue>): UsageRuleFormValue {
  return {
    window: '18000',
    custom_amount: 12,
    custom_unit: 'hours',
    quota_amount: 10,
    enabled: true,
    ...overrides,
  }
}

function issuePaths(values: UserLimitsFormValues): string[] {
  const result = schema.safeParse(values)
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join('.'))
}

beforeEach(() => {
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
})
afterEach(() => {
  useSystemConfigStore
    .getState()
    .setConfig({ currency: { ...DEFAULT_CURRENCY_CONFIG } })
})

describe('user limits form conversion', () => {
  it('round-trips calendar models while an empty scope stays applicable to all models', () => {
    const limits = savedLimits([[31536000, 500000, true]])
    limits.usage_rules[0] = {
      ...limits.usage_rules[0],
      mode: 'calendar',
      calendar_period: 'year',
      models: ['beta', 'alpha'],
    }
    const values = userLimitsToFormValues(limits)
    expect(issuePaths(values)).toEqual([])
    expect(userLimitsFormToPayload(values).usage_rules[0]).toEqual({
      window_seconds: 31536000,
      quota_limit: 500000,
      enabled: true,
      mode: 'calendar',
      calendar_period: 'year',
      models: ['alpha', 'beta'],
    })
    values.usage_rules[0].models = []
    expect(userLimitsFormToPayload(values).usage_rules[0]).not.toHaveProperty(
      'models'
    )
  })
  it('uses an exact decimal input step so whole CNY amounts are valid', () => {
    useSystemConfigStore.getState().setConfig({
      currency: {
        ...DEFAULT_CURRENCY_CONFIG,
        quotaDisplayType: 'CNY',
        usdExchangeRate: 7,
      },
    })
    expect(String(getEditableQuotaStep())).toBe('0.0001')
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '0'
    input.step = String(getEditableQuotaStep())
    input.value = '1000'
    expect(input.validity.stepMismatch).toBe(false)
  })
  it('maps preset, whole-day and whole-hour windows and USD amounts into form rows', () => {
    const values = userLimitsToFormValues(
      savedLimits([
        [18000, 5_000_000, true],
        [172800, 500_000, false],
        [43200, 250_000, true],
      ])
    )

    expect(values.max_concurrency).toBe(3)
    expect(values.usage_rules).toEqual([
      rule({ window: '18000', custom_amount: 5, quota_amount: 10 }),
      rule({
        window: 'custom',
        custom_amount: 2,
        custom_unit: 'days',
        quota_amount: 1,
        enabled: false,
      }),
      rule({ window: 'custom', custom_amount: 12, quota_amount: 0.5 }),
    ])
  })

  it('maps a window that is not whole hours to a minute row and back', () => {
    const values = userLimitsToFormValues(savedLimits([[5400, 500_000, true]]))

    expect(values.usage_rules).toEqual([
      rule({
        window: 'custom',
        custom_amount: 90,
        custom_unit: 'minutes',
        quota_amount: 1,
      }),
    ])
    expect(userLimitsFormToPayload(values).usage_rules[0].window_seconds).toBe(
      5400
    )
  })

  it('converts form rows back to window seconds and quota units', () => {
    const payload = userLimitsFormToPayload({
      max_concurrency: 2,
      usage_rules: [
        rule({ window: '604800', quota_amount: 20 }),
        rule({ window: 'custom', custom_amount: 3, custom_unit: 'days' }),
      ],
    })

    expect(payload).toEqual({
      max_concurrency: 2,
      usage_rules: [
        { window_seconds: 604800, quota_limit: 10_000_000, enabled: true },
        { window_seconds: 259200, quota_limit: 5_000_000, enabled: true },
      ],
    })
  })

  it('keeps raw quota units when quota is displayed as tokens', () => {
    useSystemConfigStore.getState().setConfig({
      currency: { ...DEFAULT_CURRENCY_CONFIG, quotaDisplayType: 'TOKENS' },
    })

    const values = userLimitsToFormValues(savedLimits([[86400, 123_456, true]]))
    expect(values.usage_rules[0].quota_amount).toBe(123_456)
    expect(userLimitsFormToPayload(values).usage_rules[0].quota_limit).toBe(
      123_456
    )
  })
})

describe('user limits form validation', () => {
  it('accepts an empty policy and a valid rule list', () => {
    expect(issuePaths({ max_concurrency: 0, usage_rules: [] })).toEqual([])
    expect(
      issuePaths({
        max_concurrency: 1000,
        usage_rules: [
          rule({ window: '18000' }),
          rule({ window: 'custom', custom_amount: 90, custom_unit: 'days' }),
          rule({ window: 'custom', custom_amount: 1, custom_unit: 'minutes' }),
        ],
      })
    ).toEqual([])
  })

  it.each([-1, 1001, 1.5])(
    'rejects a concurrency of %s outside 0-1000 integers',
    (maxConcurrency) => {
      expect(
        issuePaths({ max_concurrency: maxConcurrency, usage_rules: [] })
      ).toEqual(['max_concurrency'])
    }
  )

  it('flags the later of two rules that resolve to the same window', () => {
    expect(
      issuePaths({
        max_concurrency: 0,
        usage_rules: [
          rule({ window: '18000' }),
          rule({ window: 'custom', custom_amount: 5, custom_unit: 'hours' }),
        ],
      })
    ).toEqual(['usage_rules.1.window'])
  })

  it.each([
    [
      'longer than 90 days',
      rule({ window: 'custom', custom_amount: 91, custom_unit: 'days' }),
    ],
    [
      'shorter than 1 minute',
      rule({ window: 'custom', custom_amount: 0, custom_unit: 'minutes' }),
    ],
    ['not a whole number', rule({ window: 'custom', custom_amount: 1.5 })],
  ])('rejects a custom window %s', (_label, invalid) => {
    expect(issuePaths({ max_concurrency: 0, usage_rules: [invalid] })).toEqual([
      'usage_rules.0.custom_amount',
    ])
  })

  // 0.0000001 USD is 0.05 quota units, which rounds to 0.
  it.each([0, 0.0000001])(
    'rejects a limit amount of %s that is not a positive quota',
    (amount) => {
      expect(
        issuePaths({
          max_concurrency: 0,
          usage_rules: [rule({ quota_amount: amount })],
        })
      ).toEqual(['usage_rules.0.quota_amount'])
    }
  )
})
