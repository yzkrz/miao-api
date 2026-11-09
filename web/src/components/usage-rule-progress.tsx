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
import { useTranslation } from 'react-i18next'

import { StatusBadge, type StatusVariant } from '@/components/status-badge'
import { Progress } from '@/components/ui/progress'
import { formatQuota, formatTimestampToDate } from '@/lib/format'
import type { UsageRuleStatus, UsageWindowStatus } from '@/lib/usage-limits'
import { cn } from '@/lib/utils'
import { useSystemConfigStore } from '@/stores/system-config-store'

const WINDOW_STATUS_BADGES: Record<
  UsageWindowStatus,
  { labelKey: string; variant: StatusVariant }
> = {
  idle: { labelKey: 'Not started', variant: 'neutral' },
  active: { labelKey: 'In progress', variant: 'success' },
  exhausted: { labelKey: 'Exhausted', variant: 'danger' },
}

interface UsageRuleProgressProps {
  rule: UsageRuleStatus
  className?: string
}

/**
 * Current window of one usage limit rule: its state, the quota used against
 * the limit, and when the window resets.
 */
export function UsageRuleProgress(props: UsageRuleProgressProps) {
  useSystemConfigStore((state) => state.config.currency)
  const { t } = useTranslation()
  const badge = WINDOW_STATUS_BADGES[props.rule.status]
  const percent =
    props.rule.quota_limit > 0
      ? Math.min(
          100,
          Math.round((props.rule.used_quota / props.rule.quota_limit) * 100)
        )
      : 0

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', props.className)}>
      <div className='flex items-center justify-between gap-2 text-xs'>
        <StatusBadge
          label={t(badge.labelKey)}
          variant={badge.variant}
          copyable={false}
        />
        <span className='tabular-nums'>
          {formatQuota(props.rule.used_quota)} /{' '}
          {formatQuota(props.rule.quota_limit)}
        </span>
      </div>
      <Progress
        value={percent}
        aria-label={t('Usage limit used: {{percent}}%', { percent })}
      />
      <p className='text-muted-foreground text-xs'>
        {props.rule.status === 'idle' && props.rule.mode !== 'calendar'
          ? t('Starts with the next charged request')
          : t('Resets at {{time}}', {
              time: formatTimestampToDate(props.rule.reset_at),
            })}
      </p>
    </div>
  )
}
