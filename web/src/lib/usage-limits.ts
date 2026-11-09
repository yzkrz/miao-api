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
import type { TFunction } from 'i18next'

export const HOUR_SECONDS = 3600
export const DAY_SECONDS = 86400

/**
 * Window state of a usage limit rule: `idle` has not started (or expired and
 * waits for the next charged request), `exhausted` blocks requests until
 * `reset_at`.
 */
export type UsageWindowStatus = 'idle' | 'active' | 'exhausted'

export interface UsageRuleStatus {
  models?: string[]
  mode?: 'window' | 'calendar'
  calendar_period?: CalendarPeriod
  window_seconds: number
  quota_limit: number
  enabled: boolean
  status: UsageWindowStatus
  used_quota: number
  window_start: number
  reset_at: number
}

/** Usage limits and concurrency cap an administrator set for one user. */
export interface UserLimits {
  server_time_zone?: string
  max_concurrency: number
  current_concurrency: number
  usage_rules: UsageRuleStatus[]
  updated_at: number
}

export type CalendarPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year'
export const CALENDAR_WINDOWS: Record<CalendarPeriod, number> = {
  day: 86400,
  week: 604800,
  month: 2592000,
  quarter: 7776000,
  year: 31536000,
}

export function formatCalendarPeriod(
  period: CalendarPeriod,
  t: TFunction
): string {
  switch (period) {
    case 'day':
      return t('Calendar day')
    case 'week':
      return t('Calendar week')
    case 'month':
      return t('Calendar month')
    case 'quarter':
      return t('Calendar quarter')
    case 'year':
      return t('Calendar year')
  }
}

export function formatUsageRuleWindow(
  rule: UsageRuleStatus,
  t: TFunction
): string {
  if (rule.mode === 'calendar' && rule.calendar_period) {
    return formatCalendarPeriod(rule.calendar_period, t)
  }
  return formatUsageWindow(rule.window_seconds, t)
}

/** Window length as "5 hours" or "7 days"; whole days read as days. */
export function formatUsageWindow(seconds: number, t: TFunction): string {
  if (seconds > 0 && seconds % DAY_SECONDS === 0) {
    const days = seconds / DAY_SECONDS
    return days === 1 ? t('1 day') : t('{{count}} days', { count: days })
  }
  const hours = Math.round(seconds / HOUR_SECONDS)
  return hours === 1 ? t('1 hour') : t('{{count}} hours', { count: hours })
}
