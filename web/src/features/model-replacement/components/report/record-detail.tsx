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
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { toIntlLocale } from '@/i18n/languages'
import {
  formatNumber,
  formatPercent,
  formatTimestampToDate,
} from '@/lib/format'
import { requireServerSuccess } from '@/lib/server-error-message'
import { cn } from '@/lib/utils'

import {
  getModelReplacementAttempts,
  modelReplacementQueryKeys,
} from '../../api'
import { describeAction } from '../../lib/actions'
import { formatTimeRange } from '../../lib/report'
import type { DetectionAttempt } from '../../types'
import { VerdictBadge } from './badges'

type RecordDetailProps = {
  recordId: number
  onClose: () => void
}

export function RecordDetail(props: RecordDetailProps) {
  const { t } = useTranslation()
  const attemptsQuery = useQuery({
    queryKey: modelReplacementQueryKeys.attempts(props.recordId),
    queryFn: async () =>
      requireServerSuccess(await getModelReplacementAttempts(props.recordId))
        .data ?? null,
  })
  const data = attemptsQuery.data

  return (
    <aside
      aria-label={t('Detection details')}
      className='bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-4'
    >
      <div className='flex items-start justify-between gap-2'>
        <div className='min-w-0 space-y-0.5'>
          <h4 className='text-sm font-semibold'>{t('Detection details')}</h4>
          {data && (
            <p className='text-muted-foreground text-xs tabular-nums'>
              {formatTimeRange(data.record.started_at, data.record.finished_at)}
            </p>
          )}
        </div>
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          aria-label={t('Close details')}
          onClick={props.onClose}
        >
          <X aria-hidden='true' />
        </Button>
      </div>

      {attemptsQuery.isLoading && <LoadingState />}
      {attemptsQuery.isError && (
        <ErrorState
          title={t('We could not load the detection details.')}
          onRetry={() => void attemptsQuery.refetch()}
        />
      )}
      {data && (
        <>
          <div className='flex flex-wrap items-center gap-2'>
            <VerdictBadge verdict={data.record.verdict} />
            {data.record.models.map((stat) => (
              <span
                key={stat.model}
                className='bg-muted rounded px-1.5 py-0.5 font-mono text-xs tabular-nums'
              >
                {stat.model} · {formatPercent(stat.match_percent)}
              </span>
            ))}
          </div>
          {data.record.error_message && (
            <p className='text-destructive text-xs'>
              {data.record.error_message}
            </p>
          )}
          {data.record.actions.length > 0 && (
            <div className='space-y-1'>
              <div className='text-muted-foreground text-xs'>
                {t('Actions applied')}
              </div>
              <ol className='flex flex-col gap-1 text-xs'>
                {data.record.actions.map((action, index) => (
                  <li
                    // Applied actions have no identity besides their position.
                    // eslint-disable-next-line react/no-array-index-key
                    key={index}
                    className={cn(!action.changed && 'text-muted-foreground')}
                  >
                    {index + 1}. {describeAction(action, t)}
                    {!action.changed && ` (${t('no change')})`}
                  </li>
                ))}
              </ol>
            </div>
          )}
          <ul className='flex max-h-[28rem] flex-col gap-2 overflow-y-auto'>
            {data.attempts.map((attempt) => (
              <AttemptItem key={attempt.id} attempt={attempt} />
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}

function AttemptItem(props: { attempt: DetectionAttempt }) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const attempt = props.attempt

  let resultLabel = t('Request failed')
  let resultVariant: 'success' | 'danger' | 'warning' = 'warning'
  if (attempt.success && attempt.matched) {
    resultLabel = t('Answer matched')
    resultVariant = 'success'
  } else if (attempt.success) {
    resultLabel = t('Answer mismatched')
    if (
      attempt.error_message ===
      'The response model does not exactly match the test model.'
    ) {
      resultLabel = t('Response model mismatched')
    }
    resultVariant = 'danger'
  }

  return (
    <li className='flex min-w-0 flex-col gap-1.5 rounded-md border p-2.5 text-xs'>
      <div className='flex flex-wrap items-center justify-between gap-1.5'>
        <span className='min-w-0 truncate font-mono font-medium'>
          {attempt.model}
        </span>
        <StatusBadge
          label={resultLabel}
          variant={resultVariant}
          size='sm'
          copyable={false}
        />
      </div>
      <dl className='text-muted-foreground grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums'>
        <dt>{t('Round')}</dt>
        <dd className='text-foreground text-right'>{attempt.round}</dd>
        <dt>{t('Time')}</dt>
        <dd className='text-foreground text-right'>
          {formatTimestampToDate(attempt.tested_at)}
        </dd>
        <dt>{t('Response time')}</dt>
        <dd className='text-foreground text-right'>
          {formatNumber(attempt.latency_ms, locale)} ms
        </dd>
        <dt>{t('Tries')}</dt>
        <dd className='text-foreground text-right'>{attempt.tries}</dd>
      </dl>
      {attempt.success && attempt.error_message && (
        <p className='text-destructive break-words'>
          {t(attempt.error_message)}
        </p>
      )}
      <div className='space-y-0.5'>
        <div className='text-muted-foreground'>
          {attempt.success ? t('Returned answer') : t('Error')}
        </div>
        <p
          className={cn(
            'bg-muted/50 max-h-32 overflow-y-auto rounded px-2 py-1 break-words whitespace-pre-wrap',
            !attempt.success && 'text-destructive'
          )}
        >
          {attempt.success ? attempt.answer : attempt.error_message}
        </p>
      </div>
    </li>
  )
}
