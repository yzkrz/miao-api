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
import { z } from 'zod'

import { parseQuotaFromDollars, quotaUnitsToEditableAmount } from '@/lib/format'
import {
  CALENDAR_WINDOWS,
  DAY_SECONDS,
  HOUR_SECONDS,
  type UserLimits,
  type CalendarPeriod,
} from '@/lib/usage-limits'

import type { UpdateUserLimitsPayload } from '../types'

// Bounds enforced by the server (model.MaxUserUsageRules and friends).
export const MAX_USAGE_RULES = 10
export const MAX_USER_CONCURRENCY = 1000
const MAX_WINDOW_SECONDS = 90 * DAY_SECONDS

/** Window choices offered first: 5 hours, 1 day, 7 days, 30 days. */
export const USAGE_WINDOW_PRESETS = [
  5 * HOUR_SECONDS,
  DAY_SECONDS,
  7 * DAY_SECONDS,
  30 * DAY_SECONDS,
] as const

export const CUSTOM_USAGE_WINDOW = 'custom'

export type UsageWindowUnit = 'hours' | 'days'

export interface UsageRuleFormValue {
  models?: string[]
  mode?: 'window' | 'calendar'
  calendar_period?: CalendarPeriod
  /** A preset length in seconds as a string, or CUSTOM_USAGE_WINDOW. */
  window: string
  custom_amount: number
  custom_unit: UsageWindowUnit
  /** Limit in the configured display currency. */
  quota_amount: number
  enabled: boolean
}

export interface UserLimitsFormValues {
  max_concurrency: number
  usage_rules: UsageRuleFormValue[]
}

export const NEW_USAGE_RULE: UsageRuleFormValue = {
  window: String(USAGE_WINDOW_PRESETS[0]),
  custom_amount: 12,
  custom_unit: 'hours',
  quota_amount: 0,
  enabled: true,
}

export function usageRuleWindowSeconds(rule: UsageRuleFormValue): number {
  if (rule.mode === 'calendar') {
    return CALENDAR_WINDOWS[rule.calendar_period ?? 'day']
  }
  if (rule.window !== CUSTOM_USAGE_WINDOW) {
    return Number(rule.window)
  }
  const unitSeconds = rule.custom_unit === 'days' ? DAY_SECONDS : HOUR_SECONDS
  return rule.custom_amount * unitSeconds
}

type Translate = (key: string, options?: Record<string, unknown>) => string

export function createUserLimitsFormSchema(t: Translate) {
  const concurrencyMessage = t('Enter an integer between {{min}} and {{max}}', {
    min: 0,
    max: MAX_USER_CONCURRENCY,
  })
  const amountMessage = t('Amount must be greater than 0')

  return z
    .object({
      max_concurrency: z
        .number()
        .int(concurrencyMessage)
        .min(0, concurrencyMessage)
        .max(MAX_USER_CONCURRENCY, concurrencyMessage),
      usage_rules: z
        .array(
          z.object({
            models: z
              .array(z.string().trim().min(1).max(512))
              .max(10000)
              .optional(),
            mode: z.enum(['window', 'calendar']).optional(),
            calendar_period: z
              .enum(['day', 'week', 'month', 'quarter', 'year'])
              .optional(),
            window: z.string(),
            custom_amount: z.number(),
            custom_unit: z.enum(['hours', 'days']),
            quota_amount: z.number().positive(amountMessage),
            enabled: z.boolean(),
          })
        )
        .max(
          MAX_USAGE_RULES,
          t('At most {{max}} usage limit rules can be configured', {
            max: MAX_USAGE_RULES,
          })
        ),
    })
    .superRefine((values, ctx) => {
      const seen = new Set<number>()
      values.usage_rules.forEach((rule, index) => {
        const seconds = usageRuleWindowSeconds(rule)
        if (
          rule.mode !== 'calendar' &&
          rule.window === CUSTOM_USAGE_WINDOW &&
          (!Number.isInteger(rule.custom_amount) ||
            seconds < HOUR_SECONDS ||
            seconds > MAX_WINDOW_SECONDS)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['usage_rules', index, 'custom_amount'],
            message: t('Enter a whole number of hours or days up to 90 days'),
          })
        }
        if (seen.has(seconds)) {
          ctx.addIssue({
            code: 'custom',
            path: ['usage_rules', index, 'window'],
            message: t('Another rule already uses this time window'),
          })
        }
        seen.add(seconds)
        // A tiny amount can round to 0 quota units, which the server rejects.
        if (
          rule.quota_amount > 0 &&
          parseQuotaFromDollars(rule.quota_amount) <= 0
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['usage_rules', index, 'quota_amount'],
            message: amountMessage,
          })
        }
      })
    })
}

export function userLimitsToFormValues(
  limits: UserLimits
): UserLimitsFormValues {
  return {
    max_concurrency: limits.max_concurrency,
    usage_rules: limits.usage_rules.map((rule) => {
      const isPreset = (USAGE_WINDOW_PRESETS as readonly number[]).includes(
        rule.window_seconds
      )
      const inDays = rule.window_seconds % DAY_SECONDS === 0
      return {
        ...(rule.models?.length ? { models: rule.models } : {}),
        ...(rule.mode === 'calendar'
          ? { mode: rule.mode, calendar_period: rule.calendar_period ?? 'day' }
          : {}),
        window: isPreset ? String(rule.window_seconds) : CUSTOM_USAGE_WINDOW,
        custom_amount: inDays
          ? rule.window_seconds / DAY_SECONDS
          : rule.window_seconds / HOUR_SECONDS,
        custom_unit: inDays ? 'days' : 'hours',
        quota_amount: quotaUnitsToEditableAmount(rule.quota_limit),
        enabled: rule.enabled,
      }
    }),
  }
}

export function userLimitsFormToPayload(
  values: UserLimitsFormValues
): UpdateUserLimitsPayload {
  return {
    max_concurrency: values.max_concurrency,
    usage_rules: values.usage_rules.map((rule) => ({
      ...(rule.models?.length
        ? { models: [...new Set(rule.models)].sort() }
        : {}),
      ...(rule.mode === 'calendar'
        ? { mode: rule.mode, calendar_period: rule.calendar_period ?? 'day' }
        : {}),
      window_seconds: usageRuleWindowSeconds(rule),
      quota_limit: parseQuotaFromDollars(rule.quota_amount),
      enabled: rule.enabled,
    })),
  }
}
