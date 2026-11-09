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
import { useQuery } from '@tanstack/react-query'
import { Gauge } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Card, CardContent } from '@/components/ui/card'
import { IconBadge } from '@/components/ui/icon-badge'
import { UsageRuleProgress } from '@/components/usage-rule-progress'
import { formatUsageRuleWindow } from '@/lib/usage-limits'

import { getSelfLimits } from '../api'

/**
 * The usage limits and concurrency cap an administrator set for the current
 * user. Renders nothing for users without limits.
 */
export function UsageLimitsCard() {
  const { t } = useTranslation()
  // Optional information: a failed request hides the card instead of
  // interrupting the wallet page with an error.
  const { data } = useQuery({
    queryKey: ['self-limits'],
    queryFn: getSelfLimits,
    meta: { errorToast: false },
  })
  if (!data) return null
  const hasRules = data.usage_rules.length > 0
  if (!hasRules && data.max_concurrency <= 0) return null

  return (
    <Card data-card-hover='false' className='bg-muted/20 py-0'>
      <CardContent className='flex flex-col gap-4 p-3 sm:p-4'>
        <div className='flex min-w-0 items-center gap-2.5'>
          <IconBadge tone='warning'>
            <Gauge />
          </IconBadge>
          <div className='min-w-0'>
            <h3 className='truncate text-sm font-semibold'>
              {t('Usage Limits')}
            </h3>
            <p className='text-muted-foreground text-xs'>
              {t(
                'Limits set by the administrator for your account. A window starts with your first charged request and resets entirely when it ends.'
              )}
            </p>
          </div>
        </div>
        {hasRules && (
          <ul
            className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'
            aria-label={t('Usage limit rules')}
          >
            {data.usage_rules.map((rule) => (
              <li
                key={rule.window_seconds}
                className='flex min-w-0 flex-col gap-2 rounded-lg border p-3'
              >
                <span className='text-sm font-medium'>
                  {formatUsageRuleWindow(rule, t)}
                </span>
                <p className='text-muted-foreground text-xs break-words'>
                  {rule.models?.length
                    ? rule.models.join(', ')
                    : t('All models')}
                </p>
                <UsageRuleProgress rule={rule} />
              </li>
            ))}
          </ul>
        )}
        {data.max_concurrency > 0 && (
          <p className='text-sm'>
            {t('Concurrent requests: {{current}} / {{max}}', {
              current: data.current_concurrency,
              max: data.max_concurrency,
            })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
